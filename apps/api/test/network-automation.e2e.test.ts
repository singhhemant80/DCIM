/**
 * Phase 3 completion: RouterOS API collector, scheduled discovery with change
 * detection, and recording discovered addresses in IPAM.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceCredentials, discoveryRuns, roles, userRoles, users } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { PasswordService } from '../src/auth/password.service';
import { DiscoveryService } from '../src/network/discovery/discovery.service';
import { processRun } from '../src/worker/processor';
import { runDueSchedules } from '../src/worker/scheduler';
import { decodeLength, decodeSentences, encodeLength, encodeSentence, routerOsApiAdapter } from '../src/worker/adapters/routeros-api';
import type { Adapter, DiscoveryResult } from '../src/network/discovery/types';
import { Client, PASSWORD, setupTestApp, type TestContext } from './helpers';
import { startRouterOsApi, type MockApi } from './simulators/routeros-api';

let ctx: TestContext;
let admin: Client;
let ros: MockApi;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const D = '/api/v1/dcim';
const N = '/api/v1/network';

async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

let script: Partial<DiscoveryResult> = {};
const fake: Adapter = {
  test: async () => ({ ok: true, message: 'ok', latencyMs: 1 }),
  discover: async () => ({ source: 'snmp_v2c', collectedAt: new Date().toISOString(), facts: {}, interfaces: [], neighbors: [], bgp: [], warnings: [], ...script }),
};
const worker = () => {
  const discovery = new DiscoveryService(ctx.db, null as never, null as never, null as never);
  return {
    db: ctx.db,
    secrets: ctx.app.get(SecretBox),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    adapters: { snmp_v2c: fake },
    changes: (orgId: string, deviceId: string, r: DiscoveryResult) => discovery.changeSummary(ctx.db, orgId, deviceId, r),
  };
};

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  ros = await startRouterOsApi('dcim-ro', 'api-pass-123');
  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'MikroTik' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'CCR2004', category: 'router', uHeight: 1, fullDepth: false }))).id;
  ids.r1 = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'R1', hostname: 'edge-r1', mgmtAddress: '127.0.0.1', initialState: 'inventory' }))).id;
  ids.r2 = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'R2', hostname: 'edge-r2', mgmtAddress: '127.0.0.1', initialState: 'inventory' }))).id;
});
afterAll(async () => {
  await ros?.close();
  await ctx?.close();
});

describe('RouterOS API protocol', () => {
  it('encodes and decodes word lengths at every size boundary', () => {
    for (const n of [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0x1fffff, 0x200000, 0xfffffff, 0x10000000]) {
      const e = encodeLength(n);
      expect(decodeLength(Buffer.concat([e, Buffer.alloc(4)]), 0)).toEqual({ len: n, size: e.length });
    }
  });

  it('reassembles sentences split across TCP packets', () => {
    const whole = Buffer.concat([encodeSentence(['!re', '=name=ether1', `=comment=${'x'.repeat(300)}`]), encodeSentence(['!done'])]);
    const first = decodeSentences(whole.subarray(0, 7));
    expect(first.sentences).toEqual([]);
    const all = decodeSentences(Buffer.concat([first.rest, whole.subarray(7)]));
    expect(all.sentences.map((s) => s[0])).toEqual(['!re', '!done']);
    expect(all.rest.length).toBe(0);
  });

  it('collects interfaces, bonding, addresses, neighbors and BGP with print commands only', async () => {
    const t = { host: '127.0.0.1', port: ros.port, username: 'dcim-ro', params: { tls: false, timeoutMs: 2000 }, secret: { password: 'api-pass-123' } };
    const test = await routerOsApiAdapter().test(t);
    expect(test.message).toMatch(/edge-r1 — CCR2004-1G-12S\+2XS RouterOS 7\.14\.2/);
    const r = await routerOsApiAdapter().discover(t);
    expect(r.source).toBe('routeros_api');
    expect(r.facts.serial).toBe('HD5087ABC12');
    expect(r.interfaces.find((i) => i.name === 'sfp-sfpplus1')!.lagName).toBe('bond1');
    expect(r.interfaces.find((i) => i.name === 'vlan100')!.addresses).toEqual(['10.20.0.1/24', '2001:db8:100::1/64']);
    expect(r.neighbors[0]).toMatchObject({ localInterface: 'ether1', remoteSystemName: 'core-r2', protocol: 'lldp' });
    expect(r.bgp[0]).toMatchObject({ peer: '203.0.113.1', remoteAs: 64500, state: 'established', prefixesReceived: 950000 });
    const cmds = ros.commands.map((c) => c[0]);
    expect(cmds.every((c) => c === '/login' || /\/print$/.test(c!))).toBe(true);
    expect(JSON.stringify(ros.commands)).not.toContain('api-pass-123');
  });

  it('reports a wrong password as an authentication failure', async () => {
    const t = { host: '127.0.0.1', port: ros.port, username: 'dcim-ro', params: { tls: false, timeoutMs: 2000 }, secret: { password: 'wrong-pass' } };
    await expect(routerOsApiAdapter().test(t)).rejects.toThrow(/Authentication failed/);
  });

  it('runs through the worker with a stored credential', async () => {
    await ok(admin.put(`${N}/devices/${ids.r1}/credentials`, { kind: 'routeros_api', port: ros.port, username: 'dcim-ro', password: 'api-pass-123', tls: false }));
    const run = await ok(admin.post(`${N}/devices/${ids.r1}/discovery`, { kind: 'routeros_api', mode: 'discover' }));
    await processRun({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }, run.id);
    const r = await ok(admin.get(`${N}/discovery/${run.id}`));
    expect(r.status).toBe('succeeded');
    expect(r.preview.counts.create).toBeGreaterThan(3);
  });
});

describe('scheduled discovery', () => {
  it('starts due runs once, moves the next run forward and records differences', async () => {
    await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.r2, pattern: 'ether[1-2]' }));
    await ok(admin.put(`${N}/devices/${ids.r2}/credentials`, { kind: 'snmp_v2c', community: 'sched-community' }));
    const cred = await ok(admin.put(`${N}/devices/${ids.r2}/credentials/snmp_v2c/schedule`, { hours: 6 }));
    expect(cred.scheduleHours).toBe(6);
    expect((await admin.put(`${N}/devices/${ids.r2}/credentials/snmp_v2c/schedule`, { hours: 0 })).status).toBe(400);

    const queued: string[] = [];
    const first = await runDueSchedules(ctx.db, async (id) => void queued.push(id));
    expect(first).toHaveLength(1);
    expect(queued).toEqual(first);
    // Not due any more: a second tick (or a second worker) starts nothing.
    expect(await runDueSchedules(ctx.db, async () => undefined)).toHaveLength(0);
    const [c] = await ctx.db.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, ids.r2));
    expect(c!.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 5.9 * 3600_000);

    script = { interfaces: [{ name: 'ether1', kind: 'physical', mtu: 9000 }, { name: 'ether3', kind: 'physical' }], neighbors: [] };
    await processRun(worker(), first[0]!);
    const [run] = await ctx.db.select().from(discoveryRuns).where(eq(discoveryRuns.id, first[0]!));
    expect(run!.trigger).toBe('schedule');
    expect(run!.changes).toMatchObject({ create: 1, update: 1, missing: 1, total: 3 });
    // Nothing was applied automatically.
    const ports = await ok<any[]>(admin.get(`${N}/devices/${ids.r2}/interfaces`));
    expect(ports.map((p) => p.name).sort()).toEqual(['ether1', 'ether2']);
    const list = await ok<any[]>(admin.get(`${N}/devices`));
    expect(list.find((d) => d.id === ids.r2).pendingChanges).toMatchObject({ runId: first[0], total: 3 });
  });

  it('a device with an active run is skipped, not double-started', async () => {
    await ctx.db.execute(sql`update device_credentials set next_run_at = now() - interval '1 minute' where device_id = ${ids.r2}`);
    await ctx.db.insert(discoveryRuns).values({ orgId: ctx.org.id, deviceId: ids.r2, credentialKind: 'snmp_v2c', mode: 'test', status: 'running' });
    expect(await runDueSchedules(ctx.db, async () => undefined)).toHaveLength(0);
    await ctx.db.execute(sql`update discovery_runs set status = 'failed' where device_id = ${ids.r2} and status = 'running'`);
  });

  it('turning the schedule off stops it', async () => {
    await ok(admin.put(`${N}/devices/${ids.r2}/credentials/snmp_v2c/schedule`, { hours: null }));
    await ctx.db.execute(sql`update device_credentials set next_run_at = now() - interval '1 minute' where device_id = ${ids.r2}`);
    expect(await runDueSchedules(ctx.db, async () => undefined)).toHaveLength(0);
  });
});

describe('recording discovered addresses in IPAM', () => {
  it('records selected addresses, bound to their interface, and reports the rest', async () => {
    await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '10.20.0.0/24' }));
    // 10.30.0.5 belongs to another device already.
    await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '10.30.0.0/24' }));
    await ok(admin.post('/api/v1/ipam/addresses', { address: '10.30.0.5', deviceId: ids.r1 }));
    script = {
      interfaces: [
        { name: 'ether1', kind: 'physical', addresses: ['10.20.0.1/24', '10.30.0.5/24'] },
        { name: 'ether2', kind: 'physical', addresses: ['198.51.100.2/30'] },
      ],
      neighbors: [],
    };
    const run = await ok(admin.post(`${N}/devices/${ids.r2}/discovery`, { kind: 'snmp_v2c', mode: 'discover' }));
    await processRun(worker(), run.id);
    const pv = (await ok(admin.get(`${N}/discovery/${run.id}`))).preview;
    expect(pv.addresses.map((a: any) => `${a.address}:${a.status}`)).toEqual(['10.20.0.1/24:not_in_ipam', '10.30.0.5/24:other_device', '198.51.100.2/30:no_prefix']);

    const res = await ok(
      admin.post(`${N}/discovery/${run.id}/apply`, {
        interfaces: [],
        importNeighbors: false,
        addresses: [
          { interface: 'ether1', address: '10.20.0.1/24' },
          { interface: 'ether1', address: '10.30.0.5/24' },
          { interface: 'ether2', address: '198.51.100.2/30' },
          { interface: 'ether9', address: '192.0.2.1/24' },
        ],
      }),
    );
    expect(res.addresses).toBe(1);
    expect(res.warnings.join('\n')).toMatch(/10\.30\.0\.5\/24: recorded in IPAM for another device/);
    expect(res.warnings.join('\n')).toMatch(/198\.51\.100\.2\/30: no prefix in IPAM covers it/);
    expect(res.warnings.join('\n')).toMatch(/192\.0\.2\.1\/24: not part of this discovery/);
    const a = (await ok(admin.get('/api/v1/ipam/addresses?q=10.20.0.1'))).items[0];
    expect(a).toMatchObject({ deviceId: ids.r2, interfaceName: 'ether1', prefixLength: 24, status: 'allocated' });
    const other = (await ok(admin.get('/api/v1/ipam/addresses?q=10.30.0.5'))).items[0];
    expect(other.deviceId).toBe(ids.r1);
  });

  it('never re-assigns an address IPAM already has without a device', async () => {
    await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '10.40.0.0/24', customerId: ctx.customers.acme }));
    await ok(admin.post('/api/v1/ipam/addresses', { address: '10.40.0.9', status: 'reserved', customerId: ctx.customers.acme }));
    script = { interfaces: [{ name: 'ether1', kind: 'physical', addresses: ['10.40.0.9/24'] }], neighbors: [] };
    const run = await ok(admin.post(`${N}/devices/${ids.r2}/discovery`, { kind: 'snmp_v2c', mode: 'discover' }));
    await processRun(worker(), run.id);
    const res = await ok(admin.post(`${N}/discovery/${run.id}/apply`, { interfaces: [], importNeighbors: false, addresses: [{ interface: 'ether1', address: '10.40.0.9/24' }] }));
    expect(res.addresses).toBe(0);
    expect(res.warnings.join(' ')).toMatch(/already in IPAM \(reserved, no device\)/);
    const a = (await ok(admin.get('/api/v1/ipam/addresses?q=10.40.0.9'))).items[0];
    expect(a).toMatchObject({ status: 'reserved', deviceId: null, customerId: ctx.customers.acme });
  });

  it('matches addresses in canonical form', async () => {
    script = { interfaces: [{ name: 'ether1', kind: 'physical', addresses: ['2001:DB8:0:0::7/64'] }], neighbors: [] };
    await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '2001:db8::/64' }));
    const run = await ok(admin.post(`${N}/devices/${ids.r2}/discovery`, { kind: 'snmp_v2c', mode: 'discover' }));
    await processRun(worker(), run.id);
    const pv = (await ok(admin.get(`${N}/discovery/${run.id}`))).preview;
    const res = await ok(admin.post(`${N}/discovery/${run.id}/apply`, { interfaces: [], importNeighbors: false, addresses: [{ interface: 'ether1', address: pv.addresses[0].address }] }));
    expect(res.addresses).toBe(1);
  });

  it('can create the missing subnet when asked', async () => {
    script = {
      interfaces: [
        { name: 'ether1', kind: 'physical', addresses: ['10.20.0.1/24', '10.30.0.5/24'] },
        { name: 'ether2', kind: 'physical', addresses: ['198.51.100.2/30'] },
      ],
      neighbors: [],
    };
    const run = await ok(admin.post(`${N}/devices/${ids.r2}/discovery`, { kind: 'snmp_v2c', mode: 'discover' }));
    await processRun(worker(), run.id);
    const res = await ok(admin.post(`${N}/discovery/${run.id}/apply`, { interfaces: [], importNeighbors: false, addresses: [{ interface: 'ether2', address: '198.51.100.2/30' }], createPrefixes: true }));
    expect(res).toMatchObject({ addresses: 1, prefixesCreated: 1 });
    const pre = await ok<any[]>(admin.get('/api/v1/ipam/prefixes?q=198.51.100.0/30'));
    expect(pre.map((x) => x.prefix)).toContain('198.51.100.0/30');
  });

  it('needs the IPAM write permission', async () => {
    const [role] = await ctx.db.insert(roles).values({ orgId: ctx.org.id, name: 'Network only', scope: 'staff', permissions: ['network.read', 'network.write'] }).returning();
    const [u] = await ctx.db.insert(users).values({ orgId: ctx.org.id, email: 'netonly@test.example', name: 'Net Only', passwordHash: await new PasswordService().hash(PASSWORD), userType: 'staff' }).returning();
    await ctx.db.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
    const net = await Client.login(ctx.server, 'netonly@test.example');
    const run = await ok(admin.post(`${N}/devices/${ids.r2}/discovery`, { kind: 'snmp_v2c', mode: 'discover' }));
    await processRun(worker(), run.id);
    const denied = await net.post(`${N}/discovery/${run.id}/apply`, { interfaces: [], addresses: [{ interface: 'ether1', address: '10.20.0.1/24' }] });
    expect(denied.status).toBe(403);
    // Without addresses the same user can still apply.
    expect((await net.post(`${N}/discovery/${run.id}/apply`, { interfaces: [] })).status).toBe(201);
  });
});
