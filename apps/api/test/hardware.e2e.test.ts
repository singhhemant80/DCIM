/**
 * Server hardware read from the BMC (Redfish, simulated iDRAC) and the
 * accessories fitted with a device (with spare-stock movements).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deviceHardware, spareParts } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { fetchDueHardware } from '../src/worker/hardware/collect';
import { collectRedfishInventory } from '../src/worker/adapters/redfish-inventory';
import { dellMemoryViaWsman } from '../src/worker/adapters/dell-wsman';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startRedfish, type MockRedfish } from './simulators/power-devices';

let ctx: TestContext;
let admin: Client;
let acme: Client;
let bmc: MockRedfish;
const ids: Record<string, string> = {};
const D = '/api/v1/dcim';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201, 204]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const deps = () => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent });

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  bmc = await startRedfish('root', 'bmc-pass-123');
  const m = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell HW' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: m, name: 'R650 HW', category: 'server', uHeight: 1, depthMm: 750, fullDepth: true }))).id;
  ids.srv = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'HW-1', initialState: 'inventory', customerId: ctx.customers.acme, ownership: 'customer' }))).id;
  ids.plain = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'HW-2', initialState: 'inventory' }))).id;
});
afterAll(async () => {
  await bmc?.close();
  await ctx?.close();
});

describe('hardware from the BMC', () => {
  it('needs a Redfish credential', async () => {
    expect((await ok(admin.get(`${D}/devices/${ids.plain}/hardware`))).status).toBe('not_configured');
    expect((await admin.post(`${D}/devices/${ids.plain}/hardware/refresh`)).body.error).toBe('no_redfish');
    expect(await fetchDueHardware(deps())).toBe(0);
  });

  it('reads components, health and the event log with GET requests only, as soon as a credential exists', async () => {
    await ok(admin.put(`/api/v1/network/devices/${ids.srv}/credentials`, { kind: 'redfish', host: '127.0.0.1', port: bmc.port, username: 'root', password: 'bmc-pass-123', scheme: 'http' }));
    expect(await fetchDueHardware(deps())).toBe(1);
    expect(bmc.requests.every((r) => r.method === 'GET')).toBe(true);
    const h = await ok(admin.get(`${D}/devices/${ids.srv}/hardware`));
    expect(h).toMatchObject({ status: 'idle', health: 'Critical', lastError: null });
    const inv = h.inventory;
    expect(inv.system).toMatchObject({ manufacturer: 'Dell Inc.', sku: 'HH90TAG', cpuCount: 2, memoryGb: 128 });
    expect(inv.bmc).toEqual({ model: '15G Monolithic', firmware: '7.00.00.171' });
    expect(inv.processors).toHaveLength(2);
    expect(inv.processors[0]).toMatchObject({ cores: 32, threads: 64 });
    // The empty slot is not listed.
    expect(inv.memory.map((m: { slot: string }) => m.slot)).toEqual(['DIMM.Socket.A1', 'DIMM.Socket.A2', 'DIMM.Socket.B1', 'DIMM.Socket.B2']);
    expect(inv.memory[1]).toMatchObject({ sizeGb: 32, type: 'DDR4', speedMhz: 3200, health: 'Warning' });
    expect(inv.drives[1]).toMatchObject({ mediaType: 'SSD', protocol: 'SATA', capacityGb: 960.2, lifeLeftPercent: 12, failurePredicted: true, slot: '1' });
    expect(inv.volumes[0]).toMatchObject({ raid: 'RAID1' });
    expect(inv.controllers[0]).toMatchObject({ model: 'PERC H755 Front', firmware: '52.16.1-4405' });
    expect(inv.psus.map((p: { health: string }) => p.health)).toEqual(['OK', 'Critical']);
    expect(inv.fans[0]).toMatchObject({ reading: 7800, units: 'RPM' });
    expect(inv.temperatures.map((t: { name: string }) => t.name)).toEqual(['CPU1 Temp', 'Inlet Temp']);
    expect(inv.nics[0]).toMatchObject({ mac: 'B8:CE:F6:00:11:22', speedMbps: 25000 });
    // System event log, both pages, newest first; the lifecycle log is left out.
    expect(inv.logs).toHaveLength(5);
    expect(inv.logs[0]).toMatchObject({ log: 'Sel', severity: 'Critical', messageId: 'PSU0003' });
    expect(inv.logs.some((l: { message: string }) => /Lifecycle/.test(l.message))).toBe(false);
    // Not due again until tomorrow.
    expect(await fetchDueHardware(deps())).toBe(0);
  });

  it('a refresh request is picked up on the next pass', async () => {
    await ok(admin.post(`${D}/devices/${ids.srv}/hardware/refresh`));
    expect((await ok(admin.get(`${D}/devices/${ids.srv}/hardware`))).requestedAt).toBeTruthy();
    expect(await fetchDueHardware(deps())).toBe(1);
    expect((await ok(admin.get(`${D}/devices/${ids.srv}/hardware`))).requestedAt).toBeNull();
  });

  it('shows what would change, and copies chosen fields to the record', async () => {
    const h = await ok(admin.get(`${D}/devices/${ids.srv}/hardware`));
    expect(h.differences.map((d: { key: string }) => d.key)).toEqual(expect.arrayContaining(['serial', 'cpu', 'cpuCount', 'ramGb', 'dimmLayout', 'disks', 'nics', 'biosVersion', 'bmcFirmware']));
    const r = await ok(admin.post(`${D}/devices/${ids.srv}/hardware/apply`, { fields: ['serial', 'cpu', 'ram', 'disks', 'nics', 'firmware'] }));
    expect(r.changed.length).toBeGreaterThan(5);
    const d = await ok(admin.get(`${D}/devices/${ids.srv}`));
    expect(d).toMatchObject({ serial: 'HH90TAG', cpuCount: 2, ramGb: 128, dimmLayout: '4 × 32 GB DDR4 3200 MHz', biosVersion: '1.10.2', bmcFirmware: '7.00.00.171' });
    expect(d.disks).toEqual([
      { slot: '0', type: 'SSD', sizeGb: 960, model: 'MZ7LH960HBJR0D3' },
      { slot: '1', type: 'SSD', sizeGb: 960, model: 'MZ7LH960HBJR0D3' },
    ]);
    expect(d.nics).toEqual([{ name: 'NIC.Slot.1-1-1', mac: 'B8:CE:F6:00:11:22', speed: '25G' }]);
    // Applying again changes nothing.
    expect((await ok(admin.post(`${D}/devices/${ids.srv}/hardware/apply`, { fields: ['serial'] }))).changed).toEqual([]);
    const hist = await ok(admin.get(`${D}/devices/${ids.srv}/events`));
    expect(JSON.stringify(hist)).toMatch(/Record updated from the BMC/);
  });

  it('a wrong password is reported, not hidden', async () => {
    await ok(admin.put(`/api/v1/network/devices/${ids.srv}/credentials`, { kind: 'redfish', host: '127.0.0.1', port: bmc.port, username: 'root', password: 'wrong-pass-999', scheme: 'http' }));
    await ok(admin.post(`${D}/devices/${ids.srv}/hardware/refresh`));
    await fetchDueHardware(deps());
    const h = await ok(admin.get(`${D}/devices/${ids.srv}/hardware`));
    expect(h.status).toBe('failed');
    expect(h.lastError).toMatch(/401|uthori/);
    expect(h.lastError).not.toMatch(/wrong-pass-999/);
    // The last good reading is kept.
    expect(h.inventory.system.sku).toBe('HH90TAG');
  });

  it('the customer who owns the server sees the components but not the BMC log, and cannot refresh', async () => {
    const h = await ok(acme.get(`${D}/devices/${ids.srv}/hardware`));
    expect(h.inventory.drives).toHaveLength(2);
    expect(h.inventory.logs).toEqual([]);
    expect(h.differences).toEqual([]);
    expect((await acme.post(`${D}/devices/${ids.srv}/hardware/refresh`)).status).toBe(403);
    expect((await acme.get(`${D}/devices/${ids.plain}/hardware`)).status).toBe(404);
  });
});

describe('BMCs that answer differently (iDRAC 9 and older firmware)', () => {
  const read = (port: number) => async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Basic ${Buffer.from('root:pw').toString('base64')}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 404 ? ' Not found' : ''}`);
    return (await r.json()) as Record<string, unknown>;
  };
  const slots = (inv: { memory: { slot: string | null }[] }) => inv.memory.map((m) => m.slot);

  it('uses $expand when offered, so memory comes back in one request', async () => {
    const sim = await startRedfish('root', 'pw', { expand: true });
    try {
      const inv = await collectRedfishInventory(read(sim.port));
      expect(slots(inv)).toEqual(['DIMM.Socket.A1', 'DIMM.Socket.A2', 'DIMM.Socket.B1', 'DIMM.Socket.B2']);
      expect(inv.drives.length).toBeGreaterThan(0);
      expect(sim.requests.some((r) => /Memory\/DIMM/.test(r.url))).toBe(false);
    } finally {
      await sim.close();
    }
  });

  it('a BMC that refuses many requests at once still gives the full inventory', async () => {
    const sim = await startRedfish('root', 'pw', { maxConcurrent: 3 });
    try {
      const inv = await collectRedfishInventory(read(sim.port));
      expect(slots(inv)).toHaveLength(4);
      expect(inv.drives.length).toBeGreaterThan(0);
      expect(inv.processors).toHaveLength(2);
      expect(inv.warnings ?? []).toEqual([]);
    } finally {
      await sim.close();
    }
  });

  it('finds memory at the standard path when the system resource leaves the link out', async () => {
    const sim = await startRedfish('root', 'pw', { noMemoryLink: true });
    try {
      expect(slots(await collectRedfishInventory(read(sim.port)))).toHaveLength(4);
    } finally {
      await sim.close();
    }
  });

  it('older iDRAC firmware without a Redfish memory list: modules are read over WS-Man, disks from SimpleStorage', async () => {
    const sim = await startRedfish('root', 'pw', { oldIdrac: true, wsmanMemory: true });
    try {
      const inv = await collectRedfishInventory(read(sim.port), undefined, {
        applies: (m) => /dell/i.test(m ?? ''),
        label: 'WS-Man',
        read: () => dellMemoryViaWsman({ host: '127.0.0.1', port: sim.port, username: 'root', params: { scheme: 'http' }, secret: { password: 'pw' } } as never),
      });
      expect(inv.memorySource).toBe('WS-Man');
      expect(inv.memory).toEqual([
        { slot: 'DIMM.Socket.A1', sizeGb: 32, type: 'DDR4', speedMhz: 2666, manufacturer: 'Samsung', partNumber: 'M393A4K40CB2-CTD', serial: 'SNA1', health: 'OK' },
        { slot: 'DIMM.Socket.A2', sizeGb: 32, type: 'DDR4', speedMhz: 2666, manufacturer: 'Samsung', partNumber: 'M393A4K40CB2-CTD', serial: 'SNA2', health: 'Warning' },
        { slot: 'DIMM.Socket.B1', sizeGb: 32, type: 'DDR4', speedMhz: 2666, manufacturer: 'Samsung', partNumber: 'M393A4K40CB2-CTD', serial: 'SNB1', health: 'OK' },
      ]);
      expect(inv.drives).toHaveLength(1);
      // Missing collections that older firmware never had are not reported as failures.
      expect(inv.warnings).toEqual([]);
      // Only GETs to Redfish, and only the memory view over WS-Man.
      expect(sim.requests.filter((r) => r.method !== 'GET').every((r) => r.method === 'POST' && r.url === '/wsman')).toBe(true);
    } finally {
      await sim.close();
    }
  });

  it('without WS-Man the reason the memory list is missing is shown', async () => {
    const sim = await startRedfish('root', 'pw', { oldIdrac: true });
    try {
      const inv = await collectRedfishInventory(read(sim.port), undefined, { applies: () => true, label: 'WS-Man', read: () => dellMemoryViaWsman({ host: '127.0.0.1', port: sim.port, username: 'root', params: { scheme: 'http' }, secret: { password: 'pw' } } as never) });
      expect(inv.memory).toEqual([]);
      expect(inv.warnings.join('\n')).toMatch(/Memory \(WS-Man\): HTTP 405/);
      expect(inv.warnings.join('\n')).toMatch(/does not list the modules \(no Memory collection/);
    } finally {
      await sim.close();
    }
  });
});

describe('accessories', () => {
  it('records cables, rail kits and trays with quantities', async () => {
    const dac = await ok(admin.post(`${D}/devices/${ids.srv}/accessories`, { kind: 'dac_cable', quantity: 2, description: 'SFP28 25G passive', lengthM: 3 }));
    await ok(admin.post(`${D}/devices/${ids.srv}/accessories`, { kind: 'rail_kit', quantity: 1, partNumber: 'ReadyRails II' }));
    await ok(admin.post(`${D}/devices/${ids.srv}/accessories`, { kind: 'lan_cable', quantity: 1, description: 'Cat6', lengthM: 2 }));
    const list = await ok(admin.get(`${D}/devices/${ids.srv}/accessories`));
    expect(list.map((a: { kind: string; quantity: number }) => [a.kind, a.quantity])).toEqual([
      ['dac_cable', 2],
      ['lan_cable', 1],
      ['rail_kit', 1],
    ]);
    expect(list[0].lengthM).toBe(3);
    await ok(admin.put(`${D}/devices/${ids.srv}/accessories/${dac.id}`, { kind: 'dac_cable', quantity: 4, description: 'SFP28 25G passive', lengthM: 3 }));
    expect((await ok(admin.get(`${D}/devices/${ids.srv}/accessories`)))[0].quantity).toBe(4);
    expect((await admin.post(`${D}/devices/${ids.srv}/accessories`, { kind: 'rail_kit', quantity: 0 })).status).toBe(400);
    expect((await admin.post(`${D}/devices/${ids.srv}/accessories`, { kind: 'banana', quantity: 1 })).status).toBe(400);
  });

  it('can take items from spare stock and return them', async () => {
    const part = await ok(admin.post(`${D}/spare-parts`, { kind: 'cable', partNumber: 'OM4-LC-LC-5M', description: 'OM4 LC-LC 5 m', quantity: 3 }));
    expect((await admin.post(`${D}/devices/${ids.srv}/accessories`, { kind: 'fiber_cable', quantity: 5, sparePartId: part.id })).body.error).toBe('not_enough_stock');
    const fib = await ok(admin.post(`${D}/devices/${ids.srv}/accessories`, { kind: 'fiber_cable', quantity: 2, description: 'OM4 LC-LC', lengthM: 5, sparePartId: part.id }));
    const qty = async () => (await ctx.db.select().from(spareParts).where(eq(spareParts.id, part.id)))[0]!.quantity;
    expect(await qty()).toBe(1);
    await ok(admin.put(`${D}/devices/${ids.srv}/accessories/${fib.id}`, { kind: 'fiber_cable', quantity: 3, description: 'OM4 LC-LC', lengthM: 5 }));
    expect(await qty()).toBe(0);
    await ok(admin.delete(`${D}/devices/${ids.srv}/accessories/${fib.id}?returnToStock=true`));
    expect(await qty()).toBe(3);
    const moves = await ok(admin.get(`${D}/spare-parts/${part.id}/movements`));
    expect(moves.map((m: { delta: number }) => m.delta)).toEqual(expect.arrayContaining([-2, -1, 3]));
  });

  it('customers can see the accessories of their own server, read-only', async () => {
    expect((await ok(acme.get(`${D}/devices/${ids.srv}/accessories`))).length).toBe(3);
    expect((await acme.post(`${D}/devices/${ids.srv}/accessories`, { kind: 'rail_kit', quantity: 1 })).status).toBe(403);
  });
});

void deviceHardware;
