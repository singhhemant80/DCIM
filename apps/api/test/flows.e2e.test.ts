/**
 * Bandwidth per IP address from flow records: real UDP datagrams (NetFlow v5,
 * v9, IPFIX like MikroTik Traffic Flow) into the worker's collector, then the
 * ranking and history through the API, with tenancy.
 */
import { createSocket } from 'node:dgram';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startFlowCollector, applyFlowRetention } from '../src/worker/flows/collector';
import { encodeTemplated, encodeV5, type SimFlow } from '../src/worker/flows/encode';
import { REDIS } from '../src/redis/redis';
import { flowLiveKey } from '../src/health/worker-heartbeat';
import type Redis from 'ioredis';
import { SecretBox } from '../src/common/secret-box';
import { createTorchLoop, torchRates } from '../src/worker/flows/torch';
import { startRouterOsApi } from './simulators/routeros-api';
import { BlockList } from 'node:net';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let globex: Client;
let collector: Awaited<ReturnType<typeof startFlowCollector>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const I = '/api/v1/ipam';
const F = '/api/v1/monitoring/flows';
const PORT = 20100 + Math.floor(Math.random() * 500);
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** Sends datagrams from 127.0.0.1 (the registered exporter) to the collector's real UDP port. */
async function send(...packets: Buffer[]) {
  const s = createSocket('udp4');
  for (const p of packets) await new Promise<void>((r, j) => s.send(p, PORT, '127.0.0.1', (e) => (e ? j(e) : r())));
  s.close();
  await new Promise((r) => setTimeout(r, 150));
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  // Acme's /29 inside our /24; one address with a DNS name; Globex has its own /30.
  await ok(admin.post(`${I}/prefixes`, { prefix: '103.150.120.0/24' }));
  await ok(admin.post(`${I}/prefixes`, { prefix: '103.150.120.8/29', customerId: ctx.customers.acme }));
  await ok(admin.post(`${I}/prefixes`, { prefix: '103.150.120.16/30', customerId: ctx.customers.globex }));
  await ok(admin.post(`${I}/prefixes`, { prefix: '2001:db8:10::/48' }));
  await ok(admin.post(`${I}/addresses`, { address: '103.150.120.10', status: 'allocated', dnsName: 'web.acme.example', customerId: ctx.customers.acme }));
  collector = await startFlowCollector({ db: ctx.db, logger: silent }, { port: PORT, bind: '127.0.0.1' });
});

afterAll(async () => {
  await collector?.close();
  await ctx?.close();
});

describe('exporters', () => {
  it('only registered routers are accepted; the others are listed as unknown sources', async () => {
    await send(encodeV5([{ src: '8.8.8.8', dst: '103.150.120.10', bytes: 1000, packets: 1, start: Date.now() - 1000, end: Date.now() }], { sysUptimeMs: 1e6, nowMs: Date.now() }));
    await collector.flush();
    expect(collector.status().unknownSources.map((u) => u.address)).toContain('127.0.0.1');
    expect((await ok(admin.get(`${F}/top?range=15m`))).items).toEqual([]);

    // Customers and read-only staff cannot register exporters.
    expect((await acme.post(`${F}/exporters`, { name: 'x', address: '127.0.0.1' })).status).toBe(403);
    expect((await noc.post(`${F}/exporters`, { name: 'x', address: '127.0.0.1' })).status).toBe(403);
    expect((await admin.post(`${F}/exporters`, { name: 'x', address: 'not-an-ip' })).status).toBe(400);
    ids.exp = (await ok(admin.post(`${F}/exporters`, { name: 'edge-rtr-01', address: '127.0.0.1' }))).id;
    expect((await admin.post(`${F}/exporters`, { name: 'dup', address: '127.0.0.1' })).status).toBe(409);
    await collector.reload();
  });
});

describe('ranking from NetFlow v5, v9 and IPFIX', () => {
  it('download is traffic to the address, upload from it; internet addresses are not kept', async () => {
    const now = Date.now();
    const up = 9_000_000;
    const v5: SimFlow[] = [
      { src: '8.8.8.8', dst: '103.150.120.10', bytes: 6_000_000, packets: 4000, start: now - 30_000, end: now - 2_000 },
      { src: '103.150.120.10', dst: '8.8.8.8', bytes: 500_000, packets: 900, start: now - 30_000, end: now - 2_000 },
      { src: '1.1.1.1', dst: '9.9.9.9', bytes: 123, packets: 1, start: now - 1000, end: now - 500 }, // neither is ours
    ];
    const v9: SimFlow[] = [{ src: '103.150.120.17', dst: '1.1.1.1', bytes: 9_000_000, packets: 7000, start: now - 20_000, end: now - 1_000 }];
    const ipfix: SimFlow[] = [
      { src: '104.16.0.1', dst: '103.150.120.50', bytes: 2_000_000, packets: 1500, start: now - 10_000, end: now - 1_000 },
      { src: '2606:4700::1', dst: '2001:db8:10::25', bytes: 3_000_000, packets: 2000, start: now - 10_000, end: now - 1_000 },
    ];
    // v9/IPFIX data before its template is unreadable and ignored; the template packet follows.
    await send(encodeTemplated(9, v9, { sysUptimeMs: up, nowMs: now, withTemplate: false }));
    await send(encodeV5(v5, { sysUptimeMs: up, nowMs: now }), encodeTemplated(9, v9, { sysUptimeMs: up, nowMs: now }), encodeTemplated(10, ipfix, { sysUptimeMs: up, nowMs: now }));
    await send(Buffer.from('this is not a flow packet'));
    await collector.flush();

    const top = await ok(admin.get(`${F}/top?range=15m&sort=download`));
    expect(top.items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.10', '2001:db8:10::25', '103.150.120.50', '103.150.120.17']);
    const web = top.items[0];
    expect(web).toMatchObject({ inBytes: 6_000_000, outBytes: 500_000, inPackets: 4000, dnsName: 'web.acme.example', prefix: '103.150.120.8/29', customerName: 'Acme' });
    // Averaged over the minutes that have flow data (not the whole 15 minutes, most of which had none yet).
    expect(web.inBps).toBeCloseTo((6_000_000 * 8) / top.range.averagedSeconds, 0);
    expect(top.range.averagedSeconds).toBeLessThanOrEqual(900);
    expect(top.range.averagedSeconds).toBeGreaterThanOrEqual(60);
    expect(top.items.find((x: { ip: string }) => x.ip === '103.150.120.17')).toMatchObject({ inBytes: 0, outBytes: 9_000_000, customerName: 'Globex' });
    expect(top.totals).toMatchObject({ addresses: 4, inBytes: 11_000_000, outBytes: 9_500_000 });
    // Upload ranking.
    expect((await ok(admin.get(`${F}/top?range=15m&sort=upload&limit=1`))).items[0].ip).toBe('103.150.120.17');
    // Search by DNS name or customer.
    expect((await ok(admin.get(`${F}/top?range=15m&q=globex`))).items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.17']);
    // One customer only (staff filter).
    expect((await ok(admin.get(`${F}/top?range=15m&customerId=${ctx.customers.acme}`))).items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.10']);

    // What the collector saw from the exporter.
    const ex = await ok(admin.get(`${F}/exporters`));
    expect(ex.exporters[0]).toMatchObject({ name: 'edge-rtr-01', address: '127.0.0.1', receiving: true, badPackets: 1, unmatchedRecords: 1 });
    expect(ex.exporters[0].records).toBe(6);
  });

  it('customers only see their own addresses, without customer names', async () => {
    const mine = await ok(acme.get(`${F}/top?range=15m`));
    expect(mine.items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.10']);
    expect(mine.items[0].customerName).toBeNull();
    expect(mine.totals.addresses).toBe(1);
    expect((await ok(globex.get(`${F}/top?range=15m`))).items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.17']);
    // Asking for another customer's filter or address changes nothing / is not found.
    expect((await ok(acme.get(`${F}/top?range=15m&customerId=${ctx.customers.globex}`))).items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.10']);
    expect((await acme.get(`${F}/ips/103.150.120.17/history?range=1h`)).status).toBe(404);
    expect((await acme.get(`${F}/exporters`)).status).toBe(403);
  });

  it('history of one address, per minute', async () => {
    const h = await ok(admin.get(`${F}/ips/103.150.120.10/history?range=1h`));
    expect(h).toMatchObject({ ip: '103.150.120.10', stepSeconds: 60, dnsName: 'web.acme.example', totals: { inBytes: 6_000_000, outBytes: 500_000 } });
    expect(h.points.length).toBeGreaterThanOrEqual(1);
    const sum = h.points.reduce((a: number, p: { inBps: number }) => a + (p.inBps * 60) / 8, 0);
    expect(sum).toBeCloseTo(6_000_000, -1);
    expect((await ok(acme.get(`${F}/ips/103.150.120.10/history?range=1h`))).totals.inBytes).toBe(6_000_000);
    expect((await admin.get(`${F}/ips/not-an-ip/history`)).status).toBe(400);
    // The hourly table has the same totals (7-day range reads it).
    expect((await ok(admin.get(`${F}/ips/103.150.120.10/history?range=7d`))).totals.inBytes).toBe(6_000_000);
  });

  it('live: rates over the last minute, published by the collector; customers see their own', async () => {
    const redis = ctx.app.get<Redis>(REDIS);
    if (redis.status === 'wait') await redis.connect();
    const live = await startFlowCollector(
      { db: ctx.db, logger: silent, onLive: (orgId, snap) => void redis.set(flowLiveKey(orgId), JSON.stringify(snap), 'EX', 30) },
      { port: 0, bind: '127.0.0.1' },
    );
    const now = Date.now();
    live.receive(encodeV5([{ src: '8.8.8.8', dst: '103.150.120.10', bytes: 3_000_000, packets: 10, start: now - 2000, end: now - 1000 }, { src: '103.150.120.17', dst: '1.1.1.1', bytes: 9_000_000, packets: 10, start: now - 2000, end: now - 1000 }], { sysUptimeMs: 1e6, nowMs: now }), '127.0.0.1');
    live.publishLive();
    await new Promise((r) => setTimeout(r, 100));
    const all = await ok(admin.get(`${F}/live?sort=upload`));
    expect(all.at).toBeTruthy();
    expect(all.items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.17', '103.150.120.10']);
    expect(all.items[0]).toMatchObject({ customerName: 'Globex' });
    expect(all.items[0].outBps).toBeGreaterThan(0);
    expect((await ok(admin.get(`${F}/live?sort=download`))).items[0]).toMatchObject({ ip: '103.150.120.10', dnsName: 'web.acme.example' });
    const mine = await ok(acme.get(`${F}/live`));
    expect(mine.items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.10']);
    expect(mine.items[0].customerName).toBeNull();
    await live.close();
  });

  it('a configured sampling rate multiplies the counts; disabled exporters are ignored', async () => {
    await ok(admin.put(`${F}/exporters/${ids.exp}`, { name: 'edge-rtr-01', address: '127.0.0.1', samplingRate: 10 }));
    await collector.reload();
    const now = Date.now();
    await send(encodeV5([{ src: '8.8.4.4', dst: '103.150.120.51', bytes: 1000, packets: 2, start: now - 2000, end: now - 1000 }], { sysUptimeMs: 1e6, nowMs: now }));
    await collector.flush();
    expect((await ok(admin.get(`${F}/top?range=15m&q=103.150.120.51`))).items[0].inBytes).toBe(10_000);

    await ok(admin.put(`${F}/exporters/${ids.exp}`, { name: 'edge-rtr-01', address: '127.0.0.1', samplingRate: 10, enabled: false }));
    await collector.reload();
    await send(encodeV5([{ src: '8.8.4.4', dst: '103.150.120.51', bytes: 1000, packets: 2, start: now - 2000, end: now - 1000 }], { sysUptimeMs: 1e6, nowMs: now }));
    await collector.flush();
    expect((await ok(admin.get(`${F}/top?range=15m&q=103.150.120.51`))).items[0].inBytes).toBe(10_000);
  });

  it('retention removes old per-minute data; deleting an exporter is audited', async () => {
    await ctx.db.execute(`insert into ip_traffic_1m (org_id, bucket, address, in_bytes) select org_id, now() - interval '9 days', address, 1 from ip_traffic_1m limit 1` as never);
    const r = await applyFlowRetention(ctx.db);
    expect(r.minute).toBe(1);
    expect((await admin.delete(`${F}/exporters/${ids.exp}`)).status).toBe(204);
    const audit = await ok(admin.get('/api/v1/audit?action=flow_exporter.delete'));
    expect(audit.items.length).toBe(1);
  });
});

describe('real time (MikroTik Torch over the RouterOS API)', () => {
  it('direction is relative to the watched interface', () => {
    const own = new BlockList();
    own.addSubnet('103.150.120.0', 24, 'ipv4');
    const rows = [{ 'src-address': '8.8.8.8', 'dst-address': '103.150.120.10', rx: '9000', tx: '100' }];
    expect(torchRates(rows, own, 'uplink').get('103.150.120.10')).toEqual([9000, 100]);
    expect(torchRates(rows, own, 'downlink').get('103.150.120.10')).toEqual([100, 9000]);
  });

  it('streams per-second rates per address while someone watches, and stops when nobody does', async () => {
    const ros = await startRouterOsApi('dcim-ro', 'api-pass-123', undefined, {
      torch: {
        everyMs: 200,
        rows: [
          { 'src-address': '142.250.183.14', 'dst-address': '103.150.120.10', tx: 2_000_000, rx: 95_000_000 },
          { 'src-address': '103.150.120.17', 'dst-address': '1.1.1.1', tx: 40_000_000, rx: 1_000_000 },
          { 'src-address': '8.8.8.8', 'dst-address': '9.9.9.9', tx: 5, rx: 5 },
        ],
      },
    });
    try {
      const D = '/api/v1/dcim';
      const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'MikroTik' }))).id;
      const model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'CCR2004', category: 'router', uHeight: 1, fullDepth: false }))).id;
      const rtr = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'RTR-1', hostname: 'core-rtr', mgmtAddress: '127.0.0.1', initialState: 'inventory' }))).id;
      await ok(admin.put(`/api/v1/network/devices/${rtr}/credentials`, { kind: 'routeros_api', host: '127.0.0.1', port: ros.port, username: 'dcim-ro', password: 'api-pass-123', tls: false }));
      // An interface name with "=" could smuggle API words: refused.
      expect((await admin.post(`${F}/exporters`, { name: 'x', address: '10.9.9.9', liveInterface: 'sfp1=x' })).status).toBe(400);
      const ex = await ok(admin.post(`${F}/exporters`, { name: 'core-rtr', address: '127.0.0.2', deviceId: rtr, liveInterface: 'sfp-sfpplus1', liveDirection: 'uplink' }));
      expect((await ok(admin.get(`${F}/exporters`))).exporters.find((e: { id: string }) => e.id === ex.id)).toMatchObject({ liveInterface: 'sfp-sfpplus1', liveReady: true });

      const redis = ctx.app.get<Redis>(REDIS);
      if (redis.status === 'wait') await redis.connect();
      const tick = createTorchLoop({ db: ctx.db, secrets: ctx.app.get(SecretBox), redis, logger: silent });
      // Nobody watching: no connection to the router.
      expect(await tick()).toBe(0);
      expect(ros.commands.some((c) => c[0] === '/tool/torch')).toBe(false);
      expect((await acme.post(`${F}/live/watch`)).status).toBe(200);
      await tick();
      await new Promise((r) => setTimeout(r, 700));
      await tick();
      const torchCmd = ros.commands.find((c) => c[0] === '/tool/torch')!;
      expect(torchCmd).toEqual(expect.arrayContaining(['=interface=sfp-sfpplus1', '=src-address=0.0.0.0/0', '=dst-address=0.0.0.0/0']));
      // Nothing but login, torch and cancel is ever sent.
      expect(ros.commands.every((c) => ['/login', '/tool/torch', '/cancel'].includes(c[0]!))).toBe(true);

      const live = await ok(admin.get(`${F}/live?sort=download`));
      expect(live).toMatchObject({ source: 'realtime', windowSeconds: 1 });
      expect(live.routers[0]).toMatchObject({ name: 'core-rtr', ok: true });
      expect(live.items.map((x: { ip: string }) => [x.ip, x.inBps, x.outBps])).toEqual([
        ['103.150.120.10', 95_000_000, 2_000_000],
        ['103.150.120.17', 1_000_000, 40_000_000],
      ]);
      // Customers: their own address only, and no router details.
      const mine = await ok(acme.get(`${F}/live`));
      expect(mine.items.map((x: { ip: string }) => x.ip)).toEqual(['103.150.120.10']);
      expect(mine.routers).toEqual([]);

      // Nobody watching any more: the stream is cancelled.
      await redis.del('cdcim:flows:watch');
      await tick();
      await new Promise((r) => setTimeout(r, 200));
      expect(ros.commands.some((c) => c[0] === '/cancel')).toBe(true);
    } finally {
      await ros.close();
    }
  });
});
