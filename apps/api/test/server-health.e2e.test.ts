/**
 * A server's current health from its BMC every 5 minutes (simulated iDRACs:
 * Redfish with Dell rollups, and old firmware answering only WS-Man), and
 * how the Health page shows it.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverHealth } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { pollDueServerHealth } from '../src/worker/hardware/server-health';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startRedfish, type MockRedfish } from './simulators/power-devices';

let ctx: TestContext;
let admin: Client;
let modern: MockRedfish;
let old: MockRedfish;
const ids: Record<string, string> = {};
const D = '/api/v1/dcim';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const deps = () => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201, 204].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  modern = await startRedfish('root', 'bmc-pass-123');
  old = await startRedfish('root', 'old-pass-456', { brokenRedfish: true, watts: 180 });
  const m = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell SH' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: m, name: 'R650 SH', category: 'server', uHeight: 1, depthMm: 750, fullDepth: true }))).id;
  for (const tag of ['SH-MODERN', 'SH-OLD', 'SH-WRONG', 'SH-STOCK']) ids[tag] = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: tag, hostname: tag.toLowerCase(), initialState: 'inventory' }))).id;
  await ctx.db.execute(sql`update devices set lifecycle_state = 'active' where id in (${ids['SH-MODERN']}, ${ids['SH-OLD']}, ${ids['SH-WRONG']})`);
  const cred = (id: string, port: number, password: string) => ok(admin.put(`/api/v1/network/devices/${id}/credentials`, { kind: 'redfish', host: '127.0.0.1', port, username: 'root', password, scheme: 'http' }));
  await cred(ids['SH-MODERN']!, modern.port, 'bmc-pass-123');
  await cred(ids['SH-OLD']!, old.port, 'old-pass-456');
  await cred(ids['SH-WRONG']!, modern.port, 'not-the-password');
  await cred(ids['SH-STOCK']!, modern.port, 'bmc-pass-123');
  // The daily hardware walk is not part of this test.
  await ctx.db.execute(
    sql`insert into device_hardware (device_id, org_id, status, next_at) select id, org_id, 'idle', now() + interval '1 day' from devices where id in (${ids['SH-MODERN']}, ${ids['SH-OLD']}, ${ids['SH-WRONG']}, ${ids['SH-STOCK']}) on conflict (device_id) do update set next_at = excluded.next_at`,
  );
});
afterAll(async () => {
  await modern?.close();
  await old?.close();
  await ctx?.close();
});

describe('server health from the BMC', () => {
  it('reads servers in service with GET (and WS-Man enumerate) only, then waits 5 minutes', async () => {
    expect(await pollDueServerHealth(deps())).toBe(3);
    expect(modern.requests.filter((r) => r.url?.startsWith('/redfish')).every((r) => r.method === 'GET')).toBe(true);
    const row = async (tag: string) => (await ctx.db.select().from(serverHealth).where(eq(serverHealth.deviceId, ids[tag]!)))[0];
    const a = await row('SH-MODERN');
    expect(a).toMatchObject({ status: 'idle', lastError: null });
    expect(a!.data).toMatchObject({ powerState: 'On', rollup: { system: 'Warning', cpu: 'OK', memory: 'Warning', psu: 'Critical', fans: 'OK' }, inletC: 23, cpuTempC: 54, cpuUsagePct: null });
    const b = await row('SH-OLD');
    expect(b!.data).toMatchObject({ source: 'WS-Man', rollup: { system: 'Warning', cpu: 'OK', fans: 'Warning' }, cpuUsagePct: 37, memoryUsagePct: 12, ioUsagePct: 4, inletC: 23, cpuTempC: 61 });
    expect(b!.data!.rollup.voltage).toBeUndefined();
    const c = await row('SH-WRONG');
    expect(c!.data).toBeNull();
    expect(c!.lastError).toBeTruthy();
    expect(c!.lastError).not.toContain('not-the-password');
    expect(await row('SH-STOCK')).toBeUndefined();
    expect(await pollDueServerHealth(deps())).toBe(0);
  });

  it('shows on the Health page: component rollups, usage and temperatures as reasons', async () => {
    const r = await ok(admin.get('/api/v1/monitoring/fleet-health'));
    const by = Object.fromEntries(r.items.map((x: { name: string }) => [x.name, x]));
    expect(by['sh-modern']).toMatchObject({ status: 'critical', bmc: { fresh: true, rollup: { psu: 'Critical' }, inletC: 23 } });
    expect(by['sh-modern'].reasons.map((x: { text: string }) => x.text)).toEqual(['PSU: Critical (BMC)', 'Memory: Warning (BMC)']);
    expect(by['sh-old']).toMatchObject({ status: 'warning', bmc: { cpuUsagePct: 37, source: 'WS-Man' } });
    expect(by['sh-old'].reasons.map((x: { text: string }) => x.text)).toEqual(['Fans: Warning (BMC)']);
    expect(by['sh-wrong']).toMatchObject({ status: 'warning', bmc: { fresh: false } });
    expect(by['sh-wrong'].reasons[0].text).toMatch(/^BMC health read failed/);
    // Stale readings are not trusted.
    await ctx.db.execute(sql`update server_health set at = now() - interval '1 hour' where device_id = ${ids['SH-MODERN']}`);
    const s = (await ok(admin.get('/api/v1/monitoring/fleet-health'))).items.find((x: { name: string }) => x.name === 'sh-modern');
    expect(s.bmc.fresh).toBe(false);
    expect(s.reasons).toEqual([]);
  });
});
