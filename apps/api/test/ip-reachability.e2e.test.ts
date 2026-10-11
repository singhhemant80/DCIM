/**
 * IPAM: reachability (ping sweeps of a prefix) and addresses recorded from a
 * hypervisor sync, owned by the VM's customer or by the organization itself.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipAddresses, prefixes } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { sweepDuePrefix, systemPing, type Pinger } from '../src/worker/monitoring/ping';
import { PROVISIONING_KINDS, syncDueIntegrations, type ProvisioningDeps } from '../src/worker/provisioning/kinds';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startVirtualizor, type MockVirtualizor } from './simulators/provisioning-devices';

let ctx: TestContext;
let admin: Client;
let acme: Client;
let vz: MockVirtualizor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const I = '/api/v1/ipam';
const V = '/api/v1/virtualization';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const deps = (): ProvisioningDeps => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, kinds: PROVISIONING_KINDS, publicUrl: 'http://127.0.0.1:8080', imageAllowLocal: true });

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  vz = await startVirtualizor('VZKEY123', 'vz-api-pass-77');
});

afterAll(async () => {
  await vz?.close();
  await ctx?.close();
});

describe('reachability (ping sweep)', () => {
  it('pings every usable address of a small prefix and keeps the results', async () => {
    const pre = await ok(admin.post(`${I}/prefixes`, { prefix: '198.51.100.0/29', status: 'active', pingSweep: true }));
    ids.pre = pre.id;
    expect(pre.pingSweep).toBe(true);
    await ok(admin.post(`${I}/addresses`, { address: '198.51.100.2', status: 'allocated' }));
    await ok(admin.post(`${I}/addresses`, { address: '198.51.100.3', status: 'allocated' }));
    const asked: string[] = [];
    const fake: Pinger = async (ip) => (asked.push(ip), ip === '198.51.100.2' ? { reachable: true, rttMs: 1.5 } : ip === '198.51.100.5' ? { reachable: true, rttMs: 3 } : { reachable: false, rttMs: null });
    const r = await sweepDuePrefix({ db: ctx.db, logger: silent, ping: fake });
    expect(r).toMatchObject({ prefixId: pre.id, checked: 6, up: 2 });
    // Usable addresses only: no network (.0) or broadcast (.7).
    expect(asked.sort()).toEqual(['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.4', '198.51.100.5', '198.51.100.6']);
    // Not due again for 5 minutes.
    expect(await sweepDuePrefix({ db: ctx.db, logger: silent, ping: fake })).toBeNull();

    const list = await ok(admin.get(`${I}/addresses?prefixId=${pre.id}`));
    const by = Object.fromEntries(list.items.map((a: { address: string }) => [a.address, a]));
    expect(by['198.51.100.2'].reachability).toMatchObject({ reachable: true, rttMs: 1.5 });
    expect(by['198.51.100.3'].reachability).toMatchObject({ reachable: false, rttMs: null });
    // Answers ping but isn't recorded: shown on the prefix so it can be investigated or recorded.
    const detail = await ok(admin.get(`${I}/prefixes/${pre.id}`));
    expect(detail.unrecorded.map((x: { address: string }) => x.address)).toEqual(['198.51.100.5']);
  });

  it('keeps the last time an address answered, and reports a broken ping instead of "down"', async () => {
    await ctx.db.update(prefixes).set({ pingCheckedAt: new Date(Date.now() - 600_000) }).where(eq(prefixes.id, ids.pre));
    await sweepDuePrefix({ db: ctx.db, logger: silent, ping: async () => ({ reachable: false, rttMs: null }) });
    const list = await ok(admin.get(`${I}/addresses?prefixId=${ids.pre}`));
    const a2 = list.items.find((a: { address: string }) => a.address === '198.51.100.2');
    expect(a2.reachability.reachable).toBe(false);
    expect(a2.reachability.lastSeenAt).toBeTruthy();

    await ctx.db.update(prefixes).set({ pingCheckedAt: new Date(Date.now() - 600_000) }).where(eq(prefixes.id, ids.pre));
    await sweepDuePrefix({ db: ctx.db, logger: silent, ping: async () => { throw new Error('The ping command is not installed on the worker host (apt install iputils-ping)'); } });
    const pre = await ok(admin.get(`${I}/prefixes/${ids.pre}`));
    expect(pre.pingError).toMatch(/not installed/);
    // The previous results are kept rather than overwritten with "down".
    const again = await ok(admin.get(`${I}/addresses?prefixId=${ids.pre}`));
    expect(again.items.find((a: { address: string }) => a.address === '198.51.100.3').reachability).toBeTruthy();
  });

  it('turning the check off is explicit; editing other fields keeps it', async () => {
    await ok(admin.put(`${I}/prefixes/${ids.pre}`, { status: 'active', description: 'edited' }));
    expect((await ctx.db.select().from(prefixes).where(eq(prefixes.id, ids.pre)))[0]!.pingSweep).toBe(true);
    await ok(admin.put(`${I}/prefixes/${ids.pre}`, { status: 'active', pingSweep: false }));
    expect((await ctx.db.select().from(prefixes).where(eq(prefixes.id, ids.pre)))[0]!.pingSweep).toBe(false);
  });

  it('the system ping parses a real reply', async () => {
    try {
      expect(await systemPing('127.0.0.1', 4)).toMatchObject({ reachable: true });
    } catch (e) {
      // Without the ping binary the error says so (and names the package).
      expect((e as Error).message).toMatch(/ping/);
    }
  });
});

describe('addresses recorded from Virtualizor', () => {
  it('records VM addresses inside existing prefixes, owned by the organization until a customer is chosen', async () => {
    ids.vzPre = (await ok(admin.post(`${I}/prefixes`, { prefix: '203.0.113.0/24', status: 'active' }))).id;
    // A person already recorded .12: it is left exactly as it is.
    await ok(admin.post(`${I}/addresses`, { address: '203.0.113.12', status: 'reserved', notes: 'kept by hand' }));
    const i = await ok(admin.post(`${V}/integrations`, { kind: 'virtualizor', name: 'Master', url: `http://127.0.0.1:${vz.port}`, verifyTls: false, apiKey: 'VZKEY123', apiPass: 'vz-api-pass-77', actionsEnabled: false, syncMinutes: 10 }));
    ids.vz = i.id;
    await syncDueIntegrations(deps(), { force: i.id });
    const list = await ok(admin.get(`${I}/addresses?prefixId=${ids.vzPre}`));
    const by = Object.fromEntries(list.items.map((a: { address: string }) => [a.address, a]));
    expect(by['203.0.113.11']).toMatchObject({ status: 'allocated', source: 'hypervisor', guestName: 'vps11.example.net', customerId: null, ownerName: 'Test Org (own)', serviceRef: 'virtualizor:11' });
    expect(by['203.0.113.12']).toMatchObject({ status: 'reserved', source: 'manual', guestId: null, notes: 'kept by hand' });
    // Not in any prefix: nothing is recorded and no prefix is invented.
    vz.vps.get('11')!.ips.push('192.0.2.77');
    await syncDueIntegrations(deps(), { force: i.id });
    expect((await ok(admin.get(`${I}/addresses?q=192.0.2.77`))).items).toHaveLength(0);
  });

  it('reads every page of a large VPS list', async () => {
    for (let n = 100; n < 1350; n++) vz.vps.set(String(n), { serid: '0', hostname: `bulk${n}.example.net`, status: 1, suspended: 0, virt: 'kvm', ips: [] });
    await syncDueIntegrations(deps(), { force: ids.vz });
    const r = await ok(admin.get(`${V}/guests?integrationId=${ids.vz}&pageSize=1`));
    expect(r.total).toBe(1252);
    for (let n = 100; n < 1350; n++) vz.vps.delete(String(n));
    await syncDueIntegrations(deps(), { force: ids.vz });
  });

  it('follows the VM to its customer, and releases an address the VM no longer has', async () => {
    const guests = (await ok(admin.get(`${V}/guests?integrationId=${ids.vz}`))).items;
    const g11 = guests.find((g: { name: string }) => g.name === 'vps11.example.net');
    await ok(admin.put(`${V}/guests/${g11.id}/customer`, { customerId: ctx.customers.acme }));
    let a = (await ok(admin.get(`${I}/addresses?q=203.0.113.11`))).items[0];
    expect(a).toMatchObject({ customerId: ctx.customers.acme, ownerName: 'Acme' });
    // The customer now sees it in the portal, with its VM.
    expect((await ok(acme.get(`${I}/addresses`))).items.map((x: { address: string }) => x.address)).toContain('203.0.113.11');
    // A person's choice of customer is kept by later syncs.
    await syncDueIntegrations(deps(), { force: ids.vz });
    a = (await ok(admin.get(`${I}/addresses?q=203.0.113.11`))).items[0];
    expect(a.customerId).toBe(ctx.customers.acme);
    // The VM drops the address: the sync-recorded row is released; the manual .12 is untouched.
    vz.vps.get('11')!.ips = [];
    vz.vps.get('12')!.ips = [];
    await syncDueIntegrations(deps(), { force: ids.vz });
    const rows = await ctx.db.select().from(ipAddresses).where(eq(ipAddresses.orgId, ctx.org.id));
    expect(rows.find((r) => String(r.address).startsWith('203.0.113.11'))).toMatchObject({ status: 'released', customerId: null, guestId: null });
    expect(rows.find((r) => String(r.address).startsWith('203.0.113.12'))).toMatchObject({ status: 'reserved', source: 'manual' });
    const hist = await ok(admin.get(`${I}/addresses/${a.id}/history`));
    expect(hist.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['record', 'release']));
  });
});
