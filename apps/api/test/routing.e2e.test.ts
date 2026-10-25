/**
 * Global routing (BGP) check of IPAM prefixes against a simulated RIPEstat:
 * ASNs, origin, RPKI, IRR, visibility, upstreams; private and long prefixes
 * are never sent out; GET requests only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pollDueRouting } from '../src/worker/routing/check';
import { ripeStat } from '../src/worker/routing/ripestat';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startRipeStat, type MockRipeStat } from './simulators/ripestat';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let sim: MockRipeStat;
const ids: Record<string, string> = {};
const silent = { warn: () => undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201, 204].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const runAll = async () => {
  const deps = { db: ctx.db, logger: silent, client: ripeStat(sim.url) };
  for (let i = 0; i < 10; i++) {
    const r = await pollDueRouting(deps);
    if (!r.asns && !r.prefixes) break;
  }
};

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  sim = await startRipeStat();
  for (const p of ['45.10.20.0/22', '45.10.21.0/24', '45.10.21.0/26', '45.10.30.0/24', '45.10.40.0/24', '45.10.50.0/24', '2a0e:1000::/32', '10.20.0.0/16'])
    ids[p] = (await ok(admin.post('/api/v1/ipam/prefixes', { prefix: p, status: p === '45.10.20.0/22' ? 'container' : 'active' }))).id;
  ids.reserved = (await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '45.10.60.0/24', status: 'reserved' }))).id;
});
afterAll(async () => {
  await sim?.close();
  await ctx?.close();
});

describe('global routing check', () => {
  it('nothing is sent out until an ASN is entered', async () => {
    await runAll();
    expect(sim.requests).toEqual([]);
    const o = await ok(admin.get('/api/v1/ipam/routing'));
    expect(o.totals.prefixes).toBe(0);
    expect(o.items.find((x: { prefix: string }) => x.prefix === '45.10.30.0/24').skipReason).toBe('Add your ASN to check it');
  });

  it('checks public prefixes against our ASN, with a per-prefix expected origin', async () => {
    await ok(admin.post('/api/v1/ipam/routing/asns', { asn: 210000, name: 'Main' }));
    expect((await admin.post('/api/v1/ipam/routing/asns', { asn: 210000 })).status).toBe(400);
    await ok(admin.put(`/api/v1/ipam/prefixes/${ids['45.10.50.0/24']}`, { status: 'active', originAsn: 65010 }));
    await runAll();
    // Read-only, and never private, long or reserved prefixes.
    const sent = sim.requests.map((r) => r.params.resource + ' ' + (r.params.prefix ?? ''));
    expect(sent.some((x) => /^10\.20\.|45\.10\.21\.0\/26|45\.10\.60/.test(x))).toBe(false);
    expect(sim.requests.every((r) => r.params.sourceapp === 'nexoradc-dcim')).toBe(true);

    const o = await ok(admin.get('/api/v1/ipam/routing'));
    const by = Object.fromEntries(o.items.map((x: { prefix: string }) => [x.prefix, x]));
    expect(o.totals).toEqual({ prefixes: 6, ok: 3, warning: 0, critical: 3, pending: 0 });
    expect(by['45.10.20.0/22']).toMatchObject({ level: 'ok', data: { effective: { origins: [210000] }, upstreams: [{ asn: 3356, peers: 2 }, { asn: 1299 }, { asn: 6939 }] } });
    expect(by['45.10.21.0/24']).toMatchObject({ level: 'ok', data: { effective: { prefix: '45.10.20.0/22' } } });
    expect(by['45.10.30.0/24'].data.findings[0].code).toBe('not_announced');
    expect(by['45.10.40.0/24'].data.findings.map((f: { code: string }) => f.code)).toEqual(['wrong_origin', 'rpki_invalid']);
    expect(by['45.10.50.0/24']).toMatchObject({ level: 'ok', originAsn: 65010, data: { expectedAsns: [65010] } });
    expect(by['2a0e:1000::/32'].level).toBe('critical');
    expect(by['10.20.0.0/16']).toBeUndefined();
    expect(by['45.10.21.0/26']).toBeUndefined();
    expect(by['45.10.60.0/24']).toMatchObject({ checked: false, skipReason: 'Status reserved: not checked' });
    // The ASN: holder, what it announces now, and what is not in IPAM.
    expect(o.asns[0]).toMatchObject({ asn: 210000, data: { holder: 'EXAMPLE-NET - Example Networks', prefixes: ['2a0e:1000::/32', '45.10.20.0/22', '45.10.99.0/24'], v4Prefixes: 2, neighbours: 4 }, notInIpam: ['45.10.99.0/24'] });
    // On the prefix list and the prefix page.
    const list = await ok(admin.get('/api/v1/ipam/prefixes?vrfId=global'));
    expect(list.find((x: { prefix: string }) => x.prefix === '45.10.40.0/24').routing).toMatchObject({ level: 'critical', origins: [666] });
    expect((await ok(admin.get(`/api/v1/ipam/routing/prefixes/${ids['45.10.30.0/24']}`))).level).toBe('critical');
    expect((await ok(admin.get(`/api/v1/ipam/routing/prefixes/${ids['10.20.0.0/16']}`))).skipReason).toMatch(/Private/);
  });

  it('check now re-queues; checks are not repeated before they are due', async () => {
    const before = sim.requests.length;
    await runAll();
    expect(sim.requests.length).toBe(before);
    await ok(noc.post('/api/v1/ipam/routing/check', { prefixId: ids['45.10.30.0/24'] }));
    await runAll();
    expect(sim.requests.slice(before).map((r) => r.call)).toEqual(['routing-status', 'rpki-validation']);
  });

  it('RIPEstat unreachable: the error is kept and the last result stays', async () => {
    await ok(admin.post('/api/v1/ipam/routing/check', {}));
    await pollDueRouting({ db: ctx.db, logger: silent, client: ripeStat('http://127.0.0.1:9', fetch, 2000) }, 10);
    const o = await ok(admin.get('/api/v1/ipam/routing'));
    const x = o.items.find((i: { prefix: string }) => i.prefix === '45.10.20.0/22');
    expect(x.error).toMatch(/RIPEstat routing-status/);
    expect(x.level).toBe('ok');
  });

  it('staff only; ASNs need ipam.write', async () => {
    expect((await acme.get('/api/v1/ipam/routing')).status).toBe(403);
    expect((await noc.post('/api/v1/ipam/routing/asns', { asn: 65001 })).status).toBe(403);
    expect((await acme.get('/api/v1/ipam/prefixes')).body.every((x: { routing: unknown }) => x.routing === null)).toBe(true);
  });
});
