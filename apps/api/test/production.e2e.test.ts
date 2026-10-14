/**
 * Phase 9 production hardening: shared rate limits, key rotation of stored
 * secrets, external audit anchors, install checks (doctor) and readiness.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desc, eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisThrottlerStorage } from '../src/common/redis-throttler';
import { SecretBox } from '../src/common/secret-box';
import { SECRET_COLUMNS, auditSecrets } from '../src/common/secret-registry';
import { heads, readAnchors, verifyAnchors } from '../src/cli/audit-anchor';
import { configChecks, runtimeChecks } from '../src/common/doctor';
import { loadConfig } from '../src/config/config';
import { auditEvents, deviceCredentials } from '../src/db/schema';
import { WORKER_HEARTBEAT_KEY } from '../src/health/worker-heartbeat';
import { assertDeviceHost, parseAllowList } from '../src/worker/device-allow';
import { defaultAdapters } from '../src/worker/processor';
import { Client, setupTestApp, TEST_DATABASE_URL, type TestContext } from './helpers';

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
let ctx: TestContext;
let admin: Client;
const redises: Redis[] = [];
const redis = () => {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  r.on('error', () => undefined);
  redises.push(r);
  return r;
};

beforeAll(async () => {
  ctx = await setupTestApp({ CDCIM_ENCRYPTION_KEYS: `old1:${k1}` });
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
});
afterAll(async () => {
  for (const r of redises) r.disconnect();
  await ctx?.close();
});

describe('rate limits shared through Redis', () => {
  it('two API processes count against one budget, and block past the limit', async () => {
    const prefix = `cdcim:throttle:t-${randomBytes(4).toString('hex')}:`;
    const a = new RedisThrottlerStorage(redis(), prefix);
    const b = new RedisThrottlerStorage(redis(), prefix);
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push(await a.increment('ip-1', 60_000, 5, 60_000, 'login'));
    for (let i = 0; i < 3; i++) hits.push(await b.increment('ip-1', 60_000, 5, 60_000, 'login'));
    expect(hits.map((h) => h.totalHits)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hits[4]!.isBlocked).toBe(false);
    expect(hits[5]!.isBlocked).toBe(true);
    expect(hits[5]!.timeToBlockExpire).toBeGreaterThan(50);
    // Other clients are not affected.
    expect((await a.increment('ip-2', 60_000, 5, 60_000, 'login')).isBlocked).toBe(false);
  });

  it('when Redis is down the limit still applies, per process', async () => {
    const down = new Redis('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
    down.on('error', () => undefined);
    redises.push(down);
    const s = new RedisThrottlerStorage(down, 'x:');
    const res = [];
    for (let i = 0; i < 4; i++) res.push(await s.increment('ip', 60_000, 3, 60_000, 'login'));
    expect(res.map((r) => r.isBlocked)).toEqual([false, false, false, true]);
  });

  it('the API keeps its counters in Redis', async () => {
    const r = redis();
    await r.connect();
    await request(ctx.server).post('/api/v1/auth/login').send({ email: 'nobody@example.com', password: 'x'.repeat(12) });
    expect((await r.keys('cdcim:throttle:test-*:hits')).length).toBeGreaterThan(0);
  });
});

describe('stored secrets and key rotation', () => {
  it('every encrypted column in the schema is covered by rotation and the install check', () => {
    const schema = readFileSync(join(__dirname, '../src/db/schema.ts'), 'utf8');
    const encrypted = [...schema.matchAll(/text\('(\w+_enc)'\)/g)].map((m) => m[1]);
    const covered = SECRET_COLUMNS.map((c) => c.column.name);
    expect(encrypted.length).toBeGreaterThanOrEqual(10);
    for (const col of encrypted) expect(covered).toContain(col);
    expect(SECRET_COLUMNS.length).toBe(encrypted.length);
  });

  it('rotates every secret to the new key without printing or losing any', async () => {
    const m = (await ctx.db.execute(sql`select id from device_models limit 1`)).rows[0] as { id: string } | undefined;
    const mf = m ? null : (await admin.post('/api/v1/dcim/manufacturers', { name: 'Rot Inc' })).body.id;
    const modelId = m?.id ?? (await admin.post('/api/v1/dcim/models', { manufacturerId: mf, name: 'Rot 1U', category: 'server', uHeight: 1, depthMm: 700, fullDepth: true })).body.id;
    const dev = (await admin.post('/api/v1/dcim/devices', { modelId, assetTag: 'ROT-1', initialState: 'inventory' })).body.id as string;
    expect((await admin.put(`/api/v1/network/devices/${dev}/credentials`, { kind: 'redfish', host: '10.9.9.9', username: 'root', password: 'rotate-me-123' })).status).toBe(200);
    expect((await admin.post('/api/v1/alerts/channels', { kind: 'webhook', name: 'Rot hook', url: 'https://hooks.example.net/x', signingSecret: 'rotate-hook-secret' })).status).toBe(201);

    const oldOnly = new SecretBox([{ id: 'old1', key: Buffer.from(k1, 'base64') }]);
    const both = new SecretBox([
      { id: 'new2', key: Buffer.from(k2, 'base64') },
      { id: 'old1', key: Buffer.from(k1, 'base64') },
    ]);
    const before = await auditSecrets(ctx.db, oldOnly, { apply: false });
    const n = before.reduce((a, r) => a + r.total, 0);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(before.every((r) => r.unreadable === 0)).toBe(true);

    const rotated = await auditSecrets(ctx.db, both, { apply: true });
    expect(rotated.reduce((a, r) => a + r.rotated, 0)).toBe(n);
    // Now only the new key is needed.
    const newOnly = new SecretBox([{ id: 'new2', key: Buffer.from(k2, 'base64') }]);
    const after = await auditSecrets(ctx.db, newOnly, { apply: false });
    expect(after.reduce((a, r) => a + r.unreadable, 0)).toBe(0);
    expect(after.every((r) => Object.keys(r.byKey).every((k) => k === 'new2'))).toBe(true);
    const [cred] = await ctx.db.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, dev));
    expect(JSON.parse(newOnly.decrypt(cred!.secretEnc, `device_credential:${ctx.org.id}:${dev}:redfish:10.9.9.9:`)).password).toBe('rotate-me-123');

    // A row changed outside the application no longer decrypts and is reported.
    await ctx.db.update(deviceCredentials).set({ host: '10.6.6.6' }).where(eq(deviceCredentials.deviceId, dev));
    const tampered = await auditSecrets(ctx.db, newOnly, { apply: false });
    expect(tampered.find((r) => r.name === 'device_credentials')!.unreadable).toBe(1);
    await ctx.db.update(deviceCredentials).set({ host: '10.9.9.9' }).where(eq(deviceCredentials.deviceId, dev));
  });
});

describe('device network allow-list', () => {
  it('refuses credentials pointed outside the management networks, before connecting', async () => {
    const list = parseAllowList('10.10.0.0/16, 163.5.191.0/24, fd00::/8');
    await expect(assertDeviceHost('163.5.191.7', list)).resolves.toBeUndefined();
    await expect(assertDeviceHost('[fd00::5]', list)).resolves.toBeUndefined();
    await expect(assertDeviceHost('169.254.169.254', list)).rejects.toThrow(/outside the networks/);
    await expect(assertDeviceHost('127.0.0.1', list)).rejects.toThrow(/CDCIM_DEVICE_ALLOW/);
    await expect(assertDeviceHost('localhost', list)).rejects.toThrow(/outside/);
    await expect(assertDeviceHost('anything', null)).resolves.toBeUndefined();
    expect(() => parseAllowList('10.0.0.0/33')).toThrow(/not an address/);
    expect(parseAllowList('')).toBeNull();
  });

  it('applies to every adapter the worker uses', async () => {
    process.env.CDCIM_DEVICE_ALLOW = '10.10.0.0/16';
    try {
      const a = defaultAdapters();
      for (const kind of ['snmp_v2c', 'redfish', 'ipmi', 'routeros_rest'] as const) {
        await expect(a[kind].test({ host: '192.0.2.10', port: null, username: 'x', params: {}, secret: { password: 'x' } } as never)).rejects.toThrow(/outside the networks/);
      }
    } finally {
      delete process.env.CDCIM_DEVICE_ALLOW;
    }
  });
});

describe('install check (doctor)', () => {
  const env = (extra: Record<string, string> = {}) => ({ NODE_ENV: 'production', DATABASE_URL: TEST_DATABASE_URL, REDIS_URL, CDCIM_ENCRYPTION_KEYS: `new2:${k2},old1:${k1}`, HOST: '127.0.0.1', ...extra });

  it('reports configuration problems with a fix', () => {
    const bad = configChecks({ ...env(), CDCIM_ENCRYPTION_KEYS: 'nope' });
    expect(bad.config).toBeNull();
    expect(bad.results[0]).toMatchObject({ status: 'FAIL', name: 'Configuration is valid' });
    const lab = configChecks(env({ HOST: '0.0.0.0', COOKIE_SECURE: 'false', ALLOW_INSECURE_HTTP: 'true', REDIS_URL: 'redis://10.0.0.9:6379' }));
    const by = (n: string) => lab.results.find((r) => r.name === n)!;
    expect(by('Sign-in over HTTPS only').status).toBe('WARN');
    expect(by('Listen address').status).toBe('WARN');
    expect(by('Redis access').status).toBe('WARN');
    expect(configChecks(env({ CDCIM_DEVICE_ALLOW: '10.0.0.0/8' })).results.every((r) => r.status === 'PASS')).toBe(true);
    expect(configChecks(env()).results.find((r) => r.name === 'Device networks')!.status).toBe('WARN');
    expect(configChecks(env({ CDCIM_DEVICE_ALLOW: 'bogus' })).results.find((r) => r.name === 'Device networks')!.status).toBe('FAIL');
  });

  it('checks database, migrations, worker, secrets, audit log, MFA and backups', async () => {
    const config = loadConfig(env());
    const r = redis();
    await r.connect();
    await r.del(WORKER_HEARTBEAT_KEY);
    const backups = mkdtempSync(join(tmpdir(), 'cdcim-bk-'));
    let res = await runtimeChecks(ctx.db, r, config, { backupDir: backups });
    const by = (n: string) => res.find((x) => x.name === n)!;
    expect(by('PostgreSQL reachable').status).toBe('PASS');
    expect(by('Migrations applied').status).toBe('PASS');
    expect(by('Redis reachable').status).toBe('PASS');
    expect(by('Worker running')).toMatchObject({ status: 'FAIL' });
    expect(by('Stored secrets readable').status).toBe('PASS');
    expect(by('Audit log intact').status).toBe('PASS');
    expect(by('Staff use two-factor sign-in').status).toBe('WARN');
    expect(by('Recent backup').status).toBe('WARN');

    await r.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), pid: 1 }), 'EX', 60);
    const f = join(backups, 'x.cdcim-backup');
    writeFileSync(f, 'x');
    res = await runtimeChecks(ctx.db, r, config, { backupDir: backups });
    expect(by('Worker running').status).toBe('PASS');
    expect(by('Recent backup').status).toBe('PASS');
    utimesSync(f, new Date(Date.now() - 50 * 3_600_000), new Date(Date.now() - 50 * 3_600_000));
    res = await runtimeChecks(ctx.db, r, config, { backupDir: backups });
    expect(by('Recent backup').status).toBe('WARN');

    // A key missing from the ring makes secrets unreadable: a failure.
    res = await runtimeChecks(ctx.db, r, loadConfig(env({ CDCIM_ENCRYPTION_KEYS: `zz:${randomBytes(32).toString('base64')}` })), {});
    expect(by('Stored secrets readable').status).toBe('FAIL');
  });

  it('readiness reports whether the worker is running', async () => {
    const r = redis();
    await r.connect();
    await r.set(WORKER_HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), pid: 1 }), 'EX', 60);
    expect((await request(ctx.server).get('/api/v1/health/ready')).body).toMatchObject({ status: 'ok', worker: 'running' });
    await r.del(WORKER_HEARTBEAT_KEY);
    expect((await request(ctx.server).get('/api/v1/health/ready')).body).toMatchObject({ status: 'ok', worker: 'not_seen' });
  });
});

// Last: these tests change the audit log the way an attacker with database access could.
describe('external audit anchors', () => {
  it('detect removal of the newest events and rewritten history, which the hash chain alone cannot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdcim-anchor-'));
    const file = join(dir, 'anchors.jsonl');
    await admin.post('/api/v1/dcim/manufacturers', { name: 'Anchor Co 1' });
    for (const h of await heads(ctx.db)) writeFileSync(file, `${JSON.stringify(h)}\n`, { flag: 'a' });
    const anchors = readAnchors(file);
    expect(anchors.length).toBeGreaterThan(0);
    let checks = await verifyAnchors(ctx.db, anchors);
    expect(checks.every((c) => c.problems.length === 0 && c.chain.ok)).toBe(true);

    // Remove the newest events (triggers off, as a database owner could). The chain still verifies.
    const anchored = anchors.find((a) => a.orgId === ctx.org.id)!;
    await ctx.db.execute(sql`alter table audit_events disable trigger user`);
    try {
      await ctx.db.delete(auditEvents).where(sql`${auditEvents.orgId} = ${ctx.org.id} and ${auditEvents.id} >= ${anchored.id}`);
    } finally {
      await ctx.db.execute(sql`alter table audit_events enable trigger user`);
    }
    checks = await verifyAnchors(ctx.db, anchors);
    const mine = checks.find((c) => c.orgId === ctx.org.id)!;
    expect(mine.chain.ok).toBe(true);
    expect(mine.problems.join()).toMatch(/missing \(newest events were removed\)/);

    // A forged newest event with a different hash at the same id.
    const [last] = await ctx.db.select().from(auditEvents).where(eq(auditEvents.orgId, ctx.org.id)).orderBy(desc(auditEvents.id)).limit(1);
    const forged = { ...anchored, id: last!.id, hash: 'f'.repeat(64) };
    checks = await verifyAnchors(ctx.db, [forged]);
    expect(checks.find((c) => c.orgId === ctx.org.id)!.problems.join()).toMatch(/different hash/);
    expect(readFileSync(file, 'utf8')).not.toMatch(/password|secret/i);
  });
});
