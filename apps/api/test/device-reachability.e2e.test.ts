/**
 * Rack elevation reachability: the worker pings each in-service device's
 * management address; the elevation shows up / down, and "unknown" with the
 * reason whenever there is no recent result (never guessed as down).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceReachability, devices } from '../src/db/schema';
import { checkDueDevices, pingTarget } from '../src/worker/monitoring/device-ping';
import type { Pinger } from '../src/worker/monitoring/ping';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
const ids: Record<string, string> = {};
const V = '/api/v1/dcim';
const silent = { warn: () => undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
async function device(tag: string, u: number, state: string, mgmtAddress: string | null) {
  const id = (await ok(admin.post(`${V}/devices`, { modelId: ids.model, assetTag: tag, initialState: 'inventory' }))).id as string;
  await ok(admin.post(`${V}/devices/${id}/placement`, { rackId: ids.rack, positionU: u, face: 'front' }));
  await ctx.db.update(devices).set({ lifecycleState: state as 'active', mgmtAddress }).where(eq(devices.id, id));
  return id;
}
const elevation = async () => {
  const e = await ok(admin.get(`${V}/racks/${ids.rack}/elevation`));
  return Object.fromEntries(e.devices.map((d: { assetTag: string; reachability: unknown }) => [d.assetTag, d.reachability]));
};
const due = async () => ctx.db.update(deviceReachability).set({ checkedAt: new Date(Date.now() - 120_000) });

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  const dc = (await ok(admin.post(`${V}/datacenters`, { code: 'pin1', name: 'Ping DC' }))).id;
  const b = (await ok(admin.post(`${V}/buildings`, { datacenterId: dc, name: 'B' }))).id;
  const room = (await ok(admin.post(`${V}/rooms`, { buildingId: b, name: 'R', gridCols: 4, gridRows: 4 }))).id;
  ids.rack = (await ok(admin.post(`${V}/racks`, { roomId: room, name: 'P01', uHeight: 42, gridX: 0, gridY: 0 }))).id;
  const m = (await ok(admin.post(`${V}/manufacturers`, { name: 'Dell P' }))).id;
  ids.model = (await ok(admin.post(`${V}/models`, { manufacturerId: m, name: 'R640 P', category: 'server', uHeight: 1, depthMm: 750, fullDepth: true }))).id;
  ids.up = await device('UP-1', 40, 'active', '163.5.191.7');
  ids.down = await device('DOWN-1', 38, 'active', 'https://198.51.100.9:443/');
  ids.noaddr = await device('NOADDR-1', 36, 'active', null);
  ids.stock = await device('STOCK-1', 34, 'received', '198.51.100.20');
  ids.bad = await device('BAD-1', 32, 'active', '-f evil');
});
afterAll(async () => ctx?.close());

describe('pingTarget', () => {
  it('keeps IPs and host names, reduces URLs and host:port, refuses anything else', () => {
    expect(pingTarget('163.5.191.7')).toBe('163.5.191.7');
    expect(pingTarget('https://163.5.191.7:443/redfish')).toBe('163.5.191.7');
    expect(pingTarget('idrac.example.net:443')).toBe('idrac.example.net');
    expect(pingTarget('[2001:db8::1]')).toBe('2001:db8::1');
    expect(pingTarget('-f')).toBeNull();
    expect(pingTarget('a b')).toBeNull();
    expect(pingTarget('')).toBeNull();
  });
});

describe('rack elevation reachability', () => {
  it('pings only in-service devices with an address, retrying once before "down"', async () => {
    const asked: string[] = [];
    const ping: Pinger = async (ip) => (asked.push(ip), ip === '163.5.191.7' ? { reachable: true, rttMs: 0.8 } : { reachable: false, rttMs: null });
    const r = await checkDueDevices({ db: ctx.db, logger: silent, ping });
    expect(r).toEqual({ checked: 3, up: 1 });
    // The unreachable one was tried twice; the device in stock and the one without an address were not checked.
    expect(asked.sort()).toEqual(['163.5.191.7', '198.51.100.9', '198.51.100.9']);
    const e = await elevation();
    expect(e['UP-1']).toMatchObject({ state: 'up', rttMs: 0.8 });
    expect(e['DOWN-1']).toMatchObject({ state: 'down', rttMs: null, lastSeenAt: null });
    expect(e['NOADDR-1']).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/no management address/) });
    expect(e['STOCK-1']).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/not in service/) });
    // A value that isn't an address is never passed to ping, and isn't shown as down.
    expect(e['BAD-1']).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/not an IP address or host name/) });
    // Not due again within the minute.
    expect((await checkDueDevices({ db: ctx.db, logger: silent, ping })).checked).toBe(0);
  });

  it('a lost first echo does not flip a device to down', async () => {
    await due();
    let n = 0;
    const flaky: Pinger = async (ip) => (ip === '163.5.191.7' && n++ === 0 ? { reachable: false, rttMs: null } : { reachable: ip === '163.5.191.7', rttMs: 1 });
    await checkDueDevices({ db: ctx.db, logger: silent, ping: flaky });
    expect((await elevation())['UP-1'].state).toBe('up');
  });

  it('records when it went down and when it last answered', async () => {
    await due();
    await checkDueDevices({ db: ctx.db, logger: silent, ping: async () => ({ reachable: false, rttMs: null }) });
    const e = await elevation();
    expect(e['UP-1'].state).toBe('down');
    expect(e['UP-1'].lastSeenAt).toBeTruthy();
    expect(new Date(e['UP-1'].changedAt).getTime()).toBeGreaterThan(new Date(e['UP-1'].lastSeenAt).getTime() - 1000);
  });

  it('a broken ping or an old result shows unknown, not down', async () => {
    await due();
    await checkDueDevices({ db: ctx.db, logger: silent, ping: async () => { throw new Error('The ping command is not installed on the worker host (apt install iputils-ping)'); } });
    expect((await elevation())['UP-1']).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/not installed/) });
    await ctx.db.update(deviceReachability).set({ error: null, reachable: true, checkedAt: new Date(Date.now() - 3_600_000) });
    expect((await elevation())['UP-1']).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/No recent check/) });
  });
});
