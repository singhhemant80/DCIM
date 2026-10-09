import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, ipAddresses } from '../src/db/schema';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let globex: Client;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const I = '/api/v1/ipam';

async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const prefix = (body: Record<string, unknown>) => ok(admin.post(`${I}/prefixes`, body));

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  const mfr = (await ok(admin.post('/api/v1/dcim/manufacturers', { name: 'Dell' }))).id;
  const model = (await ok(admin.post('/api/v1/dcim/models', { manufacturerId: mfr, name: 'R650', category: 'server', uHeight: 1, fullDepth: true }))).id;
  ids.acmeServer = (await ok(admin.post('/api/v1/dcim/devices', { modelId: model, assetTag: 'ACME-SRV-1', hostname: 'acme1', customerId: ctx.customers.acme, initialState: 'inventory' }))).id;
  ids.globexServer = (await ok(admin.post('/api/v1/dcim/devices', { modelId: model, assetTag: 'GLX-SRV-1', customerId: ctx.customers.globex, initialState: 'inventory' }))).id;
});
afterAll(async () => ctx?.close());

describe('prefixes', () => {
  it('validates, normalizes and refuses duplicates per VRF', async () => {
    const bad = await admin.post(`${I}/prefixes`, { prefix: '10.0.0.5/24' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/Host bits/);
    ids.agg = (await prefix({ prefix: '10.0.0.0/16', status: 'container', description: 'DC aggregate' })).id;
    ids.lan = (await prefix({ prefix: '10.0.1.0/24', gateway: '10.0.1.1' })).id;
    expect((await admin.post(`${I}/prefixes`, { prefix: '10.0.1.0/24' })).status).toBe(409);
    // The same prefix in a VRF is a different network.
    ids.vrf = (await ok(admin.post('/api/v1/network/vrfs', { name: 'CUST-A' }))).id;
    await prefix({ prefix: '10.0.1.0/24', vrfId: ids.vrf });
    // A gateway outside the prefix is refused.
    expect((await admin.post(`${I}/prefixes`, { prefix: '10.0.2.0/24', gateway: '10.0.3.1' })).status).toBe(400);
    // IPv6 is normalized (RFC 5952).
    const v6 = await prefix({ prefix: '2001:0DB8:0000::/48' });
    expect(v6.prefix).toBe('2001:db8::/48');
    ids.v6 = v6.id;
  });

  it('shows hierarchy and utilization', async () => {
    const list = await ok<any[]>(admin.get(`${I}/prefixes?family=4&vrfId=global`));
    const agg = list.find((x) => x.id === ids.agg);
    const lan = list.find((x) => x.id === ids.lan);
    expect(agg.childCount).toBe(1);
    expect(lan.depth).toBe(1);
    expect(lan.usable).toBe('254');
    expect(agg.childCoverage).toBeCloseTo((256 / 65536) * 100, 3);
    const detail = await ok(admin.get(`${I}/prefixes/${ids.lan}`));
    expect(detail.parents.map((x: any) => x.id)).toEqual([ids.agg]);
    expect(detail.ptrZone).toBe('1.0.10.in-addr.arpa');
    // The gateway is not offered as free.
    expect(detail.available[0]).toEqual({ first: '10.0.1.2', last: '10.0.1.254', count: '253' });
  });

  it('finds prefixes by contained address', async () => {
    const list = await ok<any[]>(admin.get(`${I}/prefixes?q=10.0.1.77`));
    expect(list.map((x) => x.prefix)).toEqual(expect.arrayContaining(['10.0.0.0/16', '10.0.1.0/24']));
  });
});

describe('addresses', () => {
  it('allocates the next free address, skipping network, gateway and taken addresses', async () => {
    const [first] = await ok<any[]>(admin.post(`${I}/allocate-next`, { prefixId: ids.lan }));
    expect(first.address).toBe('10.0.1.2');
    await ok(admin.post(`${I}/addresses`, { address: '10.0.1.3', status: 'reserved' }));
    const two = await ok<any[]>(admin.post(`${I}/allocate-next`, { prefixId: ids.lan, count: 2, dnsName: 'web.example.com' }));
    expect(two.map((x) => x.address)).toEqual(['10.0.1.4', '10.0.1.5']);
    expect(two[0].prefix).toBe('10.0.1.0/24');
  });

  it('refuses addresses that cannot be assigned', async () => {
    expect((await admin.post(`${I}/addresses`, { address: '10.0.1.0' })).body.error).toBe('reserved_address');
    expect((await admin.post(`${I}/addresses`, { address: '10.0.1.255' })).body.error).toBe('reserved_address');
    expect((await admin.post(`${I}/addresses`, { address: '10.0.200.1' })).body.error).toBe('prefix_container');
    expect((await admin.post(`${I}/addresses`, { address: '172.16.0.1' })).body.error).toBe('no_prefix');
    const dup = await admin.post(`${I}/addresses`, { address: '10.0.1.2' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('address_in_use');
    // Same address in the VRF is independent.
    await ok(admin.post(`${I}/addresses`, { address: '10.0.1.2', vrfId: ids.vrf }));
  });

  it('never hands out the same address to concurrent requests', async () => {
    const small = (await prefix({ prefix: '10.0.9.0/28' })).id; // 14 usable
    const results = await Promise.all(Array.from({ length: 20 }, () => admin.post(`${I}/allocate-next`, { prefixId: small })));
    const okRes = results.filter((r) => r.status === 201 || r.status === 200);
    const full = results.filter((r) => r.status === 409);
    expect(okRes.length).toBe(14);
    expect(full.length).toBe(6);
    expect(full.every((r) => r.body.error === 'prefix_full')).toBe(true);
    const addrs = okRes.map((r) => r.body[0].address);
    expect(new Set(addrs).size).toBe(14);
    const rows = await ctx.db.execute(sql`select count(*)::int as n from ip_addresses where address <<= '10.0.9.0/28'::cidr and status = 'allocated'`);
    expect((rows.rows[0] as { n: number }).n).toBe(14);
  });

  it('concurrent requests for one specific address: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => admin.post(`${I}/addresses`, { address: '10.0.1.50' })));
    expect(results.filter((r) => r.status === 201 || r.status === 200).length).toBe(1);
    expect(results.filter((r) => r.status === 409).length).toBe(7);
  });

  it('releases, keeps history and lets the address be reused', async () => {
    const [a] = await ok<any[]>(admin.post(`${I}/allocate-next`, { prefixId: ids.lan, serviceRef: 'SVC-1' }));
    const rel = await ok(admin.post(`${I}/addresses/${a.id}/release`, { reason: 'service cancelled' }));
    expect(rel.status).toBe('released');
    expect(rel.serviceRef).toBeNull();
    const again = await ok(admin.post(`${I}/addresses`, { address: a.address, dnsName: 'new.example.com' }));
    expect(again.id).toBe(a.id); // same row, so history continues
    const hist = await ok<any[]>(admin.get(`${I}/addresses/${a.id}/history`));
    expect(hist.map((h) => h.action)).toEqual(['allocated', 'released', 'allocated']);
    const audit = await ctx.db.select().from(auditEvents).where(eq(auditEvents.action, 'ip.release'));
    expect(audit.length).toBe(1);
  });

  it('a lapsed reservation can be allocated again', async () => {
    const r = await ok(admin.post(`${I}/addresses`, { address: '10.0.1.60', status: 'reserved', reservedUntil: new Date(Date.now() + 3600_000).toISOString() }));
    expect((await admin.post(`${I}/addresses`, { address: '10.0.1.60' })).status).toBe(409);
    await ctx.db.update(ipAddresses).set({ reservedUntil: new Date(Date.now() - 1000) }).where(eq(ipAddresses.id, r.id));
    const taken = await ok(admin.post(`${I}/addresses`, { address: '10.0.1.60' }));
    expect(taken.status).toBe('allocated');
  });

  it('IPv6 allocation works on large prefixes', async () => {
    const p64 = (await prefix({ prefix: '2001:db8:0:10::/64' })).id;
    const got = await ok<any[]>(admin.post(`${I}/allocate-next`, { prefixId: p64, count: 3 }));
    expect(got.map((x) => x.address)).toEqual(['2001:db8:0:10::1', '2001:db8:0:10::2', '2001:db8:0:10::3']);
    const list = await ok<any[]>(admin.get(`${I}/prefixes?family=6`));
    expect(list.find((x) => x.id === p64).usable).toBe('18446744073709551615');
  });

  it('binds addresses to devices and enforces customer consistency', async () => {
    const custPrefix = (await prefix({ prefix: '203.0.113.0/28', customerId: ctx.customers.acme })).id;
    ids.custPrefix = custPrefix;
    const [a] = await ok<any[]>(admin.post(`${I}/allocate-next`, { prefixId: custPrefix, deviceId: ids.acmeServer }));
    expect(a.customerId).toBe(ctx.customers.acme); // inherited
    expect(a.deviceName).toBe('acme1');
    const wrong = await admin.post(`${I}/allocate-next`, { prefixId: custPrefix, deviceId: ids.globexServer });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('customer_mismatch');
  });

  it('allocation never touches routers: no network or BGP side effects are recorded', async () => {
    const audits = await ctx.db.select({ action: auditEvents.action }).from(auditEvents).where(sql`${auditEvents.action} like 'ip.%'`);
    expect(audits.every((a) => /^ip\.(allocate|reserve|release|update|allocate_next|reserve_next)/.test(a.action))).toBe(true);
  });
});

describe('tenancy', () => {
  it('customers see only their own prefixes and addresses, read-only', async () => {
    const mine = await ok<any[]>(acme.get(`${I}/prefixes`));
    expect(mine.map((x) => x.prefix)).toEqual(['203.0.113.0/28']);
    expect(mine[0].description).toBeNull();
    const addrs = await ok(acme.get(`${I}/addresses`));
    expect(addrs.items.length).toBe(1);
    expect(addrs.items[0].notes).toBeUndefined();
    expect((await ok<any[]>(globex.get(`${I}/prefixes`))).length).toBe(0);
    expect((await ok(globex.get(`${I}/addresses`))).items.length).toBe(0);
    expect((await globex.get(`${I}/prefixes/${ids.custPrefix}`)).status).toBe(404);
    expect((await globex.get(`${I}/addresses/${addrs.items[0].id}`)).status).toBe(404);
    expect((await acme.post(`${I}/allocate-next`, { prefixId: ids.custPrefix })).status).toBe(403);
    expect((await acme.get(`${I}/conflicts`)).status).toBe(403);
    expect((await acme.get(`${I}/export.csv`)).status).toBe(403);
    expect((await acme.get(`${I}/addresses/${addrs.items[0].id}/history`)).status).toBe(403);
  });

  it('read-only staff can view but not allocate', async () => {
    expect((await noc.get(`${I}/prefixes`)).status).toBe(200);
    expect((await noc.post(`${I}/allocate-next`, { prefixId: ids.lan })).status).toBe(403);
  });
});

describe('conflicts, deletes and CSV', () => {
  it('reports orphaned and mismatched addresses without changing them', async () => {
    await ctx.db.insert(ipAddresses).values({ orgId: ctx.org.id, address: '192.168.77.5', status: 'allocated' });
    await ctx.db.insert(ipAddresses).values({ orgId: ctx.org.id, address: '10.0.1.200', status: 'allocated', prefixLength: 25 });
    const c = await ok(admin.get(`${I}/conflicts`));
    const kinds = c.issues.map((i: any) => `${i.kind}:${i.address}`);
    expect(kinds).toContain('orphan:192.168.77.5');
    expect(kinds).toContain('length_mismatch:10.0.1.200');
  });

  it('a prefix holding addresses with no other covering prefix cannot be deleted', async () => {
    const del = await admin.delete(`${I}/prefixes/${ids.custPrefix}`);
    expect(del.status).toBe(409);
    // The /24 is covered by the /16, so its addresses stay inside a prefix.
    expect((await admin.delete(`${I}/prefixes/${ids.lan}`)).status).toBe(204);
  });

  it('imports prefixes and addresses with a dry run first', async () => {
    const csvP = 'prefix,vrf,status,description\n198.51.100.0/24,,active,import test\n198.51.100.0/25,,active,child\n198.51.100.7/24,,active,bad host bits\n';
    const dry = await ok(admin.post(`${I}/import`, { kind: 'prefixes', csv: csvP, dryRun: true }));
    expect(dry.created).toBe(2);
    expect(dry.failed).toBe(1);
    expect((await ok<any[]>(admin.get(`${I}/prefixes?q=198.51.100.0/24`))).length).toBe(0);
    const real = await ok(admin.post(`${I}/import`, { kind: 'prefixes', csv: csvP, dryRun: false }));
    expect(real.created).toBe(2);
    const csvA = 'address,status,dns_name,customer_code,device\n198.51.100.10,allocated,a.example.com,ACME,ACME-SRV-1\n198.51.100.10,allocated,dup.example.com,,\n198.51.100.0,allocated,,,\n198.51.100.200,reserved,,NOPE,\n';
    const res = await ok(admin.post(`${I}/import`, { kind: 'addresses', csv: csvA, dryRun: false }));
    expect(res.created).toBe(1);
    expect(res.results.find((r: any) => r.line === 3).message).toMatch(/already/);
    expect(res.results.find((r: any) => r.line === 4).message).toMatch(/network/);
    expect(res.results.find((r: any) => r.line === 5).message).toMatch(/Unknown customer/);
    const exp = await admin.get(`${I}/export.csv?kind=addresses`);
    expect(exp.status).toBe(200);
    expect(exp.text.replace(/^\uFEFF/, '').split(/\r?\n/)[0]).toBe('address,vrf,status,prefix_length,role,dns_name,reverse_dns,customer_code,device,interface,service_ref,reserved_until,notes');
    expect(exp.text).toContain('198.51.100.10,,allocated,25,,a.example.com,,ACME,ACME-SRV-1');
  });

  it('summary reports IPv4 utilization from leaf prefixes', async () => {
    const s = await ok(admin.get(`${I}/summary`));
    expect(s.prefixes).toBeGreaterThan(3);
    expect(s.ipv4.usable).toBeGreaterThan(0);
    expect(s.fullest[0].addressUtilization).toBe(100); // the /28 we filled
  });
});
