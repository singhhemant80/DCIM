/**
 * Phase 5: equipment power — collection from simulated BMCs (Redfish, IPMI
 * DCMI through a stand-in ipmitool), an APC metered-by-outlet PDU on a real
 * SNMP agent, switch/router power figures, source priority, hourly energy,
 * tariffs, totals and tenancy.
 */
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, devices, powerHourly, powerMonitoring, powerReadings } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { claimDuePower, pollDuePower, pollPowerDevice, type PowerPollerDeps } from '../src/worker/power/poller';
import { applyPowerRetention, rollupPower } from '../src/worker/power/rollup';
import { ipmiAdapter } from '../src/worker/adapters/ipmi';
import { routerOsAdapter } from '../src/worker/adapters/routeros';
import { nxApiAdapter } from '../src/worker/adapters/nxapi';
import { defaultAdapters } from '../src/worker/processor';
import { Client, setupTestApp, type TestContext } from './helpers';
import { DEFAULT_SIM, startSnmpAgent, type RunningAgent } from './simulators/snmp-agent';
import { startRedfish, fakeIpmitool, NXOS_POWER, ROUTEROS_HEALTH, type MockRedfish } from './simulators/power-devices';
import { NXOS_FIXTURE, ROUTEROS_FIXTURE, startNxApi, startRouterOs, type MockDevice } from './simulators/http-devices';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let globex: Client;
let redfish: MockRedfish;
let pduAgent: RunningAgent;
let ros: MockDevice;
let nxos: MockDevice;
let ipmi: ReturnType<typeof fakeIpmitool>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const D = '/api/v1/dcim';
const N = '/api/v1/network';
const P = '/api/v1/power';
const PDU_PORT = 19100 + Math.floor(Math.random() * 500);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const deps = (): PowerPollerDeps => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, adapters: { ...defaultAdapters(), ipmi: ipmiAdapter(ipmi.path) } });
async function poll(deviceId: string) {
  const [m] = await ctx.db.select().from(powerMonitoring).where(eq(powerMonitoring.deviceId, deviceId));
  return pollPowerDevice(deps(), m!);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byId = (list: any[], id: string) => list.find((x) => x.deviceId === id)!;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  redfish = await startRedfish('root', 'bmc-pass-123', { watts: 312 });
  pduAgent = await startSnmpAgent(PDU_PORT, DEFAULT_SIM, {
    community: 'pdu-ro-community',
    pdu: {
      outlets: [
        { number: 1, name: 'srv-01 PSU1', watts: 160 },
        { number: 2, name: 'srv-01 PSU2', watts: 150 },
        { number: 3, name: 'spare', watts: 0 },
      ],
      totalHundredthsKw: 45, // 450 W at the PDU input
    },
  });
  ros = await startRouterOs('dcim', 'ros-pass-123', { ...ROUTEROS_FIXTURE, '/rest/system/health': ROUTEROS_HEALTH });
  nxos = await startNxApi('admin', 'nx-pass-123', { ...NXOS_FIXTURE, 'show environment power': NXOS_POWER });
  ipmi = fakeIpmitool('ipmi-pass-123', { watts: 245 });

  const dc = (await ok(admin.post(`${D}/datacenters`, { code: 'MUM1', name: 'Mumbai 1' }))).id;
  ids.dc = dc;
  const b = (await ok(admin.post(`${D}/buildings`, { datacenterId: dc, name: 'B1' }))).id;
  const room = (await ok(admin.post(`${D}/rooms`, { buildingId: b, name: 'Hall 1' }))).id;
  ids.rack = (await ok(admin.post(`${D}/racks`, { roomId: room, name: 'A01', maxPowerW: 5000 }))).id;
  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell' }))).id;
  const srv = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'R650', category: 'server', uHeight: 1, fullDepth: true, typicalPowerW: 350, maxPowerW: 800 }))).id;
  const bare = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'Whitebox', category: 'server', uHeight: 1, fullDepth: true }))).id;
  const pduM = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'AP8853', category: 'pdu', uHeight: 0, fullDepth: false }))).id;
  const rtr = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'CCR2004', category: 'router', uHeight: 1, fullDepth: false, typicalPowerW: 40 }))).id;
  const sw = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'N9K', category: 'switch', uHeight: 1, fullDepth: true }))).id;
  const dev = async (modelId: string, tag: string, extra: object = {}) => (await ok(admin.post(`${D}/devices`, { modelId, assetTag: tag, hostname: tag.toLowerCase(), mgmtAddress: '127.0.0.1', initialState: 'inventory', ...extra }))).id as string;
  ids.s1 = await dev(srv, 'SRV-01', { customerId: ctx.customers.acme }); // Redfish + two PDU outlets
  ids.s2 = await dev(bare, 'SRV-02'); // admin estimate only
  ids.s3 = await dev(bare, 'SRV-03'); // nothing: unknown
  ids.s4 = await dev(srv, 'SRV-04'); // in inventory: not powered
  ids.s5 = await dev(srv, 'SRV-05', { customerId: ctx.customers.globex }); // IPMI, not racked
  ids.pdu = await dev(pduM, 'PDU-A01');
  ids.rtr = await dev(rtr, 'RTR-01');
  ids.sw = await dev(sw, 'LEAF-01');
  let u = 1;
  for (const id of [ids.s1, ids.s2, ids.s3, ids.rtr, ids.sw]) await ok(admin.post(`${D}/devices/${id}/placement`, { rackId: ids.rack, positionU: u++, face: 'front' }));
  await ok(admin.post(`${D}/devices/${ids.pdu}/placement`, { rackId: ids.rack, positionU: null, face: 'rear' }));
  // Put the equipment in service (the lifecycle rules are covered by the DCIM tests).
  for (const id of [ids.s1, ids.s2, ids.s3, ids.s5, ids.pdu, ids.rtr, ids.sw]) await ctx.db.update(devices).set({ lifecycleState: 'active' }).where(eq(devices.id, id));
  // The equipment has existed for a while (estimates never start before a device existed).
  await ctx.db.execute(sql`update devices set created_at = now() - interval '3 days'`);
  // The R650 has two power supplies.
  await ctx.db.execute(sql`update device_models set psu_count = 2 where id = ${srv}`);

  await ok(admin.put(`${N}/devices/${ids.s1}/credentials`, { kind: 'redfish', host: '127.0.0.1', port: redfish.port, username: 'root', password: 'bmc-pass-123', scheme: 'http' }));
  await ok(admin.put(`${N}/devices/${ids.s5}/credentials`, { kind: 'ipmi', host: '127.0.0.1', username: 'dcim-ro', password: 'ipmi-pass-123' }));
  await ok(admin.put(`${N}/devices/${ids.pdu}/credentials`, { kind: 'snmp_v2c', community: 'pdu-ro-community', host: '127.0.0.1', port: PDU_PORT, timeoutMs: 1000, retries: 0 }));
  await ok(admin.put(`${N}/devices/${ids.rtr}/credentials`, { kind: 'routeros_rest', host: '127.0.0.1', port: ros.port, username: 'dcim', password: 'ros-pass-123', scheme: 'http' }));
  await ok(admin.put(`${N}/devices/${ids.sw}/credentials`, { kind: 'nxapi', host: '127.0.0.1', port: nxos.port, username: 'admin', password: 'nx-pass-123', scheme: 'http' }));
});

afterAll(async () => {
  pduAgent?.close();
  await redfish?.close();
  await ros?.close();
  await nxos?.close();
  await ctx?.close();
});

describe('collection', () => {
  it('needs a stored credential, power.configure and a staff user', async () => {
    expect((await admin.put(`${P}/polling/${ids.s2}`, { enabled: true, credentialKind: 'redfish', intervalSeconds: 60 })).status).toBe(400);
    expect((await noc.put(`${P}/polling/${ids.s1}`, { enabled: true, credentialKind: 'redfish', intervalSeconds: 60 })).status).toBe(403);
    expect((await acme.put(`${P}/polling/${ids.s1}`, { enabled: true, credentialKind: 'redfish', intervalSeconds: 60 })).status).toBe(403);
    for (const [id, kind] of [
      [ids.s1, 'redfish'],
      [ids.s5, 'ipmi'],
      [ids.pdu, 'snmp_v2c'],
      [ids.rtr, 'routeros_rest'],
      [ids.sw, 'nxapi'],
    ]) await ok(admin.put(`${P}/polling/${id}`, { enabled: true, credentialKind: kind, intervalSeconds: 60 }));
    const list = await ok(noc.get(`${P}/polling`));
    expect(byId(list, ids.s1)).toMatchObject({ configured: true, credentialKind: 'redfish', credentialKinds: ['redfish'] });
  });

  it('claims each due device once with two pollers racing', async () => {
    const t = new Date(Date.now() + 1000);
    const [a, b] = await Promise.all([claimDuePower(ctx.db, 20, t), claimDuePower(ctx.db, 20, t)]);
    expect([...a, ...b].map((m) => m.deviceId).sort()).toEqual([ids.s1, ids.s5, ids.pdu, ids.rtr, ids.sw].sort());
    expect(await claimDuePower(ctx.db, 20, t)).toEqual([]);
  });

  it('reads a Redfish BMC with GET requests only', async () => {
    const r = await poll(ids.s1);
    expect(r).toMatchObject({ ok: true, watts: 312 });
    expect(redfish.requests.every((q) => q.method === 'GET' && q.url.startsWith('/redfish/v1'))).toBe(true);
    const [row] = await ctx.db.select().from(powerReadings).where(eq(powerReadings.deviceId, ids.s1));
    expect(row).toMatchObject({ source: 'redfish', watts: 312, periodSeconds: 60 });
  });

  it('reads Redfish EnvironmentMetrics on firmware without the Power resource', async () => {
    const env = await startRedfish('root', 'bmc-pass-123', { watts: 199, environmentMetricsOnly: true });
    try {
      const { redfishAdapter } = await import('../src/worker/adapters/redfish');
      expect(await redfishAdapter().power!({ host: '127.0.0.1', port: env.port, username: 'root', params: { scheme: 'http' }, secret: { password: 'bmc-pass-123' } })).toMatchObject({ watts: 199, source: 'redfish' });
    } finally {
      await env.close();
    }
  });

  it('reads IPMI DCMI through ipmitool with the password only in the environment', async () => {
    const r = await poll(ids.s5);
    expect(r).toMatchObject({ ok: true, watts: 245 });
    const args = readFileSync(ipmi.argsFile, 'utf8');
    expect(args).toContain('"-E"');
    expect(args).toContain('"dcmi","power","reading"');
    expect(args).not.toContain('ipmi-pass-123');
  });

  it('reports an IPMI authentication failure without leaking the password', async () => {
    const wrong = fakeIpmitool('another-password');
    const [m] = await ctx.db.select().from(powerMonitoring).where(eq(powerMonitoring.deviceId, ids.s5));
    const r = await pollPowerDevice({ ...deps(), adapters: { ipmi: ipmiAdapter(wrong.path) } }, m!);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Authentication failed/);
    expect(r.error).not.toContain('ipmi-pass-123');
  });

  it('reads RouterOS /system/health and NX-OS supply input power', async () => {
    expect(await poll(ids.rtr)).toMatchObject({ ok: true, watts: 38.5 });
    expect(await poll(ids.sw)).toMatchObject({ ok: true, watts: 287 });
    // Without the summary block, NX-OS falls back to the sum of the supplies' input.
    const only = { ...NXOS_FIXTURE, 'show environment power': { powersup: NXOS_POWER.powersup } };
    const sw2 = await startNxApi('admin', 'nx-pass-123', only);
    try {
      expect(await nxApiAdapter().power!({ host: '127.0.0.1', port: sw2.port, username: 'admin', params: { scheme: 'http' }, secret: { password: 'nx-pass-123' } })).toMatchObject({ watts: 287, detail: 'sum of 2 supply input(s)' });
    } finally {
      await sw2.close();
    }
    // A RouterOS model without power-consumption is an error, not zero watts.
    const bare = await startRouterOs('dcim', 'ros-pass-123', { ...ROUTEROS_FIXTURE, '/rest/system/health': [{ name: 'temperature', value: '40' }] });
    try {
      await expect(routerOsAdapter().power!({ host: '127.0.0.1', port: bare.port, username: 'dcim', params: { scheme: 'http' }, secret: { password: 'ros-pass-123' } })).rejects.toThrow(/no power-consumption/);
    } finally {
      await bare.close();
    }
  });

  it('reads APC PDU outlets and stores the PDU input separately', async () => {
    const r = await poll(ids.pdu);
    expect(r).toMatchObject({ ok: true, watts: 450, outlets: 3, fed: [] });
    const pdus = await ok(noc.get(`${P}/pdus`));
    const p = byId(pdus, ids.pdu);
    expect(p.outlets.map((o: { number: number; watts: number }) => [o.number, o.watts])).toEqual([
      [1, 160],
      [2, 150],
      [3, 0],
    ]);
    ids.outlets = p.outlets.map((o: { id: string }) => o.id);
  });

  it('a device fed by two outlets is measured at the PDU only when both report', async () => {
    expect((await noc.put(`${P}/outlets/${ids.outlets[0]}`, { deviceId: ids.s1 })).status).toBe(403);
    expect((await admin.put(`${P}/outlets/${ids.outlets[0]}`, { deviceId: ids.pdu })).status).toBe(400);
    await ok(admin.put(`${P}/outlets/${ids.outlets[0]}`, { deviceId: ids.s1, label: 'A feed' }));
    // One of the server's two supplies mapped: its outlet alone would under-count, so no PDU figure.
    expect((await poll(ids.pdu)).fed).toEqual([]);
    await ok(admin.put(`${P}/outlets/${ids.outlets[1]}`, { deviceId: ids.s1, label: 'B feed' }));
    // The B feed stops reporting a valid value: no PDU reading may be written for the server.
    pduAgent.setOutletWatts(2, -1);
    let r = await poll(ids.pdu);
    expect(r.fed).toEqual([]);
    pduAgent.setOutletWatts(2, 150);
    r = await poll(ids.pdu);
    expect(r.fed).toEqual([ids.s1]);
    const rows = await ctx.db.select().from(powerReadings).where(sql`${powerReadings.deviceId} = ${ids.s1} and ${powerReadings.source} = 'pdu_outlet'`);
    expect(rows.map((x) => x.watts)).toEqual([310]);
  });
});

describe('current power: priority, estimates, unknowns and totals', () => {
  it('uses the highest-priority fresh source and labels every figure', async () => {
    const list = (await ok(noc.get(`${P}/devices?pageSize=200`))).items;
    expect(byId(list, ids.s1)).toMatchObject({ watts: 310, quality: 'measured', source: 'pdu_outlet', counted: true });
    expect(byId(list, ids.s5)).toMatchObject({ watts: 245, quality: 'measured', source: 'ipmi' });
    expect(byId(list, ids.s3)).toMatchObject({ watts: null, quality: 'unknown' });
    expect(byId(list, ids.s4)).toMatchObject({ watts: null, quality: 'off', counted: false });
    // PDUs are distribution, never equipment load.
    expect(byId(list, ids.pdu)).toMatchObject({ watts: 450, quality: 'measured', counted: false });
    // SRV-02 has no model figure: unknown until an admin estimate is set.
    expect(byId(list, ids.s2).quality).toBe('unknown');
    expect((await noc.put(`${P}/devices/${ids.s2}/profile`, { estimateW: 200, includeInTotals: true })).status).toBe(403);
    await ok(admin.put(`${P}/devices/${ids.s2}/profile`, { estimateW: 200, includeInTotals: true, notes: 'from the PSU label' }));
    const after = (await ok(noc.get(`${P}/devices?pageSize=200`))).items;
    expect(byId(after, ids.s2)).toMatchObject({ watts: 200, quality: 'estimated', source: 'admin' });
  });

  it('keeps measured and estimated totals apart and counts unknown devices', async () => {
    const s = await ok(admin.get(`${P}/summary?period=24h`));
    // measured: SRV-01 310 + SRV-05 245 + RTR 38.5 + LEAF 287; estimated: SRV-02 200; unknown: SRV-03
    expect(s.now).toMatchObject({ measuredW: 880.5, estimatedW: 200, unknownDevices: 1, measuredDevices: 4, estimatedDevices: 1, devices: 6 });
    const racks = await ok(admin.get(`${P}/racks`));
    const a01 = racks.find((r: { rackId: string }) => r.rackId === ids.rack);
    // SRV-05 is not racked; the PDU input is shown on its own.
    expect(a01).toMatchObject({ maxPowerW: 5000, pduInputW: 450, pduCount: 1 });
    expect(a01.now.measuredW).toBe(310 + 38.5 + 287);
    expect(a01.budgetUsedPct).toBeCloseTo(((310 + 38.5 + 287 + 200) / 5000) * 100, 1);
  });

  it('excluding a device from totals keeps its own figure', async () => {
    await ok(admin.put(`${P}/devices/${ids.rtr}/profile`, { estimateW: null, includeInTotals: false }));
    const s = await ok(admin.get(`${P}/summary?period=24h`));
    expect(s.now.measuredW).toBe(842);
    expect((await ok(admin.get(`${P}/devices/${ids.rtr}`))).watts).toBe(38.5);
    await ok(admin.put(`${P}/devices/${ids.rtr}/profile`, { estimateW: null, includeInTotals: true }));
  });

  it('a stale reading falls back to the next source, then to the estimate', async () => {
    // Age SRV-01's PDU reading past three periods: the Redfish reading takes over.
    await ctx.db.execute(sql`update power_readings set at = at - interval '10 minutes' where device_id = ${ids.s1} and source = 'pdu_outlet'`);
    expect((await ok(admin.get(`${P}/devices/${ids.s1}`))).source).toBe('redfish');
    await ctx.db.execute(sql`update power_readings set at = at - interval '10 minutes' where device_id = ${ids.s1}`);
    expect(await ok(admin.get(`${P}/devices/${ids.s1}`))).toMatchObject({ quality: 'estimated', source: 'model', watts: 350 });
  });
});

describe('energy, tariffs and reports', () => {
  it('builds hourly energy with measured, estimated and unknown kept apart', async () => {
    await ctx.db.delete(powerReadings);
    const h0 = Math.floor(Date.now() / 3600_000) * 3600_000 - 3 * 3600_000; // three hours ago, on the hour
    // SRV-01: 300 W measured by Redfish for the whole hour h0, then nothing (gap) afterwards.
    const rows: (typeof powerReadings.$inferInsert)[] = Array.from({ length: 61 }, (_, i) => ({ deviceId: ids.s1, source: 'redfish' as const, at: new Date(h0 + i * 60_000), orgId: ctx.org.id, watts: 300, periodSeconds: 60 }));
    // SRV-05: half an hour at 200 W in h0.
    rows.push(...Array.from({ length: 31 }, (_, i) => ({ deviceId: ids.s5, source: 'ipmi' as const, at: new Date(h0 + i * 60_000), orgId: ctx.org.id, watts: 200, periodSeconds: 60 })));
    await ctx.db.insert(powerReadings).values(rows);
    await ctx.db.delete(powerHourly);
    await rollupPower(ctx.db, new Date(), { lookbackHours: 4 });
    const at = async (id: string, h: number) => (await ctx.db.select().from(powerHourly).where(sql`${powerHourly.deviceId} = ${id} and ${powerHourly.hour} = ${new Date(h).toISOString()}::timestamptz`))[0]!;
    expect(await at(ids.s1, h0)).toMatchObject({ source: 'redfish', measuredWh: 300, measuredSeconds: 3600, estimatedWh: 0, unknownSeconds: 0, counted: true, rackId: ids.rack, customerId: ctx.customers.acme });
    // The next hour has no readings: estimated from the model's typical 350 W, never a measurement.
    expect(await at(ids.s1, h0 + 3600_000)).toMatchObject({ source: null, measuredWh: 0, estimatedWh: 350, estimateKind: 'model' });
    expect(await at(ids.s5, h0)).toMatchObject({ measuredWh: 100, measuredSeconds: 1800, estimatedWh: 175, estimatedSeconds: 1800 });
    expect(await at(ids.s2, h0)).toMatchObject({ estimatedWh: 200, estimateKind: 'admin' });
    expect(await at(ids.s3, h0)).toMatchObject({ measuredWh: 0, estimatedWh: 0, unknownSeconds: 3600 });
    // Not powered and not measured: no row at all.
    expect((await ctx.db.select().from(powerHourly).where(eq(powerHourly.deviceId, ids.s4))).length).toBe(0);
    // The PDU is stored but never counted as equipment.
    expect((await at(ids.pdu, h0)).counted).toBe(false);
    // Idempotent: a second run gives the same rows.
    const before = await ctx.db.select().from(powerHourly);
    await rollupPower(ctx.db, new Date(), { lookbackHours: 4 });
    expect((await ctx.db.select().from(powerHourly)).length).toBe(before.length);
    ids.h0 = h0;
  });

  it('closed hours keep the customer, rack and estimate they were computed with', async () => {
    // SRV-01 changes hands and racks, and SRV-02's estimate changes; recomputing must not rewrite hour h0.
    await ctx.db.update(devices).set({ customerId: ctx.customers.globex }).where(eq(devices.id, ids.s1));
    await ok(admin.put(`${P}/devices/${ids.s2}/profile`, { estimateW: 900, includeInTotals: true }));
    await rollupPower(ctx.db, new Date(), { lookbackHours: 4 });
    const [s1] = await ctx.db.select().from(powerHourly).where(sql`${powerHourly.deviceId} = ${ids.s1} and ${powerHourly.hour} = ${new Date(ids.h0).toISOString()}::timestamptz`);
    expect(s1!.customerId).toBe(ctx.customers.acme);
    const [s2] = await ctx.db.select().from(powerHourly).where(sql`${powerHourly.deviceId} = ${ids.s2} and ${powerHourly.hour} = ${new Date(ids.h0).toISOString()}::timestamptz`);
    expect(s2).toMatchObject({ estimatedWh: 200, estimateW: 200 });
    // The new owner can't read the old owner's hours; the old owner no longer sees the device.
    const h = await ok(globex.get(`${P}/devices/${ids.s1}/history?range=24h`));
    expect(h.hourly.every((x: { hour: string }) => new Date(x.hour).getTime() > ids.h0 + 2 * 3600_000)).toBe(true);
    expect(h.raw).toEqual([]);
    expect((await acme.get(`${P}/devices/${ids.s1}`)).status).toBe(404);
    await ctx.db.update(devices).set({ customerId: ctx.customers.acme }).where(eq(devices.id, ids.s1));
    await ok(admin.put(`${P}/devices/${ids.s2}/profile`, { estimateW: 200, includeInTotals: true }));
  });

  it('catches up after downtime one day per run, even through hours with nothing to record', async () => {
    await ctx.db.execute(sql`delete from power_hourly where hour > now() - interval '30 hours'`);
    await ctx.db.execute(sql`update power_rollup_state set rolled_to = date_trunc('hour', now()) - interval '30 hours'`);
    const first = await rollupPower(ctx.db, new Date(), { lookbackHours: 2 });
    expect(first.hours).toBe(24);
    const second = await rollupPower(ctx.db, new Date(), { lookbackHours: 2 });
    expect(second.hours).toBeGreaterThanOrEqual(7);
    const n = await ctx.db.execute<{ n: number }>(sql`select count(distinct hour)::int as n from power_hourly where device_id = ${ids.s2} and hour > now() - interval '31 hours'`);
    expect(n.rows[0]!.n).toBeGreaterThanOrEqual(30);
    // Only one worker computes at a time; a concurrent run is skipped, not duplicated.
    const [a, b] = await Promise.all([rollupPower(ctx.db, new Date()), rollupPower(ctx.db, new Date())]);
    expect([a.skipped, b.skipped].filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it('prices energy with the tariff in force for the datacenter, else the organization default', async () => {
    expect((await noc.post(`${P}/tariffs`, { name: 'x', currency: 'INR', pricePerKwh: 8, validFrom: new Date(0).toISOString() })).status).toBe(403);
    expect((await admin.post(`${P}/tariffs`, { name: 'x', currency: 'rupees', pricePerKwh: 8, validFrom: new Date(0).toISOString() })).status).toBe(400);
    await ok(admin.post(`${P}/tariffs`, { name: 'Default', currency: 'INR', pricePerKwh: 8, validFrom: new Date(0).toISOString() }));
    // From h0 + 1 h, MUM1 pays 10 INR/kWh.
    await ok(admin.post(`${P}/tariffs`, { name: 'MUM1 2026', datacenterId: ids.dc, currency: 'INR', pricePerKwh: 10, validFrom: new Date(ids.h0 + 3600_000).toISOString() }));
    // A newer organization-wide price must not override MUM1's own tariff (it applies to SRV-05, which has no datacenter).
    await ok(admin.post(`${P}/tariffs`, { name: 'Default 2026', currency: 'INR', pricePerKwh: 9, validFrom: new Date(ids.h0 + 2 * 3600_000).toISOString() }));
    const list = (await ok(admin.get(`${P}/devices?period=24h&pageSize=200`))).items;
    const s1 = byId(list, ids.s1).energy;
    // Expected from the stored hours: 8 INR before the MUM1 tariff starts, 10 INR from then on.
    const since = Date.now() - 24 * 3600_000;
    const hours = (await ctx.db.select().from(powerHourly).where(eq(powerHourly.deviceId, ids.s1))).filter((h) => h.hour.getTime() >= Math.floor(since / 3600_000) * 3600_000);
    const price = (h: Date) => (h.getTime() >= ids.h0 + 3600_000 ? 10 : 8);
    const expected = hours.reduce((a, h) => a + ((h.measuredWh + h.estimatedWh) / 1000) * price(h.hour), 0);
    const expectedEst = hours.reduce((a, h) => a + (h.estimatedWh / 1000) * price(h.hour), 0);
    expect(hours.some((h) => price(h.hour) === 8) && hours.some((h) => price(h.hour) === 10)).toBe(true);
    expect(s1.measuredKwh).toBeCloseTo(0.3, 6);
    expect(s1.cost).toHaveLength(1);
    expect(s1.cost[0].currency).toBe('INR');
    expect(s1.cost[0].amount).toBeCloseTo(expected, 6);
    expect(s1.cost[0].estimatedPart).toBeCloseTo(expectedEst, 6);
    expect(s1.cost[0].amount - s1.cost[0].estimatedPart).toBeCloseTo(0.3 * 8, 6);
    // SRV-05 is not racked (no datacenter): the organization's tariffs, 8 then 9 INR.
    const s5 = byId(list, ids.s5).energy;
    const s5hours = (await ctx.db.select().from(powerHourly).where(eq(powerHourly.deviceId, ids.s5))).filter((h) => h.hour.getTime() >= Math.floor(since / 3600_000) * 3600_000);
    const s5price = (h: Date) => (h.getTime() >= ids.h0 + 2 * 3600_000 ? 9 : 8);
    expect(s5.cost[0].amount).toBeCloseTo(s5hours.reduce((a, h) => a + ((h.measuredWh + h.estimatedWh) / 1000) * s5price(h.hour), 0), 6);
  });

  it('exports energy as CSV with measured, estimated and unknown columns', async () => {
    const csv = (await admin.get(`${P}/energy.csv?period=24h&groupBy=device`)).text;
    const [head, ...lines] = csv.trim().split('\r\n');
    expect(head).toBe('device,from,to,measured_kwh,estimated_kwh,total_kwh,measured_hours,estimated_hours,unknown_hours,cost,currency,cost_from_estimates,unpriced_kwh');
    const s3 = lines.find((l) => l.startsWith('srv-03,'))!.split(',');
    expect(s3.slice(3, 6)).toEqual(['0.000', '0.000', '0.000']);
    expect(Number(s3[8])).toBeGreaterThan(0); // unknown hours
    const byRack = (await admin.get(`${P}/energy.csv?period=24h&groupBy=rack`)).text;
    expect(byRack).toContain('A01,');
  });

  it('expires readings and hourly rows past retention', async () => {
    await ctx.db.insert(powerReadings).values({ deviceId: ids.s1, source: 'redfish', at: new Date(Date.now() - 40 * 86400_000), orgId: ctx.org.id, watts: 1, periodSeconds: 60 });
    await ok(admin.put(`${P}/settings`, { rawDays: 35, hourlyDays: 1095 }));
    expect((await applyPowerRetention(ctx.db)).raw).toBe(1);
  });
});

describe('tenancy and secrecy', () => {
  it('customers see their own devices, without cost, racks, PDUs or tariffs', async () => {
    const mine = (await ok(acme.get(`${P}/devices?pageSize=200`))).items;
    expect(mine.map((d: { deviceId: string }) => d.deviceId)).toEqual([ids.s1]);
    expect(mine[0].energy.cost).toEqual([]);
    expect(mine[0]).toMatchObject({ rackId: null, rackName: null, datacenterId: null, datacenterCode: null, polling: null });
    expect(mine[0].energy.unpricedKwh).toBe(0);
    expect((await ok(globex.get(`${P}/devices`))).items.map((d: { deviceId: string }) => d.deviceId)).toEqual([ids.s5]);
    expect((await acme.get(`${P}/devices/${ids.s5}`)).status).toBe(404);
    expect((await acme.get(`${P}/devices/${ids.s5}/history`)).status).toBe(404);
    for (const path of ['racks', 'pdus', 'tariffs', 'polling', 'settings']) expect((await acme.get(`${P}/${path}`)).status).toBe(403);
    const s = await ok(acme.get(`${P}/summary?period=24h`));
    expect(s.byDatacenter).toEqual([]);
    expect(s.energy.cost).toEqual([]);
    const d = await ok(acme.get(`${P}/devices/${ids.s1}`));
    expect(d.outlets).toEqual([]);
    expect(d.credentialKinds).toEqual([]);
    const csv = (await acme.get(`${P}/energy.csv?period=24h&groupBy=device`)).text;
    expect(csv.split('\r\n')[0]).not.toContain('cost');
    expect(csv).not.toContain('srv-05');
  });

  it('never returns or records BMC and PDU secrets', async () => {
    const everything = JSON.stringify([await ok(admin.get(`${P}/polling`)), await ok(admin.get(`${N}/devices/${ids.s1}/credentials`)), await ok(admin.get(`${P}/devices/${ids.s1}`)), await ctx.db.select().from(auditEvents)]);
    for (const s of ['bmc-pass-123', 'ipmi-pass-123', 'pdu-ro-community']) expect(everything).not.toContain(s);
  });

  it('power collection runs in the worker with no client involved', async () => {
    await ctx.db.execute(sql`update power_monitoring set next_poll_at = now() - interval '1 second'`);
    const out = await pollDuePower(deps(), { concurrency: 3 });
    expect(out.filter((o) => o.ok).map((o) => o.deviceId).sort()).toEqual([ids.s1, ids.s5, ids.pdu, ids.rtr, ids.sw].sort());
  });
});
