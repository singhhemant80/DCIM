/**
 * IPAM → DNS publishing against PowerDNS and Cloudflare mocks. DCIM must only
 * ever touch records it created, and secrets must never come back out.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, dnsServers, ipAddresses } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { sweepDns, syncAddress, testDnsServer, desiredRecords } from '../src/worker/dns/sync';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startCloudflare, startPowerDns, type MockCloudflare, type MockPdns } from './simulators/dns-servers';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let pdns: MockPdns;
let cf: MockCloudflare;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const I = '/api/v1/ipam';
const PDNS_KEY = 'pdns-secret-key-42';
const CF_TOKEN = 'cf-secret-token-77';

async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201, 204]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const deps = () => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), cloudflareBase: cf.base, timeoutMs: 2000 });
const addr = async (ip: string) => (await ctx.db.select().from(ipAddresses).where(sql`host(${ipAddresses.address}) = ${ip}`))[0]!;
const rrset = (zone: string, name: string, type: string) => pdns.zones.get(`${zone}.`)!.find((r) => r.name === `${name}.` && r.type === type);

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  pdns = await startPowerDns(PDNS_KEY, ['example.net', '113.0.203.in-addr.arpa']);
  cf = await startCloudflare(CF_TOKEN, { zone123: 'example.org' });
  await ok(admin.post(`${I}/prefixes`, { prefix: '203.0.113.0/24' }));
  await ok(admin.post(`${I}/prefixes`, { prefix: '2001:db8::/64' }));
});
afterAll(async () => {
  await pdns?.close();
  await cf?.close();
  await ctx?.close();
});

describe('DNS servers', () => {
  it('stores the key encrypted, never returns it and checks it through the worker', async () => {
    expect((await noc.post(`${I}/dns/servers`, { kind: 'powerdns', name: 'ns1', url: pdns.url, apiKey: PDNS_KEY })).status).toBe(403);
    const s = await ok(admin.post(`${I}/dns/servers`, { kind: 'powerdns', name: 'ns1', url: pdns.url, apiKey: PDNS_KEY }));
    ids.pdns = s.id;
    expect(JSON.stringify(s)).not.toContain(PDNS_KEY);
    const list = await admin.get(`${I}/dns/servers`);
    expect(list.text).not.toContain(PDNS_KEY);
    const [row] = await ctx.db.select().from(dnsServers).where(eq(dnsServers.id, s.id));
    expect(row!.secretEnc).not.toContain(PDNS_KEY);
    const audits = await ctx.db.select().from(auditEvents).where(sql`${auditEvents.action} like 'dns_%'`);
    expect(JSON.stringify(audits)).not.toContain(PDNS_KEY);
    const r = await testDnsServer(deps(), s.id);
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/PowerDNS authoritative 4\.9\.1/);
  });

  it('a wrong key is reported without echoing it', async () => {
    const bad = await ok(admin.post(`${I}/dns/servers`, { kind: 'powerdns', name: 'ns-bad', url: pdns.url, apiKey: 'wrong-key-999' }));
    const r = await testDnsServer(deps(), bad.id);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected the API key/);
    expect(r.message).not.toContain('wrong-key-999');
    await ok(admin.delete(`${I}/dns/servers/${bad.id}`));
  });

  it('validates zones', async () => {
    expect((await admin.post(`${I}/dns/zones`, { serverId: ids.pdns, name: 'example.net', kind: 'reverse' })).status).toBe(400);
    expect((await admin.post(`${I}/dns/zones`, { serverId: ids.pdns, name: '113.0.203.in-addr.arpa', kind: 'forward' })).status).toBe(400);
    ids.fwd = (await ok(admin.post(`${I}/dns/zones`, { serverId: ids.pdns, name: 'Example.NET.', kind: 'forward', ttl: 300 }))).id;
    ids.rev = (await ok(admin.post(`${I}/dns/zones`, { serverId: ids.pdns, name: '113.0.203.in-addr.arpa', kind: 'reverse' }))).id;
    const zones = await ok<any[]>(admin.get(`${I}/dns/zones`));
    expect(zones.map((z) => z.name).sort()).toEqual(['113.0.203.in-addr.arpa', 'example.net']);
    // A server with zones can't be deleted.
    expect((await admin.delete(`${I}/dns/servers/${ids.pdns}`)).status).toBe(409);
  });
});

describe('publishing to PowerDNS', () => {
  it('publishes A and PTR for a named address, marked as managed by DCIM', async () => {
    await ok(admin.post(`${I}/addresses`, { address: '203.0.113.10', dnsName: 'web1.example.net' }));
    expect((await addr('203.0.113.10')).dnsStatus).toBe('pending');
    expect(await sweepDns(deps())).toBe(1);
    const a = await addr('203.0.113.10');
    expect(a.dnsStatus).toBe('synced');
    expect(rrset('example.net', 'web1.example.net', 'A')).toMatchObject({ ttl: 300, records: [{ content: '203.0.113.10' }], comments: [{ account: `crapplet-dcim:${ctx.org.id}` }] });
    expect(rrset('113.0.203.in-addr.arpa', '10.113.0.203.in-addr.arpa', 'PTR')!.records).toEqual([{ content: 'web1.example.net.', disabled: false }]);
    expect(pdns.requests.some((r) => r.apiKey === PDNS_KEY)).toBe(true);
    expect(pdns.requests.every((r) => !r.url.includes(PDNS_KEY))).toBe(true);
    const view = (await ok(admin.get(`${I}/addresses?q=203.0.113.10`))).items[0];
    expect(view.dns).toMatchObject({ status: 'synced' });
    expect(view.dns.records).toHaveLength(2);
  });

  it('renaming moves the records; nothing is left behind', async () => {
    const a = await addr('203.0.113.10');
    await ok(admin.patch(`${I}/addresses/${a.id}`, { status: 'allocated', dnsName: 'web2.example.net' }));
    await sweepDns(deps());
    expect(rrset('example.net', 'web1.example.net', 'A')).toBeUndefined();
    expect(rrset('example.net', 'web2.example.net', 'A')!.records[0]!.content).toBe('203.0.113.10');
    expect(rrset('113.0.203.in-addr.arpa', '10.113.0.203.in-addr.arpa', 'PTR')!.records[0]!.content).toBe('web2.example.net.');
  });

  it('never overwrites a record it did not create', async () => {
    pdns.zones.get('example.net.')!.push({ name: 'mail.example.net.', type: 'A', records: [{ content: '192.0.2.25' }] });
    await ok(admin.post(`${I}/addresses`, { address: '203.0.113.25', dnsName: 'mail.example.net' }));
    await sweepDns(deps());
    const a = await addr('203.0.113.25');
    expect(a.dnsStatus).toBe('failed');
    expect(a.dnsError).toMatch(/not managed by DCIM/);
    expect(rrset('example.net', 'mail.example.net', 'A')!.records).toEqual([{ content: '192.0.2.25' }]);
    // Its PTR (in a zone without a conflict) was still published.
    expect(rrset('113.0.203.in-addr.arpa', '25.113.0.203.in-addr.arpa', 'PTR')).toBeDefined();
  });

  it('releasing an address removes its records; a name outside managed zones is ignored', async () => {
    const a = await addr('203.0.113.25');
    await ok(admin.post(`${I}/addresses/${a.id}/release`, {}));
    await sweepDns(deps());
    expect(rrset('113.0.203.in-addr.arpa', '25.113.0.203.in-addr.arpa', 'PTR')).toBeUndefined();
    expect(rrset('example.net', 'mail.example.net', 'A')!.records).toEqual([{ content: '192.0.2.25' }]);
    expect((await addr('203.0.113.25')).dnsStatus).toBe('none');
    await ok(admin.post(`${I}/addresses`, { address: '2001:db8::5', dnsName: 'host.elsewhere.com' }));
    expect(desiredRecords({ address: '2001:db8::5', status: 'allocated', vrfId: null, dnsName: 'host.elsewhere.com', reverseDns: null }, [])).toEqual([]);
  });

  it('reserved addresses and VRF addresses are not published', () => {
    const zones = [{ id: 'z', name: 'example.net', kind: 'forward', enabled: true }] as never;
    expect(desiredRecords({ address: '203.0.113.9', status: 'reserved', vrfId: null, dnsName: 'a.example.net', reverseDns: null }, zones)).toEqual([]);
    expect(desiredRecords({ address: '203.0.113.9', status: 'allocated', vrfId: 'v', dnsName: 'a.example.net', reverseDns: null }, zones)).toEqual([]);
    expect(desiredRecords({ address: '2001:db8::9', status: 'allocated', vrfId: null, dnsName: 'a.example.net', reverseDns: null }, zones)).toEqual([{ zoneId: 'z', name: 'a.example.net', type: 'AAAA', content: '2001:db8::9' }]);
  });

  it('a zone holding DCIM records cannot be deleted or renamed, only disabled', async () => {
    expect((await admin.delete(`${I}/dns/zones/${ids.fwd}`)).status).toBe(409);
    expect((await admin.put(`${I}/dns/zones/${ids.fwd}`, { serverId: ids.pdns, name: 'other.net', kind: 'forward' })).status).toBe(409);
    await ok(admin.put(`${I}/dns/zones/${ids.fwd}`, { serverId: ids.pdns, name: 'example.net', kind: 'forward', ttl: 300, enabled: false }));
    // While disabled, a rename leaves the existing record alone.
    const a = await addr('203.0.113.10');
    await ok(admin.patch(`${I}/addresses/${a.id}`, { status: 'allocated', dnsName: 'web3.example.net' }));
    await sweepDns(deps());
    expect(rrset('example.net', 'web2.example.net', 'A')).toBeDefined();
    expect(rrset('example.net', 'web3.example.net', 'A')).toBeUndefined();
  });
});

describe('publishing to Cloudflare', () => {
  it('creates and removes only its own records', async () => {
    const s = await ok(admin.post(`${I}/dns/servers`, { kind: 'cloudflare', name: 'Cloudflare', apiToken: CF_TOKEN }));
    expect((await admin.post(`${I}/dns/zones`, { serverId: s.id, name: 'example.org', kind: 'forward' })).status).toBe(400); // zone id needed
    await ok(admin.post(`${I}/dns/zones`, { serverId: s.id, name: 'example.org', kind: 'forward', providerZoneId: 'zone123' }));
    expect(await testDnsServer(deps(), s.id)).toMatchObject({ ok: true });
    cf.records.get('zone123')!.push({ id: 'foreign1', type: 'A', name: 'keep.example.org', content: '192.0.2.1', comment: null });
    await ok(admin.post(`${I}/addresses`, { address: '203.0.113.40', dnsName: 'api.example.org' }));
    await sweepDns(deps());
    const recs = cf.records.get('zone123')!;
    expect(recs.find((r) => r.name === 'api.example.org')).toMatchObject({ content: '203.0.113.40', comment: `Managed by Crapplet DCIM (${ctx.org.id})` });
    const a = await addr('203.0.113.40');
    await ok(admin.post(`${I}/addresses/${a.id}/release`, {}));
    await sweepDns(deps());
    expect(cf.records.get('zone123')!.map((r) => r.name)).toEqual(['keep.example.org']);
  });
});

describe('review regressions', () => {
  it('two addresses sharing a name, synced concurrently, both stay in the round-robin set', async () => {
    await ok(admin.put(`${I}/dns/zones/${ids.fwd}`, { serverId: ids.pdns, name: 'example.net', kind: 'forward', ttl: 300, enabled: true }));
    await sweepDns(deps());
    await ok(admin.post(`${I}/addresses`, { address: '203.0.113.51', dnsName: 'rr.example.net' }));
    await ok(admin.post(`${I}/addresses`, { address: '203.0.113.52', dnsName: 'rr.example.net' }));
    pdns.delayMs = 150;
    const [a, b] = [await addr('203.0.113.51'), await addr('203.0.113.52')];
    await Promise.all([syncAddress(deps(), a.id), syncAddress(deps(), b.id)]);
    pdns.delayMs = 0;
    expect(rrset('example.net', 'rr.example.net', 'A')!.records.map((r) => r.content).sort()).toEqual(['203.0.113.51', '203.0.113.52']);
  });

  it('a disabled child zone is never replaced by its parent zone', async () => {
    pdns.zones.set('lab.example.net.', []);
    const lab = await ok(admin.post(`${I}/dns/zones`, { serverId: ids.pdns, name: 'lab.example.net', kind: 'forward', enabled: false }));
    await ok(admin.post(`${I}/addresses`, { address: '203.0.113.60', dnsName: 'h1.lab.example.net' }));
    await sweepDns(deps());
    expect(rrset('example.net', 'h1.lab.example.net', 'A')).toBeUndefined();
    expect(pdns.zones.get('lab.example.net.')).toEqual([]);
    await ok(admin.delete(`${I}/dns/zones/${lab.id}`));
  });

  it('records left in a disabled zone after a rename are reported, not shown as in sync', async () => {
    await ok(admin.post(`${I}/addresses`, { address: '203.0.113.70', dnsName: 'h8.example.net' }));
    await sweepDns(deps());
    await ok(admin.put(`${I}/dns/zones/${ids.fwd}`, { serverId: ids.pdns, name: 'example.net', kind: 'forward', ttl: 300, enabled: false }));
    const a = await addr('203.0.113.70');
    await ok(admin.patch(`${I}/addresses/${a.id}`, { status: 'allocated', dnsName: 'h9.example.net' }));
    await sweepDns(deps());
    const after = await addr('203.0.113.70');
    expect(after.dnsStatus).toBe('failed');
    expect(after.dnsError).toMatch(/disabled zone example\.net/);
    // Re-enabling the zone queues the address again; the next sweep moves the record.
    await ok(admin.put(`${I}/dns/zones/${ids.fwd}`, { serverId: ids.pdns, name: 'example.net', kind: 'forward', ttl: 300, enabled: true }));
    expect((await addr('203.0.113.70')).dnsStatus).toBe('pending');
    await sweepDns(deps());
    expect(rrset('example.net', 'h8.example.net', 'A')).toBeUndefined();
    expect(rrset('example.net', 'h9.example.net', 'A')).toBeDefined();
    expect((await addr('203.0.113.70')).dnsStatus).toBe('synced');
  });

  it('refuses unsafe server URLs and invalid PTR names', async () => {
    expect((await admin.post(`${I}/dns/servers`, { kind: 'powerdns', name: 'x', url: 'file:///etc/passwd', apiKey: 'k-123' })).status).toBe(400);
    expect((await admin.post(`${I}/dns/servers`, { kind: 'powerdns', name: 'x', url: 'https://user:pass@ns1.example.net', apiKey: 'k-123' })).status).toBe(400);
    expect((await admin.post(`${I}/addresses`, { address: '203.0.113.80', reverseDns: 'not a host name' })).status).toBe(400);
  });
});
