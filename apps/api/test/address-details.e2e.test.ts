/**
 * Who uses each address: the server (brand, model, iDRAC), the VM (OS, size,
 * node), the server whose BMC it is, and — from a simulated MikroTik's ARP,
 * IPv6 neighbour table and DHCP leases plus reverse DNS — MAC, vendor and
 * names for addresses nothing points at. Customers see only their own.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/common/secret-box';
import { observeAddresses } from '../src/worker/ipam/observe';
import { Client, setupTestApp, type TestContext } from './helpers';
import { ROUTEROS_FIXTURE, startRouterOs } from './simulators/http-devices';

let ctx: TestContext;
let admin: Client;
let acme: Client;
let ros: Awaited<ReturnType<typeof startRouterOs>>;
const ids: Record<string, string> = {};
const silent = { warn: () => undefined };
const D = '/api/v1/dcim';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201, 204].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  ros = await startRouterOs('dcim-ro', 'ros-pass-2', {
    ...ROUTEROS_FIXTURE,
    '/rest/ip/arp': [
      { address: '103.150.120.50', 'mac-address': 'B8:2A:72:01:02:03', interface: 'vlan100', complete: 'true' },
      { address: '103.150.120.51', 'mac-address': '52:54:00:AA:BB:CC', interface: 'vlan100', complete: 'true' },
      { address: '103.150.120.52', interface: 'vlan100', complete: 'false', status: 'failed' },
      { address: '10.99.0.5', 'mac-address': '3C:A8:2A:00:00:01', interface: 'mgmt', complete: 'true' },
    ],
    '/rest/ipv6/neighbor': [
      { address: 'fe80::1', 'mac-address': 'B8:2A:72:01:02:03', interface: 'vlan100', status: 'reachable' },
      { address: '2001:db8:10::50', 'mac-address': 'BC:24:11:00:00:09', interface: 'vlan100', status: 'reachable' },
    ],
    '/rest/ip/dhcp-server/lease': [{ address: '103.150.120.50', 'mac-address': 'B8:2A:72:01:02:03', 'host-name': 'office-pc-7', server: 'dhcp1', status: 'bound' }],
  });
  await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '103.150.120.0/24' }));
  await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '2001:db8:10::/48' }));
  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'PowerEdge R630', category: 'server', uHeight: 1, depthMm: 700, fullDepth: true }))).id;
  const rmfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'MikroTik AD' }))).id;
  const rmodel = (await ok(admin.post(`${D}/models`, { manufacturerId: rmfr, name: 'CCR2004 AD', category: 'router', uHeight: 1, fullDepth: false }))).id;
  ids.srv = (
    await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'SRV-AD1', hostname: 'web1.mum1', initialState: 'inventory', customerId: ctx.customers.acme, ownership: 'company', mgmtType: 'idrac', mgmtAddress: '103.150.120.30' }))
  ).id;
  ids.router = (await ok(admin.post(`${D}/devices`, { modelId: rmodel, assetTag: 'RTR-AD1', hostname: 'edge-ad', initialState: 'inventory' }))).id;
  await ctx.db.execute(sql`update devices set lifecycle_state = 'active' where id in (${ids.srv}, ${ids.router})`);
  await ok(admin.put(`/api/v1/network/devices/${ids.router}/credentials`, { kind: 'routeros_rest', host: '127.0.0.1', port: ros.port, username: 'dcim-ro', password: 'ros-pass-2', scheme: 'http', timeoutMs: 2000 }));
  await ok(admin.post('/api/v1/ipam/addresses', { address: '103.150.120.10', customerId: ctx.customers.acme, deviceId: ids.srv }));
  await ok(admin.post('/api/v1/ipam/addresses', { address: '103.150.120.30' }));
  // A VM from a Virtualizor sync, on a node linked to a server.
  const org = (await ctx.db.execute<{ id: string }>(sql`select org_id as id from devices where id = ${ids.srv}`)).rows[0]!.id;
  const integ = (await ctx.db.execute<{ id: string }>(sql`insert into virt_integrations (org_id, kind, name, url, secret_enc) values (${org}, 'virtualizor', 'VZ', 'https://vz.example:4085', 'x') returning id`)).rows[0]!.id;
  const host = (await ctx.db.execute<{ id: string }>(sql`insert into virt_hosts (org_id, integration_id, external_id, name, device_id) values (${org}, ${integ}, '1', 'srv2', ${ids.srv}) returning id`)).rows[0]!.id;
  const guest = (
    await ctx.db.execute<{ id: string }>(
      sql`insert into virt_guests (org_id, integration_id, host_id, external_id, name, virt_type, os_name, cpus, mem_bytes, customer_id) values (${org}, ${integ}, ${host}, '2671', 'aygg1', 'kvm', 'ubuntu-22.04-x86_64', 2, ${4 * 1024 ** 3}, ${ctx.customers.acme}) returning id`,
    )
  ).rows[0]!.id;
  await ctx.db.execute(sql`insert into ip_addresses (org_id, address, status, guest_id, customer_id, source, service_ref) values (${org}, '103.150.120.20', 'allocated', ${guest}, ${ctx.customers.acme}, 'hypervisor', 'virtualizor:2671')`);
});
afterAll(async () => {
  await ros?.close();
  await ctx?.close();
});

describe('address details', () => {
  it('servers, VMs and BMCs from DCIM; MAC, vendor and names from the router and reverse DNS', async () => {
    const ptr: Record<string, string> = { '103.150.120.10': 'web1.example.net.', '103.150.120.50': 'pc7.office.example.' };
    const r = await observeAddresses({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, reverse: async (ip) => (ptr[ip] ? [ptr[ip]!] : Promise.reject(new Error('ENOTFOUND'))) });
    expect(r).toMatchObject({ routers: 1, entries: 3 });
    // Read-only on the router.
    expect(ros.requests.every((q) => q.method === 'GET')).toBe(true);

    const list = await ok(admin.get('/api/v1/ipam/addresses?q=103.150.120.0/24'));
    const by = Object.fromEntries(list.items.map((x: { address: string }) => [x.address, x]));
    expect(by['103.150.120.10'].details).toMatchObject({
      device: { hostname: 'web1.mum1', brand: 'Dell', model: 'PowerEdge R630', category: 'server', bmc: { type: 'idrac', address: '103.150.120.30' } },
      observed: { ptr: 'web1.example.net' },
    });
    expect(by['103.150.120.20'].details.vm).toMatchObject({ os: 'ubuntu-22.04-x86_64', cpus: 2, memBytes: 4 * 1024 ** 3, virtType: 'kvm', platform: 'virtualizor', node: 'srv2', nodeDeviceId: ids.srv, nodeDeviceName: 'web1.mum1' });
    expect(by['103.150.120.30'].details.bmcOf).toMatchObject({ deviceId: ids.srv, name: 'web1.mum1', type: 'idrac', brand: 'Dell' });

    // Not recorded in IPAM, but seen by the router: on the prefix page.
    const pre = (await ok(admin.get('/api/v1/ipam/prefixes'))).find((x: { prefix: string }) => x.prefix === '103.150.120.0/24');
    const page = await ok(admin.get(`/api/v1/ipam/prefixes/${pre.id}`));
    const un = Object.fromEntries(page.unrecorded.map((x: { address: string }) => [x.address, x]));
    expect(un['103.150.120.50']).toMatchObject({ mac: 'b8:2a:72:01:02:03', vendor: 'Dell Inc.', dhcpHostName: 'office-pc-7', ptr: 'pc7.office.example', router: 'edge-ad', pings: false });
    expect(un['103.150.120.51']).toMatchObject({ vendor: 'QEMU/KVM virtual machine' });
    // Failed ARP entries, link-local and addresses outside your prefixes are not kept.
    expect(un['103.150.120.52']).toBeUndefined();
    const kept = (await ctx.db.execute<{ a: string }>(sql`select host(address) as a from ip_observations where mac is not null order by 1`)).rows.map((x) => x.a);
    expect(kept).toEqual(['103.150.120.50', '103.150.120.51', '2001:db8:10::50']);
  });

  it('customers see their own server and VM, never BMC addresses, nodes or router data', async () => {
    const mine = await ok(acme.get('/api/v1/ipam/addresses'));
    const by = Object.fromEntries(mine.items.map((x: { address: string }) => [x.address, x]));
    expect(by['103.150.120.10'].details).toEqual({
      device: { hostname: 'web1.mum1', assetTag: null, category: 'server', brand: 'Dell', model: 'PowerEdge R630', bmc: { type: 'idrac', address: null } },
      vm: null,
      bmcOf: null,
      observed: { mac: null, vendor: null, dhcpHostName: null, ptr: 'web1.example.net', router: null, interface: null, seenAt: null },
    });
    expect(by['103.150.120.20'].details.vm).toMatchObject({ os: 'ubuntu-22.04-x86_64', node: null, nodeDeviceId: null, platform: null });
    expect(by['103.150.120.30']).toBeUndefined();
  });
});
