/**
 * Upstream / IX peering check (e.g. a provider re-announcing your prefixes at
 * exchanges): the provider's AS-SET and your route objects in a simulated
 * IRRd, the BGP sessions and sent prefixes on a simulated MikroTik router,
 * and what simulated RIPE RIS sees. Read-only everywhere.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/common/secret-box';
import { pollDueRouting } from '../src/worker/routing/check';
import { irrClient } from '../src/worker/routing/irr';
import { ripeStat } from '../src/worker/routing/ripestat';
import { pollDueUpstreams } from '../src/worker/routing/upstreams';
import { Client, setupTestApp, type TestContext } from './helpers';
import { ROUTEROS_FIXTURE, startRouterOs } from './simulators/http-devices';
import { startIrrd } from './simulators/irrd';
import { startRipeStat, type MockRipeStat } from './simulators/ripestat';

let ctx: TestContext;
let admin: Client;
let ris: MockRipeStat;
let irrd: Awaited<ReturnType<typeof startIrrd>>;
let ros: Awaited<ReturnType<typeof startRouterOs>>;
const silent = { warn: () => undefined };
const ids: Record<string, string> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201, 204].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const worker = async () => {
  for (let i = 0; i < 10; i++) if (!Object.values(await pollDueRouting({ db: ctx.db, logger: silent, client: ripeStat(ris.url) })).some(Boolean)) break;
  while (await pollDueUpstreams({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, irr: irrClient(irrd.url) }));
};

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  ris = await startRipeStat();
  irrd = await startIrrd();
  ros = await startRouterOs('dcim-ro', 'ros-pass-1', {
    ...ROUTEROS_FIXTURE,
    '/rest/routing/bgp/session': [
      { name: 'transit-1', 'remote.address': '203.0.113.1', 'remote.as': '64500', established: 'true', uptime: '1d2h3m4s', 'prefix-count': '950000' },
      { name: 'joy-mum-1', 'remote.address': '103.27.171.230', 'remote.as': '152565', established: 'true', uptime: '3d4h', 'prefix-count': '12000' },
      { name: 'joy-del-1', 'remote.address': '103.162.77.5', 'remote.as': '152565', established: 'false', state: 'connect' },
    ],
    '/rest/routing/bgp/advertisements': [
      { peer: 'joy-mum-1', prefix: '45.10.20.0/22' },
      { peer: 'joy-mum-1', prefix: '2a0e:1000::/32' },
      { peer: 'transit-1', prefix: '45.10.30.0/24' },
    ],
  });
  for (const p of ['45.10.20.0/22', '45.10.21.0/24', '45.10.30.0/24', '2a0e:1000::/32']) ids[p] = (await ok(admin.post('/api/v1/ipam/prefixes', { prefix: p, status: p === '45.10.20.0/22' ? 'container' : 'active' }))).id;
  const mfr = (await ok(admin.post('/api/v1/dcim/manufacturers', { name: 'MikroTik U' }))).id;
  const model = (await ok(admin.post('/api/v1/dcim/models', { manufacturerId: mfr, name: 'CCR2216 U', category: 'router', uHeight: 1, fullDepth: false }))).id;
  ids.router = (await ok(admin.post('/api/v1/dcim/devices', { modelId: model, assetTag: 'EDGE-1', hostname: 'edge-r1', initialState: 'inventory' }))).id;
  await ctx.db.execute(sql`update devices set lifecycle_state = 'active' where id = ${ids.router}`);
  await ok(admin.put(`/api/v1/network/devices/${ids.router}/credentials`, { kind: 'routeros_rest', host: '127.0.0.1', port: ros.port, username: 'dcim-ro', password: 'ros-pass-1', scheme: 'http', timeoutMs: 2000 }));
});
afterAll(async () => {
  await ris?.close();
  await irrd?.close();
  await ros?.close();
  await ctx?.close();
});

describe('upstream and IX peering check', () => {
  it('Joy (IX peering): AS-SET, route objects, sessions, sent prefixes', async () => {
    await ok(admin.post('/api/v1/ipam/routing/asns', { asn: 210000, asSet: 'as-example' }));
    expect((await admin.post('/api/v1/ipam/routing/upstreams', { asn: 152565, name: 'Joy', asSet: 'not a set' })).status).toBe(400);
    await ok(admin.post('/api/v1/ipam/routing/upstreams', { asn: 152565, name: 'Joy Services', kind: 'ix_peering', asSet: 'AS152565:AS-JOYSVC' }));
    await ok(admin.post('/api/v1/ipam/routing/upstreams', { asn: 9498, name: 'Transit', kind: 'transit', asSet: 'AS-TRANSIT-CUST' }));
    await worker();
    // The router is only read: GET requests, never a change.
    expect(ros.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(irrd.queries).toEqual(expect.arrayContaining(['!iAS152565:AS-JOYSVC,1', '!iAS152565:AS-JOYSVC', '!gAS210000', '!6AS210000']));

    const o = await ok(admin.get('/api/v1/ipam/routing'));
    const joy = o.upstreams.find((u: { asn: number }) => u.asn === 152565);
    expect(o.asns[0].asSet).toBe('AS-EXAMPLE');
    expect(joy.data.irr).toMatchObject({ asSet: 'AS152565:AS-JOYSVC', found: true, size: 3, ourAsns: [{ asn: 210000, inSet: true, direct: false }], ourSetsListed: ['AS-EXAMPLE'] });
    expect(joy.data.routers).toEqual([
      expect.objectContaining({
        name: 'edge-r1',
        sessions: [expect.objectContaining({ name: 'joy-mum-1', state: 'established', prefixesReceived: 12000 }), expect.objectContaining({ name: 'joy-del-1', state: 'connect' })],
        advertised: ['2a0e:1000::/32', '45.10.20.0/22'],
      }),
    ]);
    const texts = joy.findings.map((f: { code: string }) => f.code);
    expect(texts).toEqual(['in_as_set', 'session_up', 'session_down', 'ris_via']);
    expect(joy.findings.find((f: { code: string }) => f.code === 'in_as_set').text).toMatch(/through AS-EXAMPLE/);
    expect(joy.findings.find((f: { code: string }) => f.code === 'ris_via').text).toMatch(/sees 1 of 2 announced prefixes through AS152565/);
    // Per prefix: the covered /24 pool is left out (it goes out inside the /22).
    const by = Object.fromEntries(joy.prefixes.map((x: { prefix: string }) => [x.prefix, x]));
    expect(Object.keys(by).sort()).toEqual(['2a0e:1000::/32', '45.10.20.0/22', '45.10.30.0/24']);
    expect(by['45.10.20.0/22']).toMatchObject({ level: 'ok', routeObject: 'exact', advertised: true, rpki: 'valid' });
    expect(by['45.10.30.0/24']).toMatchObject({ level: 'critical', routeObject: 'exact', advertised: false });
    expect(by['45.10.30.0/24'].notes).toContain('Your router does not send 45.10.30.0/24 to Joy Services');
    expect(by['2a0e:1000::/32']).toMatchObject({ level: 'critical', routeObject: 'none', advertised: true, seenVia: 1, rpki: 'unknown' });
    expect(joy.level).toBe('critical');

    const transit = o.upstreams.find((u: { asn: number }) => u.asn === 9498);
    expect(transit.findings.map((f: { code: string }) => f.code)).toEqual(['not_in_as_set', 'no_session', 'ris_not_via']);
    expect(transit.findings[0].text).toMatch(/AS210000 is not in AS-TRANSIT-CUST/);
  });

  it('no AS-SET and no routers: says what is missing; a set that does not exist is critical', async () => {
    const u = await ok(admin.post('/api/v1/ipam/routing/upstreams', { asn: 64777, name: 'Other IX', asSet: 'AS-NOPE' }));
    await ok(admin.put(`/api/v1/ipam/routing/upstreams/${u.id}`, { asn: 64777, name: 'Other IX', asSet: 'AS-NOPE' }));
    await ctx.db.execute(sql`update devices set lifecycle_state = 'retired' where id = ${ids.router}`);
    await worker();
    const o = await ok(admin.get('/api/v1/ipam/routing'));
    const x = o.upstreams.find((v: { asn: number }) => v.asn === 64777);
    expect(x.findings.map((f: { code: string }) => f.code)).toEqual(['as_set_missing', 'no_routers', 'ris_via']);
    await ok(admin.put(`/api/v1/ipam/routing/upstreams/${u.id}`, { asn: 64777, name: 'Other IX', asSet: null }));
    expect((await ok(admin.get('/api/v1/ipam/routing'))).upstreams.find((v: { asn: number }) => v.asn === 64777).findings[0].code).toBe('no_as_set');
    expect((await admin.delete(`/api/v1/ipam/routing/upstreams/${u.id}`)).status).toBe(204);
  });
});
