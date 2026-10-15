/**
 * Customer portal: a customer user sees only their own servers, with
 * reachability (no addresses), power and energy per server; amounts only
 * when the datacenter turns that on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { powerHourly, powerTariffs } from '../src/db/schema';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let acme: Client;
const ids: Record<string, string> = {};
const D = '/api/v1/dcim';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201, 204]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  const m = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell P' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: m, name: 'R640 P', category: 'server', uHeight: 1, depthMm: 750, fullDepth: true, typicalPowerW: 250 }))).id;
  ids.mine = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'CUST-1', hostname: 'ded-01', initialState: 'inventory', customerId: ctx.customers.acme, ownership: 'customer', mgmtAddress: '10.9.9.9' }))).id;
  ids.other = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'OWN-1', initialState: 'inventory' }))).id;
  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000);
  const row = (deviceId: string, wh: number, customerId: string | null) => ({ deviceId, hour, orgId: ctx.org.id, category: 'server', counted: true, source: 'redfish' as const, measuredWh: wh, measuredSeconds: 3600, customerId });
  await ctx.db.insert(powerHourly).values([row(ids.mine!, 400, ctx.customers.acme!), row(ids.other!, 900, null)]);
  await ctx.db.insert(powerTariffs).values({ orgId: ctx.org.id, name: 'Grid', currency: 'INR', pricePerKwh: '10', validFrom: new Date('2020-01-01') });
});
afterAll(async () => ctx?.close());

describe('customer portal', () => {
  it('lists only their servers, with energy per server and their BMC address', async () => {
    const list = await ok(acme.get(`${D}/devices?withStatus=true&period=24h`));
    expect(list.items.map((d: { assetTag: string }) => d.assetTag)).toEqual(['CUST-1']);
    const s = list.items[0].status;
    expect(s.power).toMatchObject({ energyKwh: 0.4, cost: [] });
    expect(list.items[0].mgmtAddress).toBe('10.9.9.9');
    expect(list.totals).toMatchObject({ energyKwh: 0.4, cost: [] });
  });

  it('per-server energy on the device page, and nothing for another customer\'s server', async () => {
    const mine = await ok(acme.get(`/api/v1/power/devices?deviceId=${ids.mine}&period=24h`));
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0].energy.measuredKwh).toBe(0.4);
    expect((await ok(acme.get(`/api/v1/power/devices?deviceId=${ids.other}&period=24h`))).items).toHaveLength(0);
    expect((await acme.get(`${D}/devices/${ids.other}`)).status).toBe(404);
    // The QR label (used on the printable datasheet): own equipment only.
    expect((await ok(acme.get(`${D}/devices/${ids.mine}/label`))).qrSvg).toMatch(/<svg/);
    expect((await acme.get(`${D}/devices/${ids.other}/label`)).status).toBe(404);
  });

  it('colocation shows their racked equipment even without a space allocation', async () => {
    const dc = (await ok(admin.post(`${D}/datacenters`, { code: 'cp1', name: 'CP' }))).id;
    const b = (await ok(admin.post(`${D}/buildings`, { datacenterId: dc, name: 'B' }))).id;
    const room = (await ok(admin.post(`${D}/rooms`, { buildingId: b, name: 'R', gridCols: 4, gridRows: 4 }))).id;
    const rack = (await ok(admin.post(`${D}/racks`, { roomId: room, name: 'R2R36', uHeight: 42, gridX: 0, gridY: 0 }))).id;
    await ok(admin.post(`${D}/devices/${ids.mine}/placement`, { rackId: rack, positionU: 20, face: 'front' }));
    await ok(admin.post(`${D}/devices/${ids.other}/placement`, { rackId: rack, positionU: 22, face: 'front' }));
    const eq = await ok(acme.get('/api/v1/colocation/equipment'));
    expect(eq).toHaveLength(1);
    expect(eq[0]).toMatchObject({ name: 'ded-01', rackName: 'R2R36', startU: 20, allocationId: null });
    const o = await ok(acme.get('/api/v1/colocation/overview'));
    expect(o.equipment).toMatchObject({ devices: 1, unallocated: 1 });
    expect(o.allocations).toBe(0);
    // Staff see it as customer equipment without an allocation.
    expect((await ok(admin.get('/api/v1/colocation/equipment'))).map((e: { customerName: string }) => e.customerName)).toEqual(['Acme']);
  });

  it('amounts appear for customers only once the datacenter turns them on', async () => {
    const s = await ok(admin.get('/api/v1/power/settings'));
    expect(s.customerCost).toBe(false);
    await ok(admin.put('/api/v1/power/settings', { ...s, customerCost: true }));
    const list = await ok(acme.get(`${D}/devices?withStatus=true&period=24h`));
    expect(list.items[0].status.power.cost).toEqual([{ currency: 'INR', amount: 4, estimatedPart: 0 }]);
    // Customers can't change it.
    expect((await acme.put('/api/v1/power/settings', { ...s, customerCost: false })).status).toBe(403);
  });
});
