/**
 * Phase 4: polling, rates, storage, rollups, alerts, maintenance, notifications,
 * live stream and tenancy — end to end against simulated devices (a real SNMP
 * agent with changing counters, and HTTP / TCP mocks of the vendor APIs).
 * A controllable clock drives the poller so intervals are exact.
 */
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, deviceMonitoring, interfaceRates, interfaceRates1h, interfaceRates5m, interfaces, notifications } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { claimDue, pollDue, runPoll, type PollOutcome } from '../src/worker/monitoring/poller';
import { closeUnmonitoredAlerts, evaluateAlerts, type AlertEvent } from '../src/worker/monitoring/alerts';
import { applyRetention, rollup } from '../src/worker/monitoring/rollup';
import { deliverDue, isPrivateAddress } from '../src/worker/monitoring/notify';
import { monitoringChannel } from '../src/monitoring/events';
import { routerOsApiAdapter } from '../src/worker/adapters/routeros-api';
import { fortiOsAdapter } from '../src/worker/adapters/fortios';
import { nxApiAdapter } from '../src/worker/adapters/nxapi';
import { Client, PASSWORD, setupTestApp, type TestContext } from './helpers';
import { DEFAULT_SIM, startSnmpAgent, type CounterName, type RunningAgent } from './simulators/snmp-agent';
import { FORTIOS_FIXTURE, NXOS_FIXTURE, ROUTEROS_FIXTURE, startFortiOs, startNxApi, startRouterOs, type MockDevice } from './simulators/http-devices';
import { startRouterOsApi, type MockApi } from './simulators/routeros-api';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let globex: Client;
let hc: RunningAgent;
let c32: RunningAgent;
let rest: MockDevice;
let hook: { port: number; received: { headers: http.IncomingHttpHeaders; body: string; url: string }[]; fail: boolean; close: () => Promise<void> };
let smtp: { port: number; mails: { from: string; to: string[]; data: string }[]; close: () => Promise<void> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const D = '/api/v1/dcim';
const N = '/api/v1/network';
const M = '/api/v1/monitoring';
const A = '/api/v1/alerts';
const HC_PORT = 18100 + Math.floor(Math.random() * 400);
const C32_PORT = HC_PORT + 500;
const COMMUNITY = 'mon-ro-community';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201, 202]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/* ---------------------------------------------------------------- clock and polling */

// Start on a 5-minute boundary (plus 10 s) so rollup buckets are predictable.
const clock = { t: Math.floor(Date.now() / 300_000) * 300_000 + 10_000 };
const now = () => new Date(clock.t);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const events: AlertEvent[] = [];
const deps = () => ({
  db: ctx.db,
  secrets: ctx.app.get(SecretBox),
  logger: silent,
  now,
  onPolled: async (o: PollOutcome) => void events.push(...(await evaluateAlerts(ctx.db, o))),
});
async function poll(deviceId: string): Promise<PollOutcome> {
  const [m] = await ctx.db.select().from(deviceMonitoring).where(eq(deviceMonitoring.deviceId, deviceId));
  return runPoll(deps(), m!);
}

/** Simulated counters per agent/ifIndex, advanced with the clock. */
const counters = new Map<string, Record<CounterName, bigint>>();
const UPTIME0 = 50_000_000; // ticks (≈ 5.8 days)
let clockOrigin = clock.t;
function setCounters(agent: RunningAgent, ifIndex: number, v: Partial<Record<CounterName, bigint>>) {
  const key = `${agent.port}:${ifIndex}`;
  const cur = counters.get(key) ?? { inOctets: 0n, outOctets: 0n, inPkts: 0n, outPkts: 0n, inErrors: 0n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n };
  for (const [k, val] of Object.entries(v)) {
    cur[k as CounterName] = val as bigint;
    agent.setCounter(ifIndex, k as CounterName, val as bigint);
  }
  counters.set(key, cur);
}
function addCounters(agent: RunningAgent, ifIndex: number, d: Partial<Record<CounterName, bigint>>) {
  const cur = counters.get(`${agent.port}:${ifIndex}`) ?? ({} as Record<CounterName, bigint>);
  setCounters(agent, ifIndex, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, (cur[k as CounterName] ?? 0n) + (v as bigint)])));
}
/** Advances the clock (and the agents' uptime) by `s` seconds. */
function tick(s = 60) {
  clock.t += s * 1000;
  const ticks = UPTIME0 + Math.round((clock.t - clockOrigin) / 10);
  hc.setUptime(ticks);
  c32.setUptime(ticks);
}

/** RouterOS REST fixture with counters we can change between polls. */
const rosFixture: Record<string, unknown> = structuredClone(ROUTEROS_FIXTURE);
const rosRows = rosFixture['/rest/interface'] as Record<string, string>[];
function rosAdd(name: string, rx: bigint, tx: bigint) {
  const r = rosRows.find((x) => x.name === name)!;
  r['rx-byte'] = (BigInt(r['rx-byte'] ?? '0') + rx).toString();
  r['tx-byte'] = (BigInt(r['tx-byte'] ?? '0') + tx).toString();
}
function rosUptime() {
  const secs = 1_000_000 + Math.round((clock.t - clockOrigin) / 1000);
  (rosFixture['/rest/system/resource'] as Record<string, string>).uptime = `${Math.floor(secs / 86400)}d${String(Math.floor((secs % 86400) / 3600)).padStart(2, '0')}:${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

async function startHook() {
  const received: { headers: http.IncomingHttpHeaders; body: string; url: string }[] = [];
  const state = { fail: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body, url: req.url! });
      res.writeHead(state.fail ? 500 : 200, { 'content-type': 'application/json' });
      res.end(state.fail ? '{"error":"boom"}' : '{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return Object.assign(state, { port: (server.address() as AddressInfo).port, received, close: () => new Promise<void>((r) => server.close(() => r())) });
}

async function startSmtp() {
  const mails: { from: string; to: string[]; data: string }[] = [];
  const server = new SMTPServer({
    authOptional: false,
    disabledCommands: ['STARTTLS'],
    allowInsecureAuth: true,
    onAuth: (auth, _s, cb) => (auth.username === 'alerts' && auth.password === 'smtp-secret-pass' ? cb(null, { user: 'alerts' }) : cb(new Error('Invalid login'))),
    onData: (stream, session, cb) => {
      let data = '';
      stream.on('data', (c: Buffer) => (data += c.toString()));
      stream.on('end', () => {
        mails.push({ from: (session.envelope.mailFrom as { address: string }).address, to: session.envelope.rcptTo.map((r) => r.address), data });
        cb();
      });
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.server.address() as AddressInfo).port, mails, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function ifaceIds(deviceId: string): Promise<Record<string, string>> {
  const rows = await ctx.db.select({ id: interfaces.id, name: interfaces.name }).from(interfaces).where(eq(interfaces.deviceId, deviceId));
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  hc = await startSnmpAgent(HC_PORT, DEFAULT_SIM, { community: COMMUNITY, counters: 'hc' });
  c32 = await startSnmpAgent(C32_PORT, DEFAULT_SIM, { community: COMMUNITY, counters: '32' });
  tick(0);
  rosUptime();
  rest = await startRouterOs('dcim', 'rest-pass-123', rosFixture as typeof ROUTEROS_FIXTURE);
  hook = await startHook();
  smtp = await startSmtp();

  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'MikroTik' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'CCR2004', category: 'router', uHeight: 1, fullDepth: false }))).id;
  const srvModel = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'Server', category: 'server', uHeight: 1, fullDepth: true }))).id;
  const dev = async (tag: string, extra: object = {}) => (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: tag, hostname: tag.toLowerCase(), mgmtAddress: '127.0.0.1', initialState: 'inventory', ...extra }))).id;
  ids.r1 = await dev('R1');
  ids.r2 = await dev('R2');
  ids.sw = await dev('SW');
  ids.s1 = (await ok(admin.post(`${D}/devices`, { modelId: srvModel, assetTag: 'S1', hostname: 'acme-srv', initialState: 'inventory', customerId: ctx.customers.acme }))).id;

  await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.r1, pattern: 'ether[1-1]' }));
  await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.r1, pattern: 'sfp-sfpplus[1-2]' }));
  await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.r2, pattern: 'ether[1-1]' }));
  await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.sw, pattern: 'ether[1-1]', speedBps: 1e9 }));
  await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.sw, pattern: 'sfp-sfpplus[1-2]', speedBps: 10e9 }));
  const bond = await ok(admin.post(`${N}/interfaces`, { deviceId: ids.sw, name: 'bond1', kind: 'lag', speedBps: 20e9, countInTotals: true }));
  await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.s1, pattern: 'eth[0-0]' }));
  ids.if = { ...(await ifaceIds(ids.r1)) };
  ids.r2if = await ifaceIds(ids.r2);
  ids.swif = await ifaceIds(ids.sw);
  ids.s1if = await ifaceIds(ids.s1);
  // The LAG members and the LAG itself are all marked for totals: the LAG must be counted once.
  await ctx.db.update(interfaces).set({ lagId: bond.id, countInTotals: true }).where(sql`${interfaces.id} in (${ids.swif['sfp-sfpplus1']}, ${ids.swif['sfp-sfpplus2']})`);
  await ctx.db.update(interfaces).set({ countInTotals: true }).where(eq(interfaces.id, ids.swif.ether1));
  await ok(admin.post(`${N}/cables`, { aInterfaceId: ids.swif.ether1, bInterfaceId: ids.s1if.eth0 }));

  await ok(admin.put(`${N}/devices/${ids.r1}/credentials`, { kind: 'snmp_v2c', community: COMMUNITY, host: '127.0.0.1', port: HC_PORT, timeoutMs: 1000, retries: 0 }));
  await ok(admin.put(`${N}/devices/${ids.r2}/credentials`, { kind: 'snmp_v2c', community: COMMUNITY, host: '127.0.0.1', port: C32_PORT, timeoutMs: 1000, retries: 0 }));
  await ok(admin.put(`${N}/devices/${ids.sw}/credentials`, { kind: 'routeros_rest', host: '127.0.0.1', port: rest.port, username: 'dcim', password: 'rest-pass-123', scheme: 'http' }));
});

afterAll(async () => {
  hc?.close();
  c32?.close();
  await rest?.close();
  await hook?.close();
  await smtp?.close();
  await ctx?.close();
});

/* ---------------------------------------------------------------- tests */

describe('polling configuration', () => {
  it('needs a stored credential of the chosen kind and monitoring.configure', async () => {
    expect((await admin.put(`${M}/devices/${ids.r1}`, { enabled: true, credentialKind: 'nxapi', intervalSeconds: 60 })).status).toBe(400);
    expect((await noc.put(`${M}/devices/${ids.r1}`, { enabled: true, credentialKind: 'snmp_v2c', intervalSeconds: 60 })).status).toBe(403);
    expect((await admin.put(`${M}/devices/${ids.r1}`, { enabled: true, credentialKind: 'snmp_v2c', intervalSeconds: 10 })).status).toBe(400);
    for (const id of [ids.r1, ids.r2]) await ok(admin.put(`${M}/devices/${id}`, { enabled: true, credentialKind: 'snmp_v2c', intervalSeconds: 60 }));
    await ok(admin.put(`${M}/devices/${ids.sw}`, { enabled: true, credentialKind: 'routeros_rest', intervalSeconds: 60 }));
    const list = await ok(noc.get(`${M}/devices`));
    expect(list.find((d: { deviceId: string }) => d.deviceId === ids.r1)).toMatchObject({ configured: true, enabled: true, credentialKind: 'snmp_v2c', intervalSeconds: 60 });
    const audit = await ctx.db.select().from(auditEvents).where(eq(auditEvents.action, 'monitoring.configure'));
    expect(audit.length).toBe(3);
  });

  it('claims each due device once, even with two pollers racing', async () => {
    // Enabling polling makes the device due immediately (wall clock).
    const t0 = new Date(Date.now() + 1000);
    const [a, b] = await Promise.all([claimDue(ctx.db, 10, t0), claimDue(ctx.db, 10, t0)]);
    const all = [...a, ...b].map((m) => m.deviceId).sort();
    expect(all).toEqual([ids.r1, ids.r2, ids.sw].sort());
    // Claimed rows are pushed one interval ahead: nothing is due again now.
    expect(await claimDue(ctx.db, 10, t0)).toEqual([]);
    expect(await claimDue(ctx.db, 10, new Date(t0.getTime() + 59_000))).toEqual([]);
    expect((await claimDue(ctx.db, 10, new Date(t0.getTime() + 61_000))).length).toBe(3);
  });
});

describe('rates from a real SNMP agent (64-bit counters)', () => {
  it('stores a baseline first, then measured rates and utilization', async () => {
    setCounters(hc, 1, { inOctets: 1_000_000_000n, outOctets: 5_000_000n, inPkts: 100n, outPkts: 100n });
    const first = await poll(ids.r1);
    expect(first.ok).toBe(true);
    expect(first.ports.find((p) => p.name === 'ether1')).toMatchObject({ skip: 'first', inBps: null });
    // sim interfaces with no inventory port (lo, vlan100) are counted, not invented
    expect(first.unmatched).toBe(2);

    tick(60);
    addCounters(hc, 1, { inOctets: 750_000_000n, outOctets: 75_000_000n, inPkts: 600n, outPkts: 600n });
    const second = await poll(ids.r1);
    const e1 = second.ports.find((p) => p.name === 'ether1')!;
    expect(e1).toMatchObject({ inBps: 100_000_000, outBps: 10_000_000, utilIn: 10, utilOut: 1, skip: null });
    const rows = await ctx.db.select().from(interfaceRates).where(eq(interfaceRates.interfaceId, ids.if.ether1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inBps: 100_000_000, seconds: 60, inPps: 10, speedBps: 1e9 });

    const list = await ok(noc.get(`${M}/ports?deviceId=${ids.r1}&sort=traffic`));
    expect(list.items[0]).toMatchObject({ name: 'ether1', inBps: 100_000_000, utilIn: 10, fresh: true, operUp: true });
    // sfp-sfpplus1 is oper-down in the simulator
    expect(list.items.find((x: { name: string }) => x.name === 'sfp-sfpplus1').operUp).toBe(false);
  });

  it('treats a device restart as a counter reset: no spike, no negative rate', async () => {
    tick(60);
    hc.setUptime(3000); // rebooted 30 s ago
    setCounters(hc, 1, { inOctets: 1000n, outOctets: 1000n });
    const r = await poll(ids.r1);
    expect(r.ports.find((p) => p.name === 'ether1')).toMatchObject({ skip: 'reset', inBps: null });
    // From here on the simulated uptime keeps counting from the reboot.
    clockOrigin = clock.t - 30_000 - UPTIME0 * 10;
    tick(60);
    addCounters(hc, 1, { inOctets: 75_000_000n, outOctets: 0n });
    const after = await poll(ids.r1);
    expect(after.ports.find((p) => p.name === 'ether1')).toMatchObject({ skip: null, inBps: 10_000_000 });
  });

  it('leaves a gap after missed polls instead of averaging over it', async () => {
    tick(240);
    addCounters(hc, 1, { inOctets: 1_000_000n });
    const r = await poll(ids.r1);
    expect(r.ports.find((p) => p.name === 'ether1')!.skip).toBe('gap');
    const history = await ok(noc.get(`${M}/ports/${ids.if.ether1}/history?range=1h`));
    expect(history.resolution).toBe('raw');
    expect(history.stepSeconds).toBe(60);
    expect(history.points.map((p: { inBps: number }) => p.inBps)).toEqual([100_000_000, 10_000_000]);
  });
});

describe('32-bit counters', () => {
  it('handles a wrap and flags it', async () => {
    setCounters(c32, 1, { inOctets: 2n ** 32n - 1_000_000n, outOctets: 0n });
    await poll(ids.r2);
    tick(60);
    // 1 000 000 bytes to the wrap point + 6 500 000 after it = 7.5 MB in 60 s = 1 Mbit/s
    setCounters(c32, 1, { inOctets: 6_500_000n, outOctets: 0n });
    const r = await poll(ids.r2);
    expect(r.ports.find((p) => p.name === 'ether1')).toMatchObject({ inBps: 1_000_000, skip: null });
    const [row] = await ctx.db.select().from(interfaceRates).where(eq(interfaceRates.interfaceId, ids.r2if.ether1));
    expect(row!.flags).toContain('wrap');
  });
});

describe('RouterOS REST counters, LAG-aware totals and rollups', () => {
  it('polls /interface and /system/resource read-only', async () => {
    rosAdd('ether1', 0n, 0n);
    for (const n of ['sfp-sfpplus1', 'sfp-sfpplus2', 'bond1']) rosAdd(n, 0n, 0n);
    await poll(ids.sw);
    tick(60);
    rosUptime();
    rosAdd('ether1', 75_000_000n, 7_500_000n); // 10 / 1 Mbit/s
    rosAdd('sfp-sfpplus1', 750_000_000n, 0n); // 100 Mbit/s
    rosAdd('sfp-sfpplus2', 750_000_000n, 0n); // 100 Mbit/s
    rosAdd('bond1', 1_500_000_000n, 0n); // 200 Mbit/s = both members
    const r = await poll(ids.sw);
    expect(r.ok).toBe(true);
    expect(r.ports.find((p) => p.name === 'bond1')!.inBps).toBe(200_000_000);
    expect(rest.requests.every((q) => q.method === 'GET')).toBe(true);
    expect(rest.requests.some((q) => q.url.startsWith('/rest/interface?.proplist='))).toBe(true);
  });

  it('counts a LAG once, not the LAG plus its members', async () => {
    const t = await ok(admin.get(`${M}/totals`));
    // bond1 (200 M) + ether1 (10 M); members excluded
    expect(t).toMatchObject({ inBps: 210_000_000, outBps: 1_000_000, ports: 2, freshPorts: 2, excludedLagMembers: 2 });
    expect((await acme.get(`${M}/totals`)).status).toBe(403);
  });

  it('downsamples with time-weighted averages and keeps the 95th percentile basis', async () => {
    // Two more samples of different length on SW ether1: 30 s at 40 Mbit/s and 90 s at 0.
    tick(30);
    rosUptime();
    rosAdd('ether1', 150_000_000n, 0n);
    await ok(admin.put(`${M}/devices/${ids.sw}`, { enabled: true, credentialKind: 'routeros_rest', intervalSeconds: 30 }));
    await poll(ids.sw);
    tick(90);
    rosUptime();
    await ok(admin.put(`${M}/devices/${ids.sw}`, { enabled: true, credentialKind: 'routeros_rest', intervalSeconds: 60 }));
    await poll(ids.sw);
    await rollup(ctx.db, now(), { fiveMinuteLookbackSeconds: 3600, hourlyLookbackSeconds: 7200 });
    const raw = await ctx.db.select().from(interfaceRates).where(eq(interfaceRates.interfaceId, ids.swif.ether1));
    expect(raw.map((r) => [r.inBps, r.seconds])).toEqual([
      [10_000_000, 60],
      [40_000_000, 30],
      [0, 90],
    ]);
    const five = await ctx.db.select().from(interfaceRates5m).where(eq(interfaceRates5m.interfaceId, ids.swif.ether1));
    const samples = five.reduce((a, b) => a + b.samples, 0);
    const covered = five.reduce((a, b) => a + b.coveredSeconds, 0);
    expect(samples).toBe(3);
    expect(covered).toBe(180);
    const weighted = five.reduce((a, b) => a + b.inBps * b.coveredSeconds, 0) / covered;
    // (10M·60 + 40M·30 + 0·90) / 180 = 10 Mbit/s  (a plain average of the three would say 16.7)
    expect(weighted).toBeCloseTo(10_000_000, 3);
    expect(Math.max(...five.map((b) => b.inMax))).toBe(40_000_000);
    const hourly = await ctx.db.select().from(interfaceRates1h).where(eq(interfaceRates1h.interfaceId, ids.swif.ether1));
    expect(hourly.reduce((a, b) => a + b.coveredSeconds, 0)).toBe(180);
    // Re-running is idempotent.
    await rollup(ctx.db, now(), { fiveMinuteLookbackSeconds: 3600, hourlyLookbackSeconds: 7200 });
    expect((await ctx.db.select().from(interfaceRates5m).where(eq(interfaceRates5m.interfaceId, ids.swif.ether1))).reduce((a, b) => a + b.samples, 0)).toBe(3);

    const h = await ok(noc.get(`${M}/ports/${ids.swif.ether1}/history?range=24h`));
    expect(h.resolution).toBe('5m');
    expect(h.points.length).toBe(five.length);
  });

  it('computes the 95th percentile by nearest rank over complete 5-minute buckets', async () => {
    // 20 complete buckets of 1..20 Mbit/s an hour ago, plus a huge value in the bucket still filling now.
    const base = Math.floor(Date.now() / 300_000) * 300_000 - 3 * 3600_000;
    const row = (bucket: number, v: number) => ({ interfaceId: ids.swif['sfp-sfpplus2'], bucket: new Date(bucket), orgId: ctx.org.id, deviceId: ids.sw, inBps: v, outBps: v / 2, inMax: v, outMax: v / 2, samples: 5, coveredSeconds: 300 });
    await ctx.db.insert(interfaceRates5m).values(Array.from({ length: 20 }, (_, i) => row(base + i * 300_000, (i + 1) * 1e6)));
    await ctx.db.insert(interfaceRates5m).values(row(Math.floor(Date.now() / 300_000) * 300_000, 9e9)).onConflictDoNothing();
    const h = await ok(noc.get(`${M}/ports/${ids.swif['sfp-sfpplus2']}/history?range=24h`));
    // nearest rank: ceil(0.95 × 20) = 19th value
    expect(h.p95).toMatchObject({ inBps: 19e6, outBps: 9.5e6, samples: 20 });
  });

  it('expires data past the retention settings', async () => {
    const old = new Date(clock.t - 10 * 86400_000);
    await ctx.db.insert(interfaceRates).values({ interfaceId: ids.swif.ether1, at: old, seconds: 60, orgId: ctx.org.id, deviceId: ids.sw, inBps: 1, outBps: 1 });
    await ok(admin.put(`${M}/settings`, { rawDays: 7, fiveMinuteDays: 90, hourlyDays: 730 }));
    expect((await noc.put(`${M}/settings`, { rawDays: 1, fiveMinuteDays: 90, hourlyDays: 730 })).status).toBe(403);
    const r = await applyRetention(ctx.db, now());
    expect(r.raw).toBe(1);
    expect((await ctx.db.select().from(interfaceRates).where(eq(interfaceRates.at, old))).length).toBe(0);
  });
});

describe('tenancy', () => {
  it('customers see only ports on or cabled to their devices', async () => {
    const mine = await ok(acme.get(`${M}/ports?pageSize=200`));
    expect(mine.items.map((x: { interfaceId: string }) => x.interfaceId)).toEqual([ids.swif.ether1]);
    expect((await ok(globex.get(`${M}/ports`))).items).toEqual([]);
    expect((await acme.get(`${M}/ports/${ids.if.ether1}`)).status).toBe(404);
    expect((await acme.get(`${M}/ports/${ids.if.ether1}/history`)).status).toBe(404);
    expect((await ok(acme.get(`${M}/ports/${ids.swif.ether1}/history?range=1h`))).points.length).toBeGreaterThan(0);
    expect((await acme.get(`${M}/devices`)).status).toBe(403);
    expect((await acme.get(`${A}`)).status).toBe(403);
  });
});

describe('alerts, maintenance and notifications', () => {
  it('stores channels with write-only secrets', async () => {
    const wh = await ok(admin.post(`${A}/channels`, { kind: 'webhook', name: 'NOC hook', url: `http://127.0.0.1:${hook.port}/hook`, signingSecret: 'hook-signing-secret-1' }));
    expect(JSON.stringify(wh)).not.toContain('hook-signing-secret-1');
    ids.webhook = wh.id;
    const mail = await ok(admin.post(`${A}/channels`, { kind: 'email', name: 'NOC mail', to: ['noc@example.net'], from: 'dcim@example.net', smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecurity: 'none', smtpUser: 'alerts', smtpPassword: 'smtp-secret-pass' }));
    ids.mail = mail.id;
    expect((await noc.post(`${A}/channels`, { kind: 'slack', name: 'x', webhookUrl: 'https://hooks.slack.com/services/x' })).status).toBe(403);
    expect((await admin.post(`${A}/channels`, { kind: 'webhook', name: 'NOC hook', url: 'http://127.0.0.1:1/x', signingSecret: 'another-secret' })).status).toBe(409);
    const list = JSON.stringify(await ok(noc.get(`${A}/channels`)));
    expect(list).not.toContain('hook-signing-secret-1');
    expect(list).not.toContain('smtp-secret-pass');
    const audit = JSON.stringify(await ctx.db.select().from(auditEvents));
    expect(audit).not.toContain('hook-signing-secret-1');
    expect(audit).not.toContain('smtp-secret-pass');
  });

  it('delivers a test message through the worker (email over SMTP)', async () => {
    const t = await ok(admin.post(`${A}/channels/${ids.mail}/test`));
    expect(t.status).toBe('pending');
    const r = await deliverDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, allowPrivate: true });
    expect(r.sent).toBe(1);
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]).toMatchObject({ from: 'dcim@example.net', to: ['noc@example.net'] });
    expect(smtp.mails[0]!.data).toContain('NexoraDC test notification');
  });

  it('fires only after both the duration and the sample count, notifies once, and resolves after clear samples', async () => {
    const slow = await ok(noc.post(`${A}/rules`, { name: 'Uplink hot (150 s)', metric: 'util_max', threshold: 50, forSeconds: 150, minSamples: 2, clearSamples: 2, severity: 'critical', scope: 'interfaces', interfaceIds: [ids.if.ether1], channelIds: [ids.webhook] }));
    const quick = await ok(noc.post(`${A}/rules`, { name: 'Uplink hot (3 samples)', metric: 'util_max', threshold: 50, forSeconds: 0, minSamples: 3, clearSamples: 1, severity: 'warning', scope: 'devices', deviceIds: [ids.r1] }));
    expect((await noc.post(`${A}/rules`, { name: 'bad', metric: 'util_in', threshold: 150 })).status).toBe(400);
    expect((await noc.post(`${A}/rules`, { name: 'bad', metric: 'device_unreachable', scope: 'interfaces', interfaceIds: [ids.if.ether1] })).status).toBe(400);

    // establish a baseline after the earlier gap
    tick(60);
    await poll(ids.r1);
    events.length = 0;
    const firedAt: Record<string, number> = {};
    for (let i = 1; i <= 5; i++) {
      tick(60);
      addCounters(hc, 1, { inOctets: 6_000_000_000n }); // 800 Mbit/s on 1 Gbit/s = 80 %
      await poll(ids.r1);
      for (const e of events.filter((x) => x.status === 'firing')) firedAt[e.alertId] ??= i;
    }
    const firing = await ok(noc.get(`${A}?status=firing`));
    const bySlow = firing.items.find((a: { ruleId: string }) => a.ruleId === slow.id);
    const byQuick = firing.items.find((a: { ruleId: string }) => a.ruleId === quick.id);
    expect(byQuick).toBeTruthy();
    expect(bySlow).toBeTruthy();
    // quick: 3 consecutive samples; slow: held ≥150 s (samples 1..4 span 180 s) although 2 samples were already enough
    expect(firedAt[byQuick.id]).toBe(3);
    expect(firedAt[bySlow.id]).toBe(4);
    expect(bySlow).toMatchObject({ severity: 'critical', interfaceName: 'ether1', suppressed: false });
    expect(bySlow.message).toMatch(/r1 ether1: utilization, either direction 80\.0% > 50\.0%/);
    expect(await ok(noc.get(`${A}/summary`))).toMatchObject({ firing: 2, critical: 1, warning: 1 });

    // Exactly one firing notification is queued for the slow rule's webhook; delivery is signed.
    await deliverDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, allowPrivate: true });
    const delivered = hook.received.filter((r) => r.url === '/hook');
    expect(delivered).toHaveLength(1);
    const { headers, body } = delivered[0]!;
    const expectSig = createHmac('sha256', 'hook-signing-secret-1').update(`${headers['x-cdcim-timestamp']}.${body}`).digest('hex');
    expect(headers['x-cdcim-signature']).toBe(`sha256=${expectSig}`);
    expect(JSON.parse(body)).toMatchObject({ event: 'firing', alert: { severity: 'critical', device: 'r1', interface: 'ether1' } });

    // ack is recorded, not acted on
    await ok(noc.post(`${A}/${bySlow.id}/ack`, { note: 'looking' }));
    expect((await acme.post(`${A}/${bySlow.id}/ack`, {})).status).toBe(403);

    // traffic drops: the slow rule needs 2 clear samples
    tick(60);
    addCounters(hc, 1, { inOctets: 75_000_000n });
    await poll(ids.r1);
    expect((await ok(noc.get(`${A}?status=firing`))).items.map((a: { ruleId: string }) => a.ruleId)).toEqual([slow.id]);
    tick(60);
    addCounters(hc, 1, { inOctets: 75_000_000n });
    await poll(ids.r1);
    expect((await ok(noc.get(`${A}?status=firing`))).total).toBe(0);
    await deliverDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, allowPrivate: true });
    expect(JSON.parse(hook.received.at(-1)!.body)).toMatchObject({ event: 'resolved' });
    ids.slowRule = slow.id;
    ids.quickRule = quick.id;
  });

  it('missing data neither fires nor clears an alert', async () => {
    tick(60);
    addCounters(hc, 1, { inOctets: 6_000_000_000n });
    await poll(ids.r1); // breach 1
    tick(400); // gap → no rate
    addCounters(hc, 1, { inOctets: 1n });
    await poll(ids.r1);
    const [st] = (await ctx.db.execute(sql`select breach_count from alert_state where rule_id = ${ids.quickRule} and target_key = ${'i:' + ids.if.ether1}`)).rows as { breach_count: number }[];
    expect(st!.breach_count).toBe(1);
  });

  it('suppresses notifications inside a maintenance window and notifies when it ends with the problem still there', async () => {
    const before = hook.received.length;
    const w = await ok(noc.post(`${A}/maintenance`, { name: 'Optics swap', startsAt: new Date(clock.t - 60_000).toISOString(), endsAt: new Date(clock.t + 3600_000).toISOString(), scope: 'devices', deviceIds: [ids.r1] }));
    for (let i = 0; i < 4; i++) {
      tick(60);
      addCounters(hc, 1, { inOctets: 6_000_000_000n });
      await poll(ids.r1);
    }
    const a = (await ok(noc.get(`${A}?status=firing`))).items.find((x: { ruleId: string }) => x.ruleId === ids.slowRule);
    expect(a.suppressed).toBe(true);
    expect((await ok(noc.get(`${A}/summary`))).firing).toBe(0); // suppressed alerts are not counted as firing problems
    await deliverDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, allowPrivate: true });
    expect(hook.received.length).toBe(before);

    // End the window (move it into the past); the next breaching sample notifies.
    await ok(noc.put(`${A}/maintenance/${w.id}`, { name: 'Optics swap', startsAt: new Date(clock.t - 7200_000).toISOString(), endsAt: new Date(clock.t - 1000).toISOString(), scope: 'devices', deviceIds: [ids.r1] }));
    tick(60);
    addCounters(hc, 1, { inOctets: 6_000_000_000n });
    await poll(ids.r1);
    await deliverDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, allowPrivate: true });
    expect(hook.received.length).toBe(before + 1);
    expect(JSON.parse(hook.received.at(-1)!.body)).toMatchObject({ event: 'firing' });
  });

  it('raises device_unreachable from consecutive failed polls, never touching the device', async () => {
    await ok(noc.post(`${A}/rules`, { name: 'Router down', metric: 'device_unreachable', forSeconds: 0, minSamples: 2, clearSamples: 1, severity: 'critical', scope: 'devices', deviceIds: [ids.r2] }));
    c32.close();
    for (let i = 0; i < 2; i++) {
      tick(60);
      const r = await poll(ids.r2);
      expect(r.ok).toBe(false);
    }
    const [m] = await ctx.db.select().from(deviceMonitoring).where(eq(deviceMonitoring.deviceId, ids.r2));
    expect(m!.consecutiveFailures).toBe(2);
    expect(m!.lastError).toBeTruthy();
    expect(m!.lastError).not.toContain(COMMUNITY);
    const firing = (await ok(noc.get(`${A}?status=firing`))).items;
    expect(firing.find((a: { metric: string }) => a.metric === 'device_unreachable')).toMatchObject({ deviceName: 'r2', message: expect.stringMatching(/not answering polls \(2 consecutive failures\)/) });
  });

  it('closes alerts whose target is no longer polled', async () => {
    await ok(admin.delete(`${M}/devices/${ids.r2}`));
    expect(await closeUnmonitoredAlerts(ctx.db)).toBe(1);
    const a = (await ok(noc.get(`${A}?status=resolved`))).items.find((x: { metric: string }) => x.metric === 'device_unreachable');
    expect(a.message).toMatch(/closed: no longer monitored/);
  });

  it('refuses private and local notification destinations unless allowed', async () => {
    expect(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1'].every(isPrivateAddress)).toBe(true);
    expect(['8.8.8.8', '1.1.1.1', '2606:4700::1111'].some(isPrivateAddress)).toBe(false);
    await ok(admin.post(`${A}/channels/${ids.webhook}/test`));
    await deliverDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent });
    const [n] = await ctx.db.select().from(notifications).where(sql`${notifications.event} = 'test' and ${notifications.channelId} = ${ids.webhook}`);
    expect(n!.lastError).toMatch(/private or local address/);
    await ctx.db.delete(notifications).where(eq(notifications.id, n!.id));
    expect((await admin.post(`${A}/channels`, { kind: 'slack', name: 'Slack', webhookUrl: 'https://evil.example/hook' })).status).toBe(400);
  });

  it('retries failed deliveries with backoff and gives up after the limit', async () => {
    hook.fail = true;
    await ok(admin.post(`${A}/channels/${ids.webhook}/test`));
    await deliverDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, allowPrivate: true });
    const [n] = await ctx.db.select().from(notifications).where(sql`${notifications.event} = 'test' and ${notifications.channelId} = ${ids.webhook}`);
    expect(n).toMatchObject({ status: 'pending', attempts: 1 });
    expect(n!.lastError).toBe('HTTP 500 from the receiver'); // the receiver's body is not stored
    expect(n!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await ctx.db.update(notifications).set({ attempts: 5, nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(notifications.id, n!.id));
    await deliverDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, allowPrivate: true });
    const [after] = await ctx.db.select().from(notifications).where(eq(notifications.id, n!.id));
    expect(after!.status).toBe('failed');
    hook.fail = false;
    const deliveries = await ok(noc.get(`${A}/notifications?channelId=${ids.webhook}`));
    expect(deliveries.some((d: { status: string }) => d.status === 'failed')).toBe(true);
  });

  it('closes a rule’s alerts when the rule is changed or deleted', async () => {
    await ok(noc.delete(`${A}/rules/${ids.slowRule}`));
    const left = (await ok(noc.get(`${A}?status=firing`))).items.filter((a: { ruleName: string }) => a.ruleName.startsWith('Uplink hot (150'));
    expect(left).toEqual([]);
  });
});

describe('live stream', () => {
  async function cookieFor(email: string) {
    const port = (ctx.app.getHttpServer().address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  function open(cookie: string) {
    const port = (ctx.app.getHttpServer().address() as AddressInfo).port;
    const chunks: string[] = [];
    const ac = new AbortController();
    const done = fetch(`http://127.0.0.1:${port}/api/v1/monitoring/stream`, { headers: { cookie, accept: 'text/event-stream' }, signal: ac.signal })
      .then(async (res) => {
        chunks.push(`status:${res.status};type:${res.headers.get('content-type')}\n`);
        const reader = res.body!.getReader();
        for (;;) {
          const { value, done: d } = await reader.read();
          if (d) break;
          chunks.push(Buffer.from(value).toString());
        }
      })
      .catch(() => undefined);
    return { text: () => chunks.join(''), close: () => (ac.abort(), done) };
  }
  const waitFor = async (f: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  };

  it('relays rates to staff and only visible ports to customers; alerts only to staff', async () => {
    const staff = open(await cookieFor(ctx.emails.noc));
    const cust = open(await cookieFor(ctx.emails.acmeAdmin));
    await waitFor(() => staff.text().includes('event: hello') && cust.text().includes('event: hello'));
    expect(staff.text()).toContain('type:text/event-stream');
    const pub = new Redis(process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379');
    const port = (id: string, bps: number) => ({ interfaceId: id, inBps: bps, outBps: 0, utilIn: null, utilOut: null, errorsPs: null, discardsPs: null, operUp: true, skip: null });
    await pub.publish(monitoringChannel(ctx.org.id), JSON.stringify({ type: 'rates', deviceId: ids.sw, at: new Date().toISOString(), ok: true, ports: [port(ids.swif.ether1, 1234), port(ids.swif.bond1, 999)] }));
    await pub.publish(monitoringChannel(ctx.org.id), JSON.stringify({ type: 'rates', deviceId: ids.r1, at: new Date().toISOString(), ok: true, ports: [port(ids.if.ether1, 777)] }));
    await pub.publish(monitoringChannel(ctx.org.id), JSON.stringify({ type: 'alert', alertId: 'x', status: 'firing', severity: 'critical', deviceId: ids.r1, interfaceId: null, message: 'secret-ish', suppressed: false }));
    await pub.publish(monitoringChannel('00000000-0000-0000-0000-000000000000'), JSON.stringify({ type: 'rates', deviceId: 'other-org', at: '', ok: true, ports: [port(ids.swif.ether1, 5555)] }));
    await waitFor(() => staff.text().includes('secret-ish') && cust.text().includes('1234'));
    await new Promise((r) => setTimeout(r, 200));
    pub.disconnect();
    await staff.close();
    await cust.close();
    expect(staff.text()).toContain('1234');
    expect(staff.text()).toContain('777');
    expect(staff.text()).toContain('event: alert');
    expect(cust.text()).toContain('1234');
    expect(cust.text()).not.toContain('999'); // bond1 is not cabled to Acme
    expect(cust.text()).not.toContain('777');
    expect(cust.text()).not.toContain('secret-ish');
    expect(staff.text()).not.toContain('5555'); // other organization
  });

  it('limits concurrent streams per user', async () => {
    const cookie = await cookieFor(ctx.emails.opsAdmin);
    const streams = Array.from({ length: 10 }, () => open(cookie));
    await waitFor(() => streams.every((x) => x.text().includes('event: hello')));
    const extra = await fetch(`http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}/api/v1/monitoring/stream`, { headers: { cookie } });
    expect(extra.status).toBe(503);
    await Promise.all(streams.map((x) => x.close()));
  });

  it('refuses the stream without monitoring.read', async () => {
    const r = await fetch(`http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}/api/v1/monitoring/stream`);
    expect(r.status).toBe(401);
  });

  it('the overview gets measured bandwidth and alert counts', async () => {
    const o = await ok(admin.get('/api/v1/overview/bandwidth'));
    expect(o.now).toMatchObject({ ports: 2 });
    expect(o.alerts).toHaveProperty('firing');
    expect(await ok(admin.get('/api/v1/overview/bandwidth'))).not.toBeNull();
  });
});

describe('collector counters from the other vendor APIs (mocks)', () => {
  it('RouterOS API, FortiOS and NX-API return 64-bit counters', async () => {
    const fx = structuredClone(ROUTEROS_FIXTURE) as Record<string, unknown>;
    (fx['/rest/interface'] as Record<string, string>[])[0]!['rx-byte'] = '18446744073709551000';
    const api: MockApi = await startRouterOsApi('ro', 'api-pass-123', fx);
    try {
      const s = await routerOsApiAdapter().counters!({ host: '127.0.0.1', port: api.port, username: 'ro', params: { tls: false, timeoutMs: 2000 }, secret: { password: 'api-pass-123' } });
      expect(s.interfaces.find((i) => i.name === 'ether1')).toMatchObject({ inOctets: 18446744073709551000n, bits: 64, operUp: true });
      expect(s.uptimeSeconds).toBe(2 * 7 * 86400 + 3 * 86400 + 4 * 3600 + 5 * 60 + 6);
      expect(api.commands.map((c) => c[0]).every((c) => c === '/login' || c!.endsWith('/print'))).toBe(true);
    } finally {
      await api.close();
    }
    const fo = structuredClone(FORTIOS_FIXTURE) as Record<string, { results: Record<string, Record<string, unknown>> }>;
    const mon = fo['/api/v2/monitor/system/interface']!.results;
    const first = Object.keys(mon)[0]!;
    Object.assign(mon[first]!, { rx_bytes: 123456789012, tx_bytes: 5, rx_packets: 10, tx_packets: 11, rx_errors: 1, tx_errors: 0 });
    const forti = await startFortiOs('forti-token-123456', fo as typeof FORTIOS_FIXTURE);
    try {
      const s = await fortiOsAdapter().counters!({ host: '127.0.0.1', port: forti.port, params: { scheme: 'http' }, secret: { token: 'forti-token-123456' } });
      expect(s.interfaces.find((i) => i.name === first)).toMatchObject({ inOctets: 123456789012n, outOctets: 5n, inErrors: 1n });
      expect(s.uptimeSeconds).toBeNull();
      expect(forti.requests.every((q) => q.method === 'GET')).toBe(true);
    } finally {
      await forti.close();
    }
    const nx = structuredClone(NXOS_FIXTURE) as Record<string, { TABLE_interface: { ROW_interface: Record<string, unknown>[] } }>;
    Object.assign(nx['show interface']!.TABLE_interface.ROW_interface[1]!, { eth_inbytes: '99999999999', eth_outbytes: '7', eth_inerr: '2', eth_indiscard: '3' });
    const sw = await startNxApi('admin', 'nx-pass-123', nx as typeof NXOS_FIXTURE);
    try {
      const s = await nxApiAdapter().counters!({ host: '127.0.0.1', port: sw.port, username: 'admin', params: { scheme: 'http' }, secret: { password: 'nx-pass-123' } });
      expect(s.interfaces.find((i) => i.name === 'Ethernet1/1')).toMatchObject({ inOctets: 99999999999n, outOctets: 7n, inErrors: 2n, inDiscards: 3n, speedBps: 10e9, operUp: true });
      // SVIs and ports without byte counters are skipped rather than reported as zero
      expect(s.interfaces.find((i) => i.name === 'Vlan100')).toBeUndefined();
    } finally {
      await sw.close();
    }
  });

  it('pollDue runs on its own: no browser or API client is involved', async () => {
    clock.t += 3600_000;
    const outcomes = await pollDue({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, now }, { concurrency: 4 });
    // r2's polling was removed above
    expect(outcomes.map((o) => o.deviceId).sort()).toEqual([ids.r1, ids.sw].sort());
  });
});

