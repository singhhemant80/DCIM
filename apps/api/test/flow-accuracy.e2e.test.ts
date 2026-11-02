/**
 * Flow accuracy: a router exporting long flows only every 30 minutes, part of
 * its traffic outside IPAM, and flow totals far below its uplink counters —
 * found from the records and the interface counters, with the fix.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFlowCollector } from '../src/worker/flows/collector';
import { encodeTemplated } from '../src/worker/flows/encode';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined } as never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201, 204].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
});
afterAll(async () => {
  await ctx?.close();
});

describe('flow accuracy', () => {
  it('finds the 30-minute timeout, traffic outside IPAM and low coverage against the uplink counters', async () => {
    await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '103.150.120.0/24' }));
    const mfr = (await ok(admin.post('/api/v1/dcim/manufacturers', { name: 'MikroTik FA' }))).id;
    const model = (await ok(admin.post('/api/v1/dcim/models', { manufacturerId: mfr, name: 'CCR2116 FA', category: 'router', uHeight: 1, fullDepth: false }))).id;
    const dev = (await ok(admin.post('/api/v1/dcim/devices', { modelId: model, assetTag: 'EDGE-FA', hostname: 'edge-fa', initialState: 'inventory' }))).id;
    const org = (await ctx.db.execute<{ org_id: string }>(sql`select org_id from devices where id = ${dev}`)).rows[0]!.org_id;
    const iface = (await ctx.db.execute<{ id: string }>(sql`insert into interfaces (org_id, device_id, name, kind) values (${org}, ${dev}, 'sfp-sfpplus1', 'physical') returning id`)).rows[0]!.id;
    // Uplink counters 35–65 minutes ago: 80 Mbit/s down, 8 Mbit/s up.
    const now = Date.now();
    for (let m = 30; m <= 70; m++)
      await ctx.db.execute(sql`insert into interface_rates (interface_id, at, seconds, org_id, device_id, in_bps, out_bps) values (${iface}, ${new Date(now - m * 60_000).toISOString()}::timestamptz, 60, ${org}, ${dev}, 80000000, 8000000)`);
    const exp = await ok(admin.post('/api/v1/monitoring/flows/exporters', { name: 'edge-fa', address: '127.0.0.1', deviceId: dev, liveInterface: 'sfp-sfpplus1', liveDirection: 'uplink' }));

    const collector = await startFlowCollector({ db: ctx.db, logger: silent }, { port: 0, bind: '127.0.0.1' });
    // Four 30-minute flows (reported only when the timeout expires) carrying ~20% of the uplink's download,
    // one short flow, and transit between two outside addresses.
    const counterDown = (80e6 / 8) * 1800;
    const long = [0, 1, 2, 3].map((i) => ({ src: '8.8.8.8', dst: `103.150.120.${10 + i}`, bytes: Math.round((counterDown * 0.2) / 4), packets: 1000, start: now - 65 * 60_000, end: now - 35 * 60_000 }));
    collector.receive(
      encodeTemplated(
        10,
        [...long, { src: '103.150.120.10', dst: '1.1.1.1', bytes: 5_000_000, packets: 100, start: now - 5000, end: now - 1000 }, { src: '9.9.9.9', dst: '1.0.0.1', bytes: 2_000_000_000, packets: 100, start: now - 5000, end: now - 1000 }],
        { sysUptimeMs: 1e8, nowMs: now, sysInit: true },
      ),
      '127.0.0.1',
    );
    await collector.flush(true);
    await collector.close();

    const r = await ok(admin.get('/api/v1/monitoring/flows/exporters'));
    const e = r.exporters.find((x: { id: string }) => x.id === exp.id);
    expect(e.diagnostics).toMatchObject({ records: 6, longestSeconds: 1800, atLongestRecords: 4, ipv6Records: 0 });
    expect(e.accuracy.level).toBe('critical');
    expect(e.accuracy.findings.map((f: { code: string }) => f.code)).toEqual(['long_active_timeout', 'outside_ipam', 'no_ipv6', 'coverage_low']);
    expect(e.accuracy.findings[0].fix).toEqual(['/ip traffic-flow set active-flow-timeout=1m inactive-flow-timeout=15s']);
    expect(e.accuracy.findings[0].text).toMatch(/every ~30 min/);
    expect(e.accuracy.coverage.download).toBeGreaterThan(0.15);
    expect(e.accuracy.coverage.download).toBeLessThan(0.25);
    expect(e.accuracy.findings[3].causes[0]).toMatch(/active flow timeout/);
  });
});
