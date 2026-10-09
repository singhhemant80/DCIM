import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, deviceEvents, devices } from '../src/db/schema';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let ops: Client;
let acme: Client;

const ids: Record<string, string> = {};
const V = '/api/v1/dcim';

async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

let tagSeq = 0;
async function newDevice(model: string, extra: Record<string, unknown> = {}) {
  const body = await ok(admin.post(`${V}/devices`, { modelId: ids[model], assetTag: `T-${++tagSeq}`, initialState: 'inventory', ...extra }));
  return body.id as string;
}
const place = (id: string, rackId: string | null, positionU?: number, face: 'front' | 'rear' = 'front') => admin.post(`${V}/devices/${id}/placement`, { rackId, positionU, face });

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  ops = await Client.login(ctx.server, ctx.emails.opsAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);

  ids.dc = (await ok(admin.post(`${V}/datacenters`, { code: 'mum1', name: 'Mumbai 1', city: 'Mumbai', country: 'IN' }))).id;
  ids.building = (await ok(admin.post(`${V}/buildings`, { datacenterId: ids.dc, name: 'Tower A' }))).id;
  ids.room = (await ok(admin.post(`${V}/rooms`, { buildingId: ids.building, name: 'Hall 1', gridCols: 10, gridRows: 6 }))).id;
  ids.room2 = (await ok(admin.post(`${V}/rooms`, { buildingId: ids.building, name: 'Hall 2', gridCols: 10, gridRows: 6 }))).id;
  ids.row = (await ok(admin.post(`${V}/rows`, { roomId: ids.room, name: 'A' }))).id;
  ids.rack = (await ok(admin.post(`${V}/racks`, { roomId: ids.room, rowId: ids.row, name: 'A01', uHeight: 42, depthMm: 1070, gridX: 0, gridY: 0 }))).id;
  ids.rack2 = (await ok(admin.post(`${V}/racks`, { roomId: ids.room, rowId: ids.row, name: 'A02', uHeight: 42, gridX: 1, gridY: 0 }))).id;

  ids.dell = (await ok(admin.post(`${V}/manufacturers`, { name: 'Dell' }))).id;
  ids.mikrotik = (await ok(admin.post(`${V}/manufacturers`, { name: 'MikroTik' }))).id;
  ids.r640 = (await ok(admin.post(`${V}/models`, { manufacturerId: ids.dell, name: 'PowerEdge R640', category: 'server', uHeight: 1, depthMm: 750, fullDepth: true, typicalPowerW: 280, psuCount: 2, psuRatedW: 750 }))).id;
  ids.r740 = (await ok(admin.post(`${V}/models`, { manufacturerId: ids.dell, name: 'PowerEdge R740', category: 'server', uHeight: 2, depthMm: 715, fullDepth: true }))).id;
  ids.ccr = (await ok(admin.post(`${V}/models`, { manufacturerId: ids.mikrotik, name: 'CCR2004-1G-12S+2XS', category: 'router', uHeight: 1, depthMm: 230, fullDepth: false }))).id;
  ids.pdu = (await ok(admin.post(`${V}/models`, { manufacturerId: ids.dell, name: 'Vertical PDU', category: 'pdu', uHeight: 0, fullDepth: false }))).id;
  ids.deep = (await ok(admin.post(`${V}/models`, { manufacturerId: ids.dell, name: 'Deep Storage', category: 'storage', uHeight: 4, depthMm: 1200, fullDepth: true }))).id;
});
afterAll(async () => ctx?.close());

describe('site hierarchy', () => {
  it('returns the full tree with rack counts', async () => {
    const tree = await ok(admin.get(`${V}/tree`));
    const dc = tree.find((d: { id: string }) => d.id === ids.dc);
    expect(dc.code).toBe('MUM1');
    expect(dc.buildings[0].rooms.find((r: { id: string }) => r.id === ids.room).rackCount).toBe(2);
  });

  it('rejects duplicates and deletes that would orphan children', async () => {
    expect((await admin.post(`${V}/datacenters`, { code: 'MUM1', name: 'dup' })).status).toBe(409);
    expect((await admin.post(`${V}/racks`, { roomId: ids.room, name: 'A01' })).status).toBe(409);
    expect((await admin.post(`${V}/racks`, { roomId: ids.room, name: 'A99', gridX: 0, gridY: 0 })).status).toBe(409);
    expect((await admin.post(`${V}/racks`, { roomId: ids.room, name: 'A98', gridX: 50, gridY: 0 })).status).toBe(400);
    const del = await admin.delete(`${V}/datacenters/${ids.dc}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/buildings/);
  });

  it('refuses a row from another room', async () => {
    const res = await admin.post(`${V}/racks`, { roomId: ids.room2, rowId: ids.row, name: 'B01' });
    expect(res.status).toBe(400);
  });

  it('read-only roles can view but not change', async () => {
    const noc = await Client.login(ctx.server, ctx.emails.noc);
    expect((await noc.get(`${V}/racks`)).status).toBe(200);
    expect((await noc.post(`${V}/datacenters`, { code: 'X', name: 'X' })).status).toBe(403);
  });
});

describe('rack placement rules (enforced by the database)', () => {
  it('places a device and rejects overlapping units on the same face', async () => {
    const a = await newDevice('r640');
    const b = await newDevice('r640');
    const c = await newDevice('r740');
    expect((await place(a, ids.rack, 10)).status).toBe(200);
    const same = await place(b, ids.rack, 10);
    expect(same.status).toBe(409);
    expect(same.body.error).toBe('placement_conflict');
    // A 2U device at U9 covers U9–U10.
    expect((await place(c, ids.rack, 9)).status).toBe(409);
    expect((await place(c, ids.rack, 11)).status).toBe(200);
  });

  it('allows half-depth equipment front and rear at the same unit, but not a full-depth device', async () => {
    const front = await newDevice('ccr');
    const rear = await newDevice('ccr');
    const full = await newDevice('r640');
    expect((await place(rear, ids.rack, 20, 'rear')).status).toBe(200);
    expect((await place(front, ids.rack, 20, 'front')).status).toBe(200);
    const res = await place(full, ids.rack, 20);
    expect(res.status).toBe(409);
  });

  it('rejects positions beyond the rack height and equipment deeper than the rack', async () => {
    const r740 = await newDevice('r740');
    const tooHigh = await place(r740, ids.rack, 42);
    expect(tooHigh.status).toBe(409);
    expect(tooHigh.body.error).toBe('does_not_fit');
    expect(tooHigh.body.message).toMatch(/exceed rack height 42U/);
    const deep = await newDevice('deep');
    const tooDeep = await place(deep, ids.rack, 30);
    expect(tooDeep.status).toBe(409);
    expect(tooDeep.body.message).toMatch(/1200 mm deep/);
  });

  it('assigns 0U equipment to a rack without a unit', async () => {
    const pdu = await newDevice('pdu');
    expect((await place(pdu, ids.rack)).status).toBe(200);
    const elev = await ok(admin.get(`${V}/racks/${ids.rack}/elevation`));
    expect(elev.zeroU.map((d: { id: string }) => d.id)).toContain(pdu);
  });

  it('only one of many concurrent placements into the same unit succeeds', async () => {
    const devs = await Promise.all(Array.from({ length: 10 }, () => newDevice('r640')));
    const results = await Promise.all(devs.map((d) => place(d, ids.rack2, 5)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });

  it('moves a device between units and racks, recording history', async () => {
    const d = await newDevice('r640');
    await ok(place(d, ids.rack2, 30));
    await ok(place(d, ids.rack2, 31));
    await ok(place(d, ids.rack, 35));
    const events = await ok(admin.get(`${V}/devices/${d}/events`));
    const moves = events.filter((e: { kind: string }) => e.kind === 'moved').map((e: { summary: string }) => e.summary);
    expect(moves[0]).toMatch(/A02 U31 to .*A01 U35/);
    expect(moves).toHaveLength(3);
  });

  it('refuses to shrink a rack below its equipment and to delete a non-empty rack', async () => {
    const shrink = await admin.patch(`${V}/racks/${ids.rack}`, { roomId: ids.room, rowId: ids.row, name: 'A01', uHeight: 20, gridX: 0, gridY: 0 });
    expect(shrink.status).toBe(409);
    expect(shrink.body.message).toMatch(/equipment above U20/);
    expect((await admin.delete(`${V}/racks/${ids.rack}`)).status).toBe(409);
  });

  it('decommissioned racks take no new equipment', async () => {
    const r = await ok(admin.post(`${V}/racks`, { roomId: ids.room2, name: 'OLD', status: 'decommissioned' }));
    const d = await newDevice('r640');
    expect((await place(d, r.id, 1)).body.error).toBe('rack_decommissioned');
  });

  it('reports occupancy counting a unit used front and rear only once', async () => {
    const list = await ok(admin.get(`${V}/racks?roomId=${ids.room}`));
    const a01 = list.find((r: { id: string }) => r.id === ids.rack);
    // r640@10, r740@11-12, ccr front+rear @20, r640@35  → units 10,11,12,20,35
    expect(a01.usedU).toBe(5);
    expect(a01.freeU).toBe(37);
  });
});

describe('reservations and dedicated racks', () => {
  it('reserved units take only the reserving customer’s equipment', async () => {
    const res = await ok(admin.post(`${V}/racks/${ids.rack2}/reservations`, { startU: 38, endU: 41, customerId: ctx.customers.acme, reason: 'ACME expansion' }));
    expect(res.startU).toBe(38);
    expect((await admin.post(`${V}/racks/${ids.rack2}/reservations`, { startU: 40, endU: 42, reason: 'overlap' })).status).toBe(409);
    const company = await newDevice('r640');
    const blocked = await place(company, ids.rack2, 39);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('units_reserved');
    const acmeBox = await newDevice('r640', { ownership: 'customer', customerId: ctx.customers.acme });
    expect((await place(acmeBox, ids.rack2, 39)).status).toBe(200);
  });

  it('cannot reserve units that hold someone else’s equipment', async () => {
    const res = await admin.post(`${V}/racks/${ids.rack2}/reservations`, { startU: 5, endU: 6, customerId: ctx.customers.globex, reason: 'x' });
    expect(res.status).toBe(409);
  });

  it('dedicated racks only accept their customer’s equipment', async () => {
    const rack = await ok(admin.post(`${V}/racks`, { roomId: ids.room2, name: 'GLX-1', customerId: ctx.customers.globex }));
    const acmeBox = await newDevice('r640', { ownership: 'customer', customerId: ctx.customers.acme });
    expect((await place(acmeBox, rack.id, 1)).body.error).toBe('rack_dedicated');
    const glx = await newDevice('r640', { ownership: 'customer', customerId: ctx.customers.globex });
    expect((await place(glx, rack.id, 1)).status).toBe(200);
  });

  it('customer-owned equipment must name its customer', async () => {
    const res = await admin.post(`${V}/devices`, { modelId: ids.r640, assetTag: 'NO-CUST', ownership: 'customer' });
    expect(res.status).toBe(400);
  });
});

describe('device lifecycle', () => {
  it('enforces the configured transitions and racking requirements', async () => {
    const d = await newDevice('r640');
    const skip = await admin.post(`${V}/devices/${d}/transition`, { to: 'active' });
    expect(skip.status).toBe(400);
    expect(skip.body.error).toBe('transition_not_allowed');
    const unplaced = await admin.post(`${V}/devices/${d}/transition`, { to: 'racked' });
    expect(unplaced.body.error).toBe('place_first');
    await ok(place(d, ids.rack, 25));
    await ok(admin.post(`${V}/devices/${d}/transition`, { to: 'racked' }));
    await ok(admin.post(`${V}/devices/${d}/transition`, { to: 'active', note: 'customer handover' }));
    expect(await ok(admin.get(`${V}/devices/${d}/transitions`))).toEqual(['racked', 'maintenance']);

    const out = await place(d, null);
    expect(out.status).toBe(400);
    expect(out.body.error).toBe('change_state_first');

    await ok(admin.post(`${V}/devices/${d}/transition`, { to: 'maintenance' }));
    const back = await ok(admin.post(`${V}/devices/${d}/transition`, { to: 'inventory', note: 'pulled for RMA' }));
    expect(back.location).toBeNull();
    // Its unit is free again.
    const other = await newDevice('r640');
    expect((await place(other, ids.rack, 25)).status).toBe(200);

    const history = await ok(admin.get(`${V}/devices/${d}/events`));
    expect(history.map((e: { kind: string }) => e.kind)).toEqual(['lifecycle', 'lifecycle', 'lifecycle', 'lifecycle', 'moved', 'created']);
    expect(history[0].summary).toMatch(/Maintenance → In inventory, removed from MUM1\/Hall 1\/A01 U25: pulled for RMA/);
  });

  it('retired equipment cannot be placed', async () => {
    const d = await newDevice('r640');
    await ok(admin.post(`${V}/devices/${d}/transition`, { to: 'retired' }));
    expect((await place(d, ids.rack, 2)).body.error).toBe('device_retired');
  });

  it('administrators can change the rules; operations admins cannot', async () => {
    const rules = await ok(admin.get(`${V}/lifecycle-rules`));
    const without = rules.transitions.filter(([a, b]: [string, string]) => !(a === 'inventory' && b === 'retired'));
    expect((await ops.agent.put(`${V}/lifecycle-rules`).set('X-CSRF-Token', ops.csrf).send({ transitions: without })).status).toBe(403);
    await ok(admin.agent.put(`${V}/lifecycle-rules`).set('X-CSRF-Token', admin.csrf).send({ transitions: without }));
    const d = await newDevice('r640');
    expect((await admin.post(`${V}/devices/${d}/transition`, { to: 'retired' })).status).toBe(400);
    await ok(admin.agent.put(`${V}/lifecycle-rules`).set('X-CSRF-Token', admin.csrf).send({ transitions: rules.transitions }));
    expect((await admin.post(`${V}/devices/${d}/transition`, { to: 'retired' })).status).toBe(200);
  });

  it('every change is audited and recorded in device history', async () => {
    const d = await newDevice('r640');
    await ok(admin.post(`${V}/devices/${d}/events`, { kind: 'maintenance', summary: 'Replaced PSU 2' }));
    const audit = await ctx.db.select().from(auditEvents).where(and(eq(auditEvents.targetId, d)));
    expect(audit.map((a) => a.action).sort()).toEqual(['device.create', 'device.maintenance']);
    const evs = await ctx.db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, d));
    expect(evs.some((e) => e.summary === 'Replaced PSU 2')).toBe(true);
  });

  it('a model’s size cannot change while devices use it', async () => {
    const res = await admin.patch(`${V}/models/${ids.r640}`, { manufacturerId: ids.dell, name: 'PowerEdge R640', category: 'server', uHeight: 2, depthMm: 750, fullDepth: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('model_in_use');
    expect((await admin.delete(`${V}/models/${ids.r640}`)).status).toBe(409);
  });
});

describe('tenant isolation for devices', () => {
  let acmeDevice: string;
  let globexDevice: string;
  beforeAll(async () => {
    acmeDevice = await newDevice('r640', { ownership: 'customer', customerId: ctx.customers.acme, purchaseCost: 1234, notes: 'internal: margin 30%' });
    globexDevice = await newDevice('r640', { ownership: 'customer', customerId: ctx.customers.globex });
  });

  it('customers list only their own equipment, without purchasing data or notes', async () => {
    const list = await ok(acme.get(`${V}/devices?pageSize=200`));
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((d: { customerId: string }) => d.customerId === ctx.customers.acme)).toBe(true);
    const mine = list.items.find((d: { id: string }) => d.id === acmeDevice);
    expect(mine).toBeTruthy();
    expect(mine).not.toHaveProperty('purchaseCost');
    expect(mine).not.toHaveProperty('notes');
    expect(mine).not.toHaveProperty('mgmtAddress');
  });

  it('another customer’s device is not found, and staff-only routes are refused', async () => {
    expect((await acme.get(`${V}/devices/${globexDevice}`)).status).toBe(404);
    expect((await acme.get(`${V}/devices/${acmeDevice}`)).status).toBe(200);
    for (const path of [`${V}/racks`, `${V}/tree`, `${V}/devices/${acmeDevice}/events`, `${V}/devices/export.csv`, `${V}/spare-parts`]) {
      expect((await acme.get(path)).status).toBe(403);
    }
    expect((await acme.post(`${V}/devices/${acmeDevice}/placement`, { rackId: null })).status).toBe(403);
  });
});

describe('CSV export and import', () => {
  it('exports with spreadsheet-formula protection', async () => {
    await newDevice('r640', { hostname: '=cmd|calc' });
    const res = await admin.get(`${V}/devices/export.csv?q=cmd`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toMatch(/^asset_tag,hostname,serial,manufacturer,model/);
    expect(res.text).toContain(`'=cmd|calc`);
  });

  const csv = [
    'asset_tag,manufacturer,model,hostname,serial,state,customer_code,datacenter,room,rack,position_u,face,warranty_expires',
    'IMP-1,Dell,PowerEdge R640,web-01,SN-IMP-1,active,ACME,MUM1,Hall 1,A01,40,front,2027-01-31',
    'IMP-2,Dell,PowerEdge R640,web-02,SN-IMP-2,inventory,,,,,,,',
    'IMP-3,Dell,PowerEdge R640,web-03,SN-IMP-3,active,,MUM1,Hall 1,A01,40,front,',
    'IMP-4,HPE,DL360,web-04,,inventory,,,,,,,',
    'IMP-2,Dell,PowerEdge R640,dup,,inventory,,,,,,,',
    'IMP-5,Dell,PowerEdge R640,web-05,,active,,,,,,,',
  ].join('\n');

  it('dry run validates every row against the database and changes nothing', async () => {
    const res = await ok(admin.post(`${V}/devices/import`, { csv, dryRun: true }));
    expect(res.dryRun).toBe(true);
    const byTag = Object.fromEntries(res.results.map((r: { assetTag: string; line: number; ok: boolean; message: string }) => [`${r.assetTag}@${r.line}`, r]));
    expect(byTag['IMP-1@2'].ok).toBe(true);
    expect(byTag['IMP-2@3'].ok).toBe(true);
    expect(byTag['IMP-3@4'].message).toMatch(/already occupied/);
    expect(byTag['IMP-4@5'].message).toMatch(/Unknown model/);
    expect(byTag['IMP-2@6'].message).toMatch(/asset tag/);
    expect(byTag['IMP-5@7'].message).toMatch(/needs a rack/);
    const [{ n }] = (await ctx.db.execute(sql`select count(*)::int as n from devices where asset_tag like 'IMP-%'`)).rows as { n: number }[];
    expect(n).toBe(0);
  });

  it('a real import creates the valid rows with their state, placement and history', async () => {
    const res = await ok(admin.post(`${V}/devices/import`, { csv, dryRun: false }));
    expect(res.created).toBe(2);
    expect(res.failed).toBe(4);
    const [imp1] = await ctx.db.select().from(devices).where(eq(devices.assetTag, 'IMP-1'));
    expect(imp1).toMatchObject({ lifecycleState: 'active', positionU: 40, customerId: ctx.customers.acme, ownership: 'customer', warrantyExpires: '2027-01-31' });
    const evs = await ok(admin.get(`${V}/devices/${imp1!.id}/events`));
    expect(evs.map((e: { kind: string }) => e.kind)).toEqual(['lifecycle', 'moved', 'created']);
  });

  it('rejects files without the required columns', async () => {
    const res = await admin.post(`${V}/devices/import`, { csv: 'hostname\nx', dryRun: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/asset_tag, manufacturer, model/);
  });
});

describe('bulk edit and labels', () => {
  it('applies bulk changes per device and reports the ones that fail', async () => {
    const a = await newDevice('r640');
    const b = await newDevice('r640');
    await ok(place(b, ids.rack2, 20));
    await ok(admin.post(`${V}/devices/${b}/transition`, { to: 'racked' }));
    const res = await ok(admin.post(`${V}/devices/bulk`, { ids: [a, b], set: { supplier: 'Dell India' }, transitionTo: 'reserved' }));
    expect(res.updated).toBe(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].id).toBe(b);
    // The failed device's supplier change rolled back with its failed transition.
    const [bRow] = await ctx.db.select().from(devices).where(eq(devices.id, b));
    expect(bRow!.supplier).toBeNull();
  });

  it('produces a label with a QR code linking to the device', async () => {
    const d = await newDevice('r640', { hostname: 'db-01', serial: 'ABC123' });
    const label = await ok(admin.get(`${V}/devices/${d}/label`));
    expect(label.url).toMatch(new RegExp(`/hardware/${d}$`));
    expect(label.qrSvg).toMatch(/^<svg/);
    expect(label.serial).toBe('ABC123');
  });
});

describe('spare parts', () => {
  it('tracks stock atomically and logs every movement', async () => {
    const part = await ok(admin.post(`${V}/spare-parts`, { kind: 'ssd', manufacturer: 'Samsung', partNumber: 'MZ7LH960', description: '960GB SATA SSD', quantity: 5, minQuantity: 2, datacenterId: ids.dc }));
    expect((await admin.post(`${V}/spare-parts`, { kind: 'ssd', partNumber: 'mz7lh960', description: 'dup', datacenterId: ids.dc })).status).toBe(409);
    const results = await Promise.all(Array.from({ length: 8 }, () => admin.post(`${V}/spare-parts/${part.id}/adjust`, { delta: -1, reason: 'replacement' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const list = await ok(admin.get(`${V}/spare-parts?lowStock=true`));
    expect(list.find((p: { id: string }) => p.id === part.id)).toMatchObject({ quantity: 0, lowStock: true });
    const moves = await ok(admin.get(`${V}/spare-parts/${part.id}/movements`));
    expect(moves).toHaveLength(6); // initial stock + 5 withdrawals
    expect((await admin.delete(`${V}/spare-parts/${part.id}`)).status).toBe(204);
  });
});

describe('summary', () => {
  it('reports live counts and capacity', async () => {
    const s = await ok(admin.get(`${V}/summary`));
    expect(s.counts.datacenters).toBe(1);
    expect(s.counts.racks).toBeGreaterThanOrEqual(3);
    expect(s.capacity.totalU).toBeGreaterThan(s.capacity.usedU);
    expect(s.devicesByState.active).toBeGreaterThanOrEqual(1);
    expect(s.capacity.reservedU).toBe(4);
  });
});
