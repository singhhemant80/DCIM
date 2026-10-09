import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, deviceCredentials, discoveryRuns, neighborObservations } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { processRun } from '../src/worker/processor';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startSnmpAgent, type RunningAgent } from './simulators/snmp-agent';
import { startRouterOs, type MockDevice } from './simulators/http-devices';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let snmpAgent: RunningAgent;
let ros: MockDevice;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const D = '/api/v1/dcim';
const N = '/api/v1/network';
const SNMP_PORT = 16100 + Math.floor(Math.random() * 800);
const COMMUNITY = 'S3cret-Community-x9';
const ROS_PASS = 'ros-Pa55word-zz';

async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const iface = (deviceId: string, name: string, extra: Record<string, unknown> = {}) => ok(admin.post(`${N}/interfaces`, { deviceId, name, kind: 'physical', ...extra }));
const ifaceId = async (deviceId: string, name: string) => ((await ok<any[]>(admin.get(`${N}/devices/${deviceId}/interfaces`))).find((i) => i.name === name)!.id as string);
const worker = () => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: { info: () => undefined, warn: () => undefined, error: () => undefined }, runTimeoutMs: 20_000 });

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  snmpAgent = await startSnmpAgent(SNMP_PORT, undefined, { community: COMMUNITY });
  ros = await startRouterOs('dcim-ro', ROS_PASS);

  ids.dc = (await ok(admin.post(`${D}/datacenters`, { code: 'del1', name: 'Delhi 1' }))).id;
  ids.dc2 = (await ok(admin.post(`${D}/datacenters`, { code: 'blr1', name: 'Bangalore 1' }))).id;
  const b = (await ok(admin.post(`${D}/buildings`, { datacenterId: ids.dc, name: 'B1' }))).id;
  const room = (await ok(admin.post(`${D}/rooms`, { buildingId: b, name: 'Hall', gridCols: 5, gridRows: 5 }))).id;
  ids.rack = (await ok(admin.post(`${D}/racks`, { roomId: room, name: 'R1', uHeight: 42 }))).id;
  const b2 = (await ok(admin.post(`${D}/buildings`, { datacenterId: ids.dc2, name: 'B2' }))).id;
  const room2 = (await ok(admin.post(`${D}/rooms`, { buildingId: b2, name: 'Hall', gridCols: 5, gridRows: 5 }))).id;
  ids.rack2 = (await ok(admin.post(`${D}/racks`, { roomId: room2, name: 'R1', uHeight: 42 }))).id;
  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'MikroTik' }))).id;
  ids.routerModel = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'CCR2004', category: 'router', uHeight: 1, fullDepth: false }))).id;
  ids.serverModel = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'Server', category: 'server', uHeight: 1, fullDepth: true }))).id;
  const dev = async (tag: string, model: string, rack: string, u: number, extra: Record<string, unknown> = {}) => {
    const id = (await ok(admin.post(`${D}/devices`, { modelId: ids[model], assetTag: tag, initialState: 'inventory', ...extra }))).id as string;
    await ok(admin.post(`${D}/devices/${id}/placement`, { rackId: ids[rack], positionU: u, face: 'front' }));
    return id;
  };
  ids.r1 = await dev('NET-R1', 'routerModel', 'rack', 40, { hostname: 'edge-r1' });
  ids.r2 = await dev('NET-R2', 'routerModel', 'rack', 38, { hostname: 'core-r2.example.net' });
  ids.r3 = await dev('NET-R3', 'routerModel', 'rack2', 40, { hostname: 'blr-r3' });
  ids.srv = await dev('SRV-1', 'serverModel', 'rack', 10, { customerId: ctx.customers.acme });
});
afterAll(async () => {
  snmpAgent?.close();
  await ros?.close();
  await ctx?.close();
});

describe('network devices and interfaces', () => {
  it('lists network-category devices and sets platform details', async () => {
    const list = await ok<any[]>(admin.get(`${N}/devices`));
    expect(list.map((d) => d.id).sort()).toEqual([ids.r1, ids.r2, ids.r3].sort());
    expect((await ok<any[]>(admin.get(`${N}/devices?all=true`))).length).toBe(4);
    await ok(admin.patch(`${N}/devices/${ids.r1}`, { platform: 'routeros', networkRole: 'edge' }));
    const d = await ok(admin.get(`${N}/devices/${ids.r1}`));
    expect(d.device.platform).toBe('routeros');
  });

  it('bulk-creates ports from a pattern and skips existing names', async () => {
    const r = await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.r1, pattern: 'ether[1-4]', media: 'copper', speedBps: 1e9 }));
    expect(r.created).toBe(4);
    const again = await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.r1, pattern: 'ether[3-6]' }));
    expect(again.created).toBe(2);
    expect(again.skipped).toBe(2);
    await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.r2, pattern: 'ether[1-6]' }));
    await ok(admin.post(`${N}/interfaces/bulk`, { deviceId: ids.r3, pattern: 'ether[1-2]' }));
    // Names are unique per device, case-insensitively.
    expect((await admin.post(`${N}/interfaces`, { deviceId: ids.r1, name: 'ETHER1', kind: 'physical' })).status).toBe(409);
  });

  it('enforces LAG rules in the database', async () => {
    ids.bond = (await iface(ids.r1, 'bond1', { kind: 'lag' })).id;
    const e5 = await ifaceId(ids.r1, 'ether5');
    const put = await admin.put(`${N}/interfaces/${e5}`, { deviceId: ids.r1, name: 'ether5', kind: 'physical', lagId: ids.bond });
    expect(put.status).toBe(200);
    // A LAG member on another device is refused.
    const otherBond = (await iface(ids.r2, 'bond9', { kind: 'lag' })).id;
    const bad = await admin.put(`${N}/interfaces/${e5}`, { deviceId: ids.r1, name: 'ether5', kind: 'physical', lagId: otherBond });
    expect(bad.status).toBe(409);
    // A LAG can't be a member of a LAG.
    const nested = await admin.put(`${N}/interfaces/${otherBond}`, { deviceId: ids.r2, name: 'bond9', kind: 'lag', lagId: (await iface(ids.r2, 'bond8', { kind: 'lag' })).id });
    expect(nested.status).toBe(400);
    expect(nested.body.message).toMatch(/LAG/i);
  });

  it('validates VLAN modes and VLAN scope', async () => {
    ids.vlan100 = (await ok(admin.post(`${N}/vlans`, { vid: 100, name: 'customers', datacenterId: ids.dc }))).id;
    ids.vlan200 = (await ok(admin.post(`${N}/vlans`, { vid: 200, name: 'mgmt' }))).id;
    expect((await admin.post(`${N}/vlans`, { vid: 100, name: 'dup', datacenterId: ids.dc })).status).toBe(409);
    // Same VID in another datacenter is fine.
    await ok(admin.post(`${N}/vlans`, { vid: 100, name: 'blr customers', datacenterId: ids.dc2 }));
    const e2 = await ifaceId(ids.r1, 'ether2');
    expect((await admin.put(`${N}/interfaces/${e2}`, { deviceId: ids.r1, name: 'ether2', kind: 'physical', mode: 'access', untaggedVlanId: ids.vlan100 })).status).toBe(200);
    // Untagged and tagged in the same VLAN is contradictory.
    const both = await admin.put(`${N}/interfaces/${e2}`, { deviceId: ids.r1, name: 'ether2', kind: 'physical', mode: 'tagged', untaggedVlanId: ids.vlan100, taggedVlanIds: [ids.vlan100] });
    expect(both.status).toBe(400);
    // A VLAN scoped to Delhi can't be used on a Bangalore device.
    const r3e1 = await ifaceId(ids.r3, 'ether1');
    const wrongDc = await admin.put(`${N}/interfaces/${r3e1}`, { deviceId: ids.r3, name: 'ether1', kind: 'physical', mode: 'access', untaggedVlanId: ids.vlan100 });
    expect(wrongDc.status).toBe(400);
    const ports = await ok<any[]>(admin.get(`${N}/vlans/${ids.vlan100}/ports`));
    expect(ports.map((p) => p.id)).toContain(e2);
  });

  it('read-only roles can look but not change; customers have no access to network infrastructure', async () => {
    expect((await noc.get(`${N}/devices`)).status).toBe(200);
    expect((await noc.post(`${N}/interfaces/bulk`, { deviceId: ids.r1, pattern: 'x[1-2]' })).status).toBe(403);
    expect((await acme.get(`${N}/devices`)).status).toBe(403);
    expect((await acme.get(`${N}/topology`)).status).toBe(403);
  });
});

describe('cabling', () => {
  it('connects two physical ports and keeps each port to one cable', async () => {
    const a = await ifaceId(ids.r1, 'ether1');
    const b = await ifaceId(ids.r2, 'ether1');
    ids.cable = (await ok(admin.post(`${N}/cables`, { aInterfaceId: a, bInterfaceId: b, type: 'cat6', label: 'C-001' }))).id;
    const c = await ifaceId(ids.r2, 'ether2');
    expect((await admin.post(`${N}/cables`, { aInterfaceId: a, bInterfaceId: c })).status).toBe(409);
    // Logical interfaces can't be cabled.
    expect((await admin.post(`${N}/cables`, { aInterfaceId: ids.bond, bInterfaceId: c })).status).toBe(400);
    const view = await ok(admin.get(`${N}/interfaces/${a}`));
    expect(view.cable.peer.interfaceName).toBe('ether1');
  });

  it('refuses to delete a cabled port or turn it into a logical interface', async () => {
    const a = await ifaceId(ids.r1, 'ether1');
    expect((await admin.delete(`${N}/interfaces/${a}`)).status).toBe(409);
    expect((await admin.put(`${N}/interfaces/${a}`, { deviceId: ids.r1, name: 'ether1', kind: 'virtual' })).status).toBe(409);
  });

  it('a cable always has exactly two ends, even when written directly', async () => {
    const err = await ctx.db.execute(sql`insert into cables (org_id, status) values (${ctx.org.id}, 'connected')`).then(() => null, (e: { cause?: Error }) => e.cause ?? e);
    expect(String((err as Error)?.message)).toMatch(/exactly two ends/);
  });
});

describe('VRFs, providers and circuits', () => {
  it('manages circuits with history and protects active ones', async () => {
    ids.vrf = (await ok(admin.post(`${N}/vrfs`, { name: 'CUST-A', rd: '65000:100' }))).id;
    expect((await admin.post(`${N}/vrfs`, { name: 'bad', rd: 'nope' })).status).toBe(400);
    ids.provider = (await ok(admin.post(`${N}/providers`, { name: 'Tata Communications', asn: 4755 }))).id;
    const e3 = await ifaceId(ids.r1, 'ether3');
    ids.circuit = (await ok(admin.post(`${N}/circuits`, { providerId: ids.provider, cid: 'TATA-123', type: 'internet_transit', status: 'active', commitBps: 1e9, portSpeedBps: 1e10, interfaceId: e3, datacenterId: ids.dc }))).id;
    expect((await admin.post(`${N}/circuits`, { providerId: ids.provider, cid: 'tata-123', type: 'transport' })).status).toBe(409);
    expect((await admin.delete(`${N}/circuits/${ids.circuit}`)).status).toBe(409);
    const upd = await ok(admin.put(`${N}/circuits/${ids.circuit}`, { providerId: ids.provider, cid: 'TATA-123', type: 'internet_transit', status: 'active', commitBps: 2e9, portSpeedBps: 1e10, interfaceId: e3, datacenterId: ids.dc }));
    expect(upd.commitBps).toBe(2e9);
    const events = await ok<any[]>(admin.get(`${N}/circuits/${ids.circuit}/events`));
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect((await admin.delete(`${N}/providers/${ids.provider}`)).status).toBe(409);
  });
});

describe('credentials are write-only', () => {
  it('stores secrets encrypted and never returns or audits them', async () => {
    expect((await noc.put(`${N}/devices/${ids.r1}/credentials`, { kind: 'snmp_v2c', community: COMMUNITY })).status).toBe(403);
    const put = await ok(admin.put(`${N}/devices/${ids.r1}/credentials`, { kind: 'snmp_v2c', community: COMMUNITY, host: '127.0.0.1', port: SNMP_PORT, timeoutMs: 1000, retries: 0 }));
    expect(put.secretConfigured).toBe(true);
    expect(JSON.stringify(put)).not.toContain(COMMUNITY);
    const list = await admin.get(`${N}/devices/${ids.r1}/credentials`);
    expect(list.text).not.toContain(COMMUNITY);
    const summary = await admin.get(`${N}/devices/${ids.r1}`);
    expect(summary.text).not.toContain(COMMUNITY);
    const [row] = await ctx.db.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, ids.r1));
    expect(row!.secretEnc).not.toContain(COMMUNITY);
    expect(row!.secretEnc.startsWith('v1.')).toBe(true);
    const audits = await ctx.db.select().from(auditEvents).where(sql`${auditEvents.action} like 'credential.%'`);
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(COMMUNITY);
  });

  it('binds the ciphertext to its device: a copied secret does not decrypt elsewhere', async () => {
    await ok(admin.put(`${N}/devices/${ids.r3}/credentials`, { kind: 'snmp_v2c', community: 'other-community', host: '127.0.0.1', port: SNMP_PORT, timeoutMs: 500, retries: 0 }));
    const [src] = await ctx.db.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, ids.r1));
    await ctx.db.execute(sql`update device_credentials set secret_enc = ${src!.secretEnc} where device_id = ${ids.r3}`);
    const run = await ok(admin.post(`${N}/devices/${ids.r3}/discovery`, { kind: 'snmp_v2c', mode: 'test' }));
    await processRun(worker(), run.id);
    const r = await ok(admin.get(`${N}/discovery/${run.id}`));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/could not be decrypted/);
  });

  it('validates SNMPv3 key requirements', async () => {
    const r = await admin.put(`${N}/devices/${ids.r1}/credentials`, { kind: 'snmp_v3', username: 'ro', securityLevel: 'authPriv', authKey: 'authkey123' });
    expect(r.status).toBe(400);
  });
});

describe('discovery against the SNMP simulator', () => {
  it('tests the connection through the worker', async () => {
    const run = await ok(admin.post(`${N}/devices/${ids.r1}/discovery`, { kind: 'snmp_v2c', mode: 'test' }));
    expect(run.status === 'queued' || run.status === 'failed').toBe(true);
    if (run.status === 'failed') throw new Error(`queue unavailable: ${run.error}`);
    // One active run per device.
    expect((await admin.post(`${N}/devices/${ids.r1}/discovery`, { kind: 'snmp_v2c', mode: 'test' })).status).toBe(409);
    await processRun(worker(), run.id);
    const done = await ok(admin.get(`${N}/discovery/${run.id}`));
    expect(done.status).toBe('succeeded');
    expect(done.result.message).toMatch(/edge-r1\.example\.net/);
    const creds = await ok<any[]>(admin.get(`${N}/devices/${ids.r1}/credentials`));
    expect(creds[0].lastTestOk).toBe(true);
  });

  it('reports a wrong community as a failure without leaking it', async () => {
    await ok(admin.put(`${N}/devices/${ids.r2}/credentials`, { kind: 'snmp_v2c', community: 'wrong-community-123', host: '127.0.0.1', port: SNMP_PORT, timeoutMs: 500, retries: 0 }));
    const run = await ok(admin.post(`${N}/devices/${ids.r2}/discovery`, { kind: 'snmp_v2c', mode: 'test' }));
    await processRun(worker(), run.id);
    const done = await ok(admin.get(`${N}/discovery/${run.id}`));
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/No SNMP response/);
    expect(JSON.stringify(done)).not.toContain('wrong-community-123');
  });

  it('collects, previews and applies interfaces and LLDP neighbors', async () => {
    const run = await ok(admin.post(`${N}/devices/${ids.r1}/discovery`, { kind: 'snmp_v2c', mode: 'discover' }));
    await processRun(worker(), run.id);
    const r = await ok(admin.get(`${N}/discovery/${run.id}`));
    expect(r.status).toBe('succeeded');
    expect(r.result.bgp.find((b: any) => b.peer === '198.51.100.1').state).toBe('established');
    const pv = r.preview;
    const byName = Object.fromEntries(pv.interfaces.map((i: any) => [i.name, i]));
    expect(byName.ether1.action).toBe('update'); // gains MAC, MTU, ifIndex, description
    expect(byName['sfp-sfpplus1'].action).toBe('create');
    expect(byName.lo.kind).toBe('loopback');
    expect(pv.missing.map((m: any) => m.name)).toContain('ether6'); // documented but not on the device: reported, never deleted
    // The LLDP neighbor "core-r2" port ether1 matches device NET-R2 (hostname core-r2.example.net) and agrees with the cable.
    const n = pv.neighbors[0];
    expect(n.matched.deviceId).toBe(ids.r2);
    expect(n.matched.interfaceName).toBe('ether1');
    expect(n.cable).toBe('verified');

    // Nothing has been written yet.
    expect((await ok<any[]>(admin.get(`${N}/devices/${ids.r1}/interfaces`))).find((i) => i.name === 'sfp-sfpplus1')).toBeUndefined();

    const applied = await ok(admin.post(`${N}/discovery/${run.id}/apply`, { interfaces: ['ether1', 'sfp-sfpplus1', 'lo', 'vlan100'], updateDeviceFacts: true, importNeighbors: true }));
    expect(applied.created).toBe(3);
    expect(applied.updated).toBe(1);
    expect(applied.neighbors).toBe(1);
    expect(applied.facts).toContain('os');
    const after = await ok<any[]>(admin.get(`${N}/devices/${ids.r1}/interfaces`));
    const e1 = after.find((i) => i.name === 'ether1');
    expect(e1.macAddress).toBe('4c:5e:0c:00:00:01');
    expect(e1.ifIndex).toBe(1);
    expect(after.find((i) => i.name === 'ether6')).toBeDefined();
    const obs = await ctx.db.select().from(neighborObservations);
    expect(obs.length).toBe(1);
    expect(obs[0]!.matchedInterfaceId).toBe(await ifaceId(ids.r2, 'ether1'));

    expect((await admin.post(`${N}/discovery/${run.id}/apply`, { interfaces: [] })).status).toBe(409);
  });

  it('topology shows the cable as verified by LLDP and never invents links', async () => {
    const topo = await ok(admin.get(`${N}/topology`));
    const cableLink = topo.links.find((l: any) => l.kind === 'cable');
    expect(cableLink.verifiedByNeighbor).toBe(true);
    // The only links are the documented cable, the circuit and the observed neighbor.
    expect(topo.links.filter((l: any) => l.kind === 'neighbor').length).toBeLessThanOrEqual(1);
    expect(topo.nodes.some((n: any) => n.id === ids.r3)).toBe(true);
    expect(topo.links.some((l: any) => l.source === ids.r3 || l.target === ids.r3)).toBe(false);
  });

  it('marks stale runs failed so a device is never blocked forever', async () => {
    const [stuck] = await ctx.db.insert(discoveryRuns).values({ orgId: ctx.org.id, deviceId: ids.r2, credentialKind: 'snmp_v2c', mode: 'test', status: 'running', createdAt: new Date(Date.now() - 60 * 60_000) }).returning();
    const run = await ok(admin.post(`${N}/devices/${ids.r2}/discovery`, { kind: 'snmp_v2c', mode: 'test' }));
    expect(run.id).not.toBe(stuck!.id);
    const [old] = await ctx.db.select().from(discoveryRuns).where(eq(discoveryRuns.id, stuck!.id));
    expect(old!.status).toBe('failed');
    await processRun(worker(), run.id);
  });
});

describe('discovery against the RouterOS REST mock', () => {
  it('collects through the REST API with GET requests only', async () => {
    await ok(admin.put(`${N}/devices/${ids.r3}/credentials`, { kind: 'routeros_rest', host: '127.0.0.1', port: ros.port, username: 'dcim-ro', password: ROS_PASS, scheme: 'http', timeoutMs: 2000 }));
    const run = await ok(admin.post(`${N}/devices/${ids.r3}/discovery`, { kind: 'routeros_rest', mode: 'discover' }));
    await processRun(worker(), run.id);
    const r = await ok(admin.get(`${N}/discovery/${run.id}`));
    expect(r.status).toBe('succeeded');
    expect(r.result.facts.serial).toBe('HD5087ABC12');
    const names = r.result.interfaces.map((i: any) => i.name);
    expect(names).toEqual(expect.arrayContaining(['ether1', 'bond1', 'vlan100', 'wg0']));
    expect(r.result.interfaces.find((i: any) => i.name === 'sfp-sfpplus1').lagName).toBe('bond1');
    expect(ros.requests.every((q) => q.method === 'GET')).toBe(true);
    expect(JSON.stringify(r)).not.toContain(ROS_PASS);
  });

  it('a wrong password fails cleanly', async () => {
    await ok(admin.put(`${N}/devices/${ids.r3}/credentials`, { kind: 'routeros_rest', host: '127.0.0.1', port: ros.port, username: 'dcim-ro', password: 'nope-nope', scheme: 'http' }));
    const run = await ok(admin.post(`${N}/devices/${ids.r3}/discovery`, { kind: 'routeros_rest', mode: 'test' }));
    await processRun(worker(), run.id);
    const r = await ok(admin.get(`${N}/discovery/${run.id}`));
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/Authentication failed/);
  });
});

describe('interfaces with IP addresses', () => {
  it('a port holding addresses cannot be deleted until they are released', async () => {
    await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '10.99.0.0/24' }));
    const e4 = await ifaceId(ids.r1, 'ether4');
    const ip = await ok(admin.post('/api/v1/ipam/addresses', { address: '10.99.0.10', interfaceId: e4 }));
    expect(ip.deviceId).toBe(ids.r1);
    expect((await admin.delete(`${N}/interfaces/${e4}`)).status).toBe(409);
    await ok(admin.post(`/api/v1/ipam/addresses/${ip.id}/release`, {}));
    expect((await admin.delete(`${N}/interfaces/${e4}`)).status).toBe(204);
  });
});
