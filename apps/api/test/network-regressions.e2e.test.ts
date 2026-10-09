/**
 * Regression tests for defects found in the independent Phase 3 review.
 * Each test reproduces the original problem and asserts it is now handled.
 */
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceCredentials, neighborObservations } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { processRun } from '../src/worker/processor';
import type { Adapter, AdapterTarget, DiscoveryResult } from '../src/network/discovery/types';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let acme: Client;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const D = '/api/v1/dcim';
const N = '/api/v1/network';
const I = '/api/v1/ipam';

async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** A fake collector: records the target it was given and returns a scripted result. */
const seen: AdapterTarget[] = [];
let script: Partial<DiscoveryResult> = {};
const fake: Adapter = {
  test: async (t) => (seen.push(t), { ok: true, message: 'ok', latencyMs: 1 }),
  discover: async (t) => (seen.push(t), { source: 'snmp_v2c', collectedAt: new Date().toISOString(), facts: {}, interfaces: [], neighbors: [], bgp: [], warnings: [], ...script }),
};
const worker = () => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: { info: () => undefined, warn: () => undefined, error: () => undefined }, adapters: { snmp_v2c: fake } });
const run = async (deviceId: string, mode: 'test' | 'discover' = 'discover') => {
  const r = await ok(admin.post(`${N}/devices/${deviceId}/discovery`, { kind: 'snmp_v2c', mode }));
  await processRun(worker(), r.id);
  return ok(admin.get(`${N}/discovery/${r.id}`));
};

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'Cisco' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'N9K', category: 'switch', uHeight: 1, fullDepth: true }))).id;
  const srvModel = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'UCS', category: 'server', uHeight: 1, fullDepth: true }))).id;
  ids.edge = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'EDGE1', hostname: 'edge1.dc1.example', mgmtAddress: '10.0.0.1', initialState: 'inventory' }))).id;
  ids.core = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'CORE1', hostname: 'core1.dc1.example', initialState: 'inventory' }))).id;
  ids.infra = (await ok(admin.post(`${D}/devices`, { modelId: srvModel, assetTag: 'INFRA1', hostname: 'internal-dns', initialState: 'inventory' }))).id;
  await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.edge, pattern: 'ether[1-2]' }));
  await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.core, pattern: 'ether[1-2]' }));
});
afterAll(async () => ctx?.close());

describe('credential destination is fixed when the secret is entered', () => {
  it('changing the management address afterwards does not redirect the secret', async () => {
    await ok(admin.put(`${N}/devices/${ids.edge}/credentials`, { kind: 'snmp_v2c', community: 'edge-community' }));
    const [cred] = await ctx.db.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, ids.edge));
    expect(cred!.host).toBe('10.0.0.1');
    // Someone with only dcim.write repoints the hardware record.
    await ok(admin.patch(`${D}/devices/${ids.edge}`, { modelId: (await ok(admin.get(`${D}/devices/${ids.edge}`))).model.id, assetTag: 'EDGE1', hostname: 'edge1.dc1.example', mgmtAddress: 'attacker.example.com' }));
    seen.length = 0;
    await run(ids.edge, 'test');
    expect(seen.map((t) => t.host)).toEqual(['10.0.0.1']);
  });

  it('a host edited in the database without the secret makes the credential unusable', async () => {
    await ctx.db.execute(sql`update device_credentials set host = 'attacker.example.com' where device_id = ${ids.edge}`);
    seen.length = 0;
    const r = await run(ids.edge, 'test');
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/could not be decrypted/);
    expect(seen).toHaveLength(0);
    await ok(admin.put(`${N}/devices/${ids.edge}/credentials`, { kind: 'snmp_v2c', host: '10.0.0.1', community: 'edge-community' }));
  });

  it('a credential needs a host when the device has no management address', async () => {
    const r = await admin.put(`${N}/devices/${ids.core}/credentials`, { kind: 'snmp_v2c', community: 'core-community' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('no_address');
  });
});

describe('neighbor matching and observations', () => {
  it('a neighbor is not linked to our device by the first label of its name alone', async () => {
    script = { interfaces: [{ name: 'ether1', kind: 'physical' }], neighbors: [{ localInterface: 'ether1', protocol: 'lldp', remoteChassisId: 'aa:bb:cc:00:00:01', remoteSystemName: 'core1.upstream-isp.net', remotePortId: 'ether1' }] };
    const r = await run(ids.edge);
    expect(r.preview.neighbors[0].matched).toBeNull();
  });

  it('a bare host name and an exact FQDN still match', async () => {
    script = {
      interfaces: [{ name: 'ether1', kind: 'physical' }, { name: 'ether2', kind: 'physical' }],
      neighbors: [
        { localInterface: 'ether1', protocol: 'lldp', remoteChassisId: 'c1', remoteSystemName: 'core1', remotePortId: 'ether1' },
        { localInterface: 'ether2', protocol: 'lldp', remoteChassisId: 'c1', remoteSystemName: 'CORE1.dc1.example', remotePortId: 'ether2' },
      ],
    };
    const r = await run(ids.edge);
    expect(r.preview.neighbors.map((n: any) => n.matched?.deviceId)).toEqual([ids.core, ids.core]);
    await ok(admin.post(`${N}/discovery/${r.id}/apply`, { interfaces: [], importNeighbors: true }));
    expect((await ctx.db.select().from(neighborObservations)).length).toBe(2);
  });

  it('a run that returned no neighbors (e.g. LLDP timed out) keeps existing observations', async () => {
    script = { interfaces: [{ name: 'ether1', kind: 'physical' }], neighbors: [], warnings: ['LLDP-MIB: No SNMP response'] };
    const r = await run(ids.edge);
    await ok(admin.post(`${N}/discovery/${r.id}/apply`, { interfaces: [], importNeighbors: true }));
    expect((await ctx.db.select().from(neighborObservations)).length).toBe(2);
  });

  it('observations of another protocol are left alone; stale ones of the same protocol are removed', async () => {
    script = { interfaces: [], neighbors: [{ localInterface: 'ether1', protocol: 'cdp', remoteChassisId: 'core1', remoteSystemName: 'core1', remotePortId: 'ether1' }] };
    let r = await run(ids.edge);
    await ok(admin.post(`${N}/discovery/${r.id}/apply`, { interfaces: [], importNeighbors: true }));
    expect((await ctx.db.select().from(neighborObservations)).map((o) => o.protocol).sort()).toEqual(['cdp', 'lldp', 'lldp']);
    script = { interfaces: [], neighbors: [{ localInterface: 'ether1', protocol: 'lldp', remoteChassisId: 'c1', remoteSystemName: 'core1', remotePortId: 'ether1' }] };
    r = await run(ids.edge);
    await ok(admin.post(`${N}/discovery/${r.id}/apply`, { interfaces: [], importNeighbors: true }));
    expect((await ctx.db.select().from(neighborObservations)).map((o) => o.protocol).sort()).toEqual(['cdp', 'lldp']);
  });

  it('discovery never makes a logical interface a LAG member', async () => {
    script = { interfaces: [{ name: 'Po1', kind: 'lag' }, { name: 'vlan9', kind: 'vlan', lagName: 'Po1' }], neighbors: [] };
    const r = await run(ids.edge);
    const res = await ok(admin.post(`${N}/discovery/${r.id}/apply`, { interfaces: ['Po1', 'vlan9'], importNeighbors: false }));
    expect(res.warnings.join(' ')).toMatch(/only physical ports/);
    const vlan9 = (await ok<any[]>(admin.get(`${N}/devices/${ids.edge}/interfaces`))).find((i) => i.name === 'vlan9');
    expect(vlan9.lag).toBeNull();
  });
});

describe('IPAM tenancy and semantics', () => {
  it('a customer only counts its own addresses, and prefixes cannot nest across customers', async () => {
    ids.acmeNet = (await ok(admin.post(`${I}/prefixes`, { prefix: '10.50.0.0/24', customerId: ctx.customers.acme }))).id;
    const nested = await admin.post(`${I}/prefixes`, { prefix: '10.50.0.0/28', customerId: ctx.customers.globex });
    expect(nested.status).toBe(409);
    expect(nested.body.error).toBe('customer_mismatch');
    // A staff-made allocation for nobody in particular inherits the prefix's customer, so make one for Acme
    // and one written directly for another customer to prove the count is per customer.
    await ok(admin.post(`${I}/allocate-next`, { prefixId: ids.acmeNet }));
    await ctx.db.execute(sql`insert into ip_addresses (org_id, address, status, customer_id) values (${ctx.org.id}, '10.50.0.200', 'allocated', ${ctx.customers.globex})`);
    const mine = await ok<any[]>(acme.get(`${I}/prefixes`));
    expect(mine.find((x) => x.id === ids.acmeNet).usedAddresses).toBe(1);
    // Assigning a covering prefix to another customer is refused too.
    expect((await admin.post(`${I}/prefixes`, { prefix: '10.50.0.0/16', customerId: ctx.customers.globex })).status).toBe(409);
  });

  it('PATCH changes only the fields it sends', async () => {
    await ok(admin.post(`${I}/prefixes`, { prefix: '10.60.0.0/24' }));
    const a = await ok(admin.post(`${I}/addresses`, { address: '10.60.0.10', dnsName: 'keep.example.com', serviceRef: 'SVC-9', notes: 'keep me', role: 'primary' }));
    const after = await ok(admin.patch(`${I}/addresses/${a.id}`, { status: 'deprecated' }));
    expect(after).toMatchObject({ status: 'deprecated', dnsName: 'keep.example.com', serviceRef: 'SVC-9', notes: 'keep me', role: 'primary' });
    const cleared = await ok(admin.patch(`${I}/addresses/${a.id}`, { status: 'allocated', dnsName: null }));
    expect(cleared).toMatchObject({ status: 'allocated', dnsName: null, serviceRef: 'SVC-9' });
  });

  it('customers do not see infrastructure devices or staff subnets behind their addresses', async () => {
    await ok(admin.post(`${I}/prefixes`, { prefix: '10.70.0.0/24' }));
    await ok(admin.post(`${I}/addresses`, { address: '10.70.0.5', deviceId: ids.infra, customerId: ctx.customers.acme }));
    const list = await ok(acme.get(`${I}/addresses?q=10.70.0.5`));
    expect(list.items[0]).toMatchObject({ address: '10.70.0.5', deviceName: null, deviceId: null, prefix: null });
  });
});

describe('input validation', () => {
  it('rejects bad enum filters and zero speeds with 400', async () => {
    expect((await admin.get(`${N}/circuits?status=bogus`)).status).toBe(400);
    const r = await admin.post(`${N}/interfaces`, { deviceId: ids.edge, name: 'zero', kind: 'physical', speedBps: 0 });
    expect(r.status).toBe(400);
  });

  it('only import routes accept large bodies', async () => {
    const big = 'x'.repeat(1_200_000);
    const login = await request(ctx.server).post('/api/v1/auth/login').send({ email: 'a@b.example', password: big });
    expect(login.status).toBe(413);
    const imp = await admin.post(`${I}/import`, { kind: 'prefixes', csv: `prefix,description\n10.80.0.0/24,${'y'.repeat(1_200_000)}\n`, dryRun: true });
    expect(imp.status).toBe(201); // accepted and parsed (the oversized row itself is then rejected by validation)
  });
});
