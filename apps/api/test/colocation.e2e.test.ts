/**
 * Phase 7: colocation (allocations with contracted power, cross-connects,
 * shipments, visits), orders & services, and remote-hands / support tickets —
 * with a tenant-isolation check for every new resource.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, devices, powerReadings, rackReservations, roles, userRoles, users } from '../src/db/schema';
import { PasswordService } from '../src/auth/password.service';
import { Client, PASSWORD, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let acmeViewer: Client;
let globex: Client;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const D = '/api/v1/dcim';
const C = '/api/v1/colocation';
const S = '/api/v1/services';
const T = '/api/v1/tickets';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const future = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  // A read-only customer user.
  const [role] = await ctx.db.select().from(roles).where(and(eq(roles.orgId, ctx.org.id), eq(roles.systemKey, 'customer_viewer')));
  const [u] = await ctx.db
    .insert(users)
    .values({ orgId: ctx.org.id, email: 'viewer@acme.example', name: 'viewer', passwordHash: await new PasswordService().hash(PASSWORD), userType: 'customer', customerId: ctx.customers.acme })
    .returning();
  await ctx.db.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
  acmeViewer = await Client.login(ctx.server, 'viewer@acme.example');

  const dc = (await ok(admin.post(`${D}/datacenters`, { code: 'MUM1', name: 'Mumbai 1' }))).id;
  ids.dc = dc;
  const b = (await ok(admin.post(`${D}/buildings`, { datacenterId: dc, name: 'B1' }))).id;
  const room = (await ok(admin.post(`${D}/rooms`, { buildingId: b, name: 'Hall 1' }))).id;
  ids.rack = (await ok(admin.post(`${D}/racks`, { roomId: room, name: 'A01', uHeight: 42 }))).id;
  ids.rack2 = (await ok(admin.post(`${D}/racks`, { roomId: room, name: 'A02', uHeight: 42 }))).id;
  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell' }))).id;
  ids.model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'R650', category: 'server', uHeight: 2, fullDepth: true, typicalPowerW: 300 }))).id;
  const dev = async (tag: string, customerId: string | null) => (await ok(admin.post(`${D}/devices`, { modelId: ids.model, assetTag: tag, hostname: tag.toLowerCase(), initialState: 'inventory', customerId }))).id as string;
  ids.acmeSrv = await dev('ACME-01', ctx.customers.acme);
  ids.acmeSrv2 = await dev('ACME-02', ctx.customers.acme);
  ids.globexSrv = await dev('GLX-01', ctx.customers.globex);
  ids.ourSrv = await dev('OPS-01', null);
});

afterAll(async () => {
  await ctx?.close();
});

describe('rack space allocations', () => {
  it('are staff-only to create and computed from the rack size', async () => {
    const body = { customerId: ctx.customers.acme, rackId: ids.rack, kind: 'half', part: 1, contractedPowerW: 2000, feeds: 'a_b', breakerAmps: 16, voltage: 230, startDate: '2026-10-01' };
    expect((await acme.post(`${C}/allocations`, body)).status).toBe(403);
    expect((await noc.post(`${C}/allocations`, body)).status).toBe(403);
    const a = await ok(admin.post(`${C}/allocations`, body));
    expect(a).toMatchObject({ startU: 1, endU: 21, kind: 'half', contractedPowerW: 2000 });
    ids.alloc = a.id;
    // Quarter 4 of a 42U rack ends at the top.
    const q = await ok(admin.post(`${C}/allocations`, { ...body, customerId: ctx.customers.globex, kind: 'quarter', part: 4, contractedPowerW: 1000 }));
    expect(q).toMatchObject({ startU: 31, endU: 42 });
    ids.globexAlloc = q.id;
    // Overlapping space is refused by the database.
    const clash = await admin.post(`${C}/allocations`, { ...body, customerId: ctx.customers.globex, kind: 'custom', startU: 20, endU: 25, part: null });
    expect(clash.status).toBe(409);
    expect((await admin.post(`${C}/allocations`, { ...body, kind: 'custom', startU: 40, endU: 50, part: null })).body.error).toBe('invalid_range');
    // The units are held by a reservation that the rack screen cannot remove.
    const [res] = await ctx.db.select().from(rackReservations).where(eq(rackReservations.allocationId, a.id));
    expect(res).toMatchObject({ startU: 1, endU: 21, customerId: ctx.customers.acme });
    expect((await admin.delete(`${D}/racks/${ids.rack}/reservations/${res!.id}`)).body.error).toBe('managed_by_allocation');
  });

  it('keep other customers’ equipment out and show contracted vs used power', async () => {
    // Globex can't place equipment in Acme's half; Acme can.
    const g = await admin.post(`${D}/devices/${ids.globexSrv}/placement`, { rackId: ids.rack, positionU: 5, face: 'front' });
    expect(g.status).toBe(409);
    await ok(admin.post(`${D}/devices/${ids.acmeSrv}/placement`, { rackId: ids.rack, positionU: 5, face: 'front' }));
    await ok(admin.post(`${D}/devices/${ids.acmeSrv2}/placement`, { rackId: ids.rack, positionU: 7, face: 'front' }));
    await ctx.db.update(devices).set({ lifecycleState: 'active' }).where(sql`${devices.id} in (${ids.acmeSrv}, ${ids.acmeSrv2})`);
    // One server measured at 450 W; the other falls back to the model's typical 300 W (estimated).
    await ctx.db.insert(powerReadings).values({ orgId: ctx.org.id, deviceId: ids.acmeSrv, source: 'redfish', at: new Date(), watts: 450, periodSeconds: 60 });
    const [a] = await ok(acme.get(`${C}/allocations`));
    expect(a.power).toMatchObject({ measuredW: 450, estimatedW: 300, devices: 2, measuredPct: 22.5, totalPct: 37.5, overContract: false, mayExceed: false });
    expect(a).toMatchObject({ rackName: 'A01', datacenterCode: 'MUM1', notes: null });
    const detail = await ok(acme.get(`${C}/allocations/${a.id}`));
    expect(detail.devices.map((d: { asset_tag: string }) => d.asset_tag)).toEqual(['ACME-01', 'ACME-02']);
    // Above the contract only with the estimate included: "may exceed", not "over contract".
    await ok(admin.put(`${C}/allocations/${a.id}`, { contractedPowerW: 600, feeds: 'a_b' }));
    expect((await ok(acme.get(`${C}/allocations/${a.id}`))).power).toMatchObject({ overContract: false, mayExceed: true });
    // Measured draw alone above the contract.
    await ok(admin.put(`${C}/allocations/${a.id}`, { contractedPowerW: 400, feeds: 'a_b' }));
    expect((await ok(acme.get(`${C}/allocations/${a.id}`))).power).toMatchObject({ overContract: true, mayExceed: false });
    expect((await ok(acme.get(`${C}/overview`))).overContract).toHaveLength(1);
    // Fields left out of an update are kept.
    const kept = await ok(admin.put(`${C}/allocations/${a.id}`, { contractedPowerW: 2000, feeds: 'a_b' }));
    expect(kept).toMatchObject({ breakerAmps: 16, voltage: 230 });
  });

  it('are isolated per customer', async () => {
    expect((await ok(acme.get(`${C}/allocations`))).map((x: { id: string }) => x.id)).toEqual([ids.alloc]);
    expect((await ok(globex.get(`${C}/allocations`))).map((x: { id: string }) => x.id)).toEqual([ids.globexAlloc]);
    expect((await globex.get(`${C}/allocations/${ids.alloc}`)).status).toBe(404);
    expect((await acme.put(`${C}/allocations/${ids.alloc}`, { contractedPowerW: 1, feeds: 'single' })).status).toBe(403);
    expect((await ok(admin.get(`${C}/allocations`))).length).toBe(2);
  });

  it('count a device in one allocation only, even zero-U equipment', async () => {
    // A second Acme allocation in the same rack, and a zero-U device of Acme in that rack.
    const upper = await ok(admin.post(`${C}/allocations`, { customerId: ctx.customers.acme, rackId: ids.rack, kind: 'custom', startU: 22, endU: 25, contractedPowerW: 500, feeds: 'single', startDate: '2026-10-01' }));
    const pdu = (await ok(admin.post(`${D}/models`, { manufacturerId: (await ok(admin.get(`${D}/manufacturers`)))[0].id, name: 'Strip', category: 'other', uHeight: 0, fullDepth: false, typicalPowerW: 50 }))).id;
    const zeroU = (await ok(admin.post(`${D}/devices`, { modelId: pdu, assetTag: 'ACME-STRIP', initialState: 'inventory', customerId: ctx.customers.acme }))).id;
    await ok(admin.post(`${D}/devices/${zeroU}/placement`, { rackId: ids.rack, positionU: null, face: 'rear' }));
    await ctx.db.update(devices).set({ lifecycleState: 'active' }).where(eq(devices.id, zeroU));
    const list = await ok(acme.get(`${C}/allocations`));
    const total = list.reduce((s: number, x: { power: { estimatedW: number } }) => s + x.power.estimatedW, 0);
    expect(total).toBe(350); // 300 (ACME-02) + 50 (strip) once, not twice
    expect((await ok(acme.get(`${C}/overview`))).estimatedW).toBe(350);
    await ctx.db.update(devices).set({ lifecycleState: 'inventory' }).where(eq(devices.id, zeroU));
    await ok(admin.post(`${D}/devices/${zeroU}/placement`, { rackId: null, positionU: null, face: null }));
    await ok(admin.post(`${C}/allocations/${upper.id}/end`, { endDate: new Date().toISOString().slice(0, 10) }));
  });

  it('ending one frees the units and reports equipment still there', async () => {
    expect((await admin.post(`${C}/allocations/${ids.globexAlloc}/end`, { endDate: '2099-01-01' })).body.error).toBe('invalid_date');
    const r = await ok(admin.post(`${C}/allocations/${ids.globexAlloc}/end`, { endDate: '2026-10-09', reason: 'Contract ended' }));
    expect(r).toEqual({ id: ids.globexAlloc, devicesRemaining: 0 });
    expect(await ctx.db.select().from(rackReservations).where(eq(rackReservations.allocationId, ids.globexAlloc))).toEqual([]);
    expect((await admin.post(`${C}/allocations/${ids.globexAlloc}/end`, { endDate: '2026-10-09' })).status).toBe(409);
    // Now the space is free for Globex equipment… or anyone's.
    await ok(admin.post(`${D}/devices/${ids.globexSrv}/placement`, { rackId: ids.rack, positionU: 35, face: 'front' }));
    expect((await ok(globex.get(`${C}/allocations?status=active`))).length).toBe(0);
  });
});

describe('cross-connects', () => {
  it('customers request for themselves only; viewers cannot request', async () => {
    const body = { aDeviceId: ids.acmeSrv, aLabel: 'ACME-01 eth2', zLabel: 'Tata Communications MMR panel 3, port 12', loaReference: 'LOA-77', media: 'smf', speed: '10G' };
    expect((await acmeViewer.post(`${C}/cross-connects`, body)).status).toBe(403);
    // Staff without services.write (NOC) can read but not file requests.
    expect((await noc.post(`${C}/cross-connects`, { ...body, customerId: ctx.customers.acme })).status).toBe(403);
    expect((await noc.post(`${C}/shipments`, { customerId: ctx.customers.acme, datacenterId: ids.dc, carrier: 'DHL', description: 'x' })).status).toBe(403);
    expect((await acme.post(`${C}/cross-connects`, { ...body, customerId: ctx.customers.globex })).status).toBe(403);
    expect((await acme.post(`${C}/cross-connects`, { ...body, aDeviceId: ids.globexSrv })).body.error).toBe('invalid_device');
    const x = await ok(acme.post(`${C}/cross-connects`, { ...body, notes: 'customer cannot write staff notes' }));
    expect(x).toMatchObject({ status: 'requested', customerId: ctx.customers.acme, notes: null, requestedBy: ctx.emails.acmeAdmin });
    ids.xc = x.id;
    expect((await ok(globex.get(`${C}/cross-connects`))).length).toBe(0);
    expect((await globex.post(`${C}/cross-connects/${ids.xc}/status`, { status: 'rejected' })).status).toBe(404);
  });

  it('staff move it through its lifecycle; a circuit id is required to go live', async () => {
    expect((await acme.post(`${C}/cross-connects/${ids.xc}/status`, { status: 'approved' })).body.error).toBe('invalid_transition');
    await ok(admin.post(`${C}/cross-connects/${ids.xc}/status`, { status: 'approved' }));
    expect((await admin.post(`${C}/cross-connects/${ids.xc}/status`, { status: 'active' })).body.error).toBe('invalid_transition');
    await ok(admin.post(`${C}/cross-connects/${ids.xc}/status`, { status: 'in_progress' }));
    expect((await admin.post(`${C}/cross-connects/${ids.xc}/status`, { status: 'active' })).body.error).toBe('circuit_required');
    // Once work has started the customer can no longer withdraw it.
    expect((await acme.post(`${C}/cross-connects/${ids.xc}/status`, { status: 'rejected' })).status).toBe(400);
    const live = await ok(admin.post(`${C}/cross-connects/${ids.xc}/status`, { status: 'active', circuitId: 'XC-MUM1-0042' }));
    expect(live).toMatchObject({ status: 'active', circuitId: 'XC-MUM1-0042' });
    expect(live.completedAt).not.toBeNull();
    const [mine] = await ok(acme.get(`${C}/cross-connects`));
    expect(mine).toMatchObject({ status: 'active', circuitId: 'XC-MUM1-0042', cableId: null });
  });

  it('a customer can withdraw a request before work starts', async () => {
    const x = await ok(acme.post(`${C}/cross-connects`, { aLabel: 'ACME cage', zLabel: 'Airtel', media: 'mmf' }));
    const w = await ok(acme.post(`${C}/cross-connects/${x.id}/status`, { status: 'rejected' }));
    expect(w).toMatchObject({ status: 'rejected', statusReason: 'Withdrawn by the customer' });
  });
});

describe('shipments', () => {
  it('customers pre-announce; staff receive and deliver; others cannot see', async () => {
    expect((await acmeViewer.post(`${C}/shipments`, { datacenterId: ids.dc, carrier: 'DHL', description: 'x' })).status).toBe(403);
    const s = await ok(acme.post(`${C}/shipments`, { datacenterId: ids.dc, carrier: 'Blue Dart', trackingNumber: 'BD123456', expectedOn: '2026-10-12', packages: 3, description: '2 × R650 and rails', instructions: 'Hold in cage store' }));
    expect(s.status).toBe('expected');
    ids.ship = s.id;
    expect((await acme.post(`${C}/shipments/${s.id}/status`, { status: 'received' })).status).toBe(400);
    expect((await globex.post(`${C}/shipments/${s.id}/status`, { status: 'cancelled' })).status).toBe(404);
    expect((await ok(globex.get(`${C}/shipments`))).length).toBe(0);
    const r = await ok(admin.post(`${C}/shipments/${s.id}/status`, { status: 'received', storageLocation: 'Store B, shelf 4', packagesReceived: 2, conditionNote: 'One box missing; carrier notified' }));
    expect(r).toMatchObject({ status: 'received', receivedBy: ctx.emails.superAdmin, packagesReceived: 2 });
    expect((await ok(acme.get(`${C}/shipments`)))[0]).toMatchObject({ receivedBy: 'Datacenter team', createdBy: ctx.emails.acmeAdmin });
    // A received shipment can't be cancelled by the customer.
    expect((await acme.post(`${C}/shipments/${s.id}/status`, { status: 'cancelled' })).status).toBe(400);
    await ok(admin.post(`${C}/shipments/${s.id}/status`, { status: 'delivered' }));
    const [mine] = await ok(acme.get(`${C}/shipments`));
    expect(mine).toMatchObject({ status: 'delivered', conditionNote: 'One box missing; carrier notified' });
    expect(mine.closedAt).not.toBeNull();
  });

  it('staff must name an active customer', async () => {
    expect((await admin.post(`${C}/shipments`, { datacenterId: ids.dc, carrier: 'DHL', description: 'x' })).body.error).toBe('customer_required');
  });
});

describe('visits', () => {
  it('are requested by customers, approved and checked in by staff, without storing ID numbers', async () => {
    const body = { datacenterId: ids.dc, visitors: [{ name: 'Ravi Kumar', company: 'Acme', idLast4: '4821' }], startsAt: future(0.5), endsAt: future(3), purpose: 'Install two servers' };
    expect((await acme.post(`${C}/visits`, { ...body, visitors: [{ name: 'X', idLast4: '123456789012' }] })).status).toBe(400);
    expect((await acme.post(`${C}/visits`, { ...body, endsAt: future(0.25) })).status).toBe(400);
    expect((await acme.post(`${C}/visits`, { ...body, startsAt: future(-5), endsAt: future(2) })).body.error).toBe('invalid_time');
    const v = await ok(acme.post(`${C}/visits`, body));
    expect(v.status).toBe('requested');
    ids.visit = v.id;
    expect((await acme.post(`${C}/visits/${v.id}/status`, { status: 'approved' })).status).toBe(400);
    expect((await globex.post(`${C}/visits/${v.id}/status`, { status: 'cancelled' })).status).toBe(404);
    await ok(admin.post(`${C}/visits/${v.id}/status`, { status: 'approved', escort: true, note: 'Escort from security desk' }));
    expect((await admin.post(`${C}/visits/${v.id}/status`, { status: 'checked_out' })).body.error).toBe('invalid_transition');
    await ok(admin.post(`${C}/visits/${v.id}/status`, { status: 'checked_in', badge: 'V-17' }));
    await ok(admin.post(`${C}/visits/${v.id}/status`, { status: 'checked_out' }));
    const [mine] = await ok(acme.get(`${C}/visits`));
    expect(mine).toMatchObject({ status: 'checked_out', escort: true, badge: 'V-17', decidedBy: null });
    expect((await ok(globex.get(`${C}/visits`))).length).toBe(0);
    // The audit trail records the count of visitors, not their names.
    const audit = JSON.stringify(await ctx.db.select().from(auditEvents).where(eq(auditEvents.action, 'colo.visit_request')));
    expect(audit).not.toContain('Ravi Kumar');
  });

  it('a customer can cancel an approved visit', async () => {
    const v = await ok(acme.post(`${C}/visits`, { datacenterId: ids.dc, visitors: [{ name: 'A B' }], startsAt: future(48), endsAt: future(49), purpose: 'Audit' }));
    await ok(admin.post(`${C}/visits/${v.id}/status`, { status: 'approved' }));
    // Not let in two days early.
    expect((await admin.post(`${C}/visits/${v.id}/status`, { status: 'checked_in' })).body.error).toBe('outside_window');
    expect((await ok(acme.post(`${C}/visits/${v.id}/status`, { status: 'cancelled', note: 'Trip moved' }))).status).toBe('cancelled');
  });
});

describe('orders and services', () => {
  it('staff create services; customers see theirs without staff notes', async () => {
    const body = { customerId: ctx.customers.acme, kind: 'colocation', name: 'Half rack MUM1-A01', billingReference: 'WHMCS-4411', notes: 'discount until March', startDate: '2026-10-01' };
    expect((await acme.post(S, body)).status).toBe(403);
    const s = await ok(admin.post(S, body));
    ids.svc = s.id;
    expect(s.status).toBe('pending');
    const mine = await ok(acme.get(S));
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ name: 'Half rack MUM1-A01', notes: null, billingReference: 'WHMCS-4411' });
    expect((await ok(globex.get(S))).items).toHaveLength(0);
    expect((await globex.get(`${S}/${s.id}`)).status).toBe(404);
    // Linking an allocation to a service of another customer is refused.
    const g = await ok(admin.post(S, { customerId: ctx.customers.globex, kind: 'vps', name: 'VPS' }));
    expect((await admin.put(`${C}/allocations/${ids.alloc}`, { serviceId: g.id, contractedPowerW: 2000, feeds: 'a_b' })).body.error).toBe('invalid_service');
    await ok(admin.put(`${C}/allocations/${ids.alloc}`, { serviceId: s.id, contractedPowerW: 2000, feeds: 'a_b' }));
    expect((await ok(acme.get(`${S}/${s.id}`))).allocations).toHaveLength(1);
    // A service can't be moved to another customer.
    expect((await admin.put(`${S}/${s.id}`, { ...body, customerId: ctx.customers.globex })).body.error).toBe('customer_fixed');
    // Devices of another customer can't be attached.
    expect((await admin.put(`${S}/${s.id}`, { ...body, deviceId: ids.globexSrv })).body.error).toBe('invalid_device');
  });

  it('follow the lifecycle, recording each change', async () => {
    expect((await admin.post(`${S}/${ids.svc}/status`, { status: 'suspended' })).body.error).toBe('invalid_transition');
    await ok(admin.post(`${S}/${ids.svc}/status`, { status: 'active' }));
    await ok(admin.post(`${S}/${ids.svc}/status`, { status: 'suspended', reason: 'Overdue invoice' }));
    await ok(admin.post(`${S}/${ids.svc}/status`, { status: 'active' }));
    await ok(admin.post(`${S}/${ids.svc}/status`, { status: 'terminated', reason: 'Customer left' }));
    expect((await admin.post(`${S}/${ids.svc}/status`, { status: 'active' })).body.error).toBe('invalid_transition');
    const s = await ok(acme.get(`${S}/${ids.svc}`));
    expect(s.status).toBe('terminated');
    expect(s.endDate).not.toBeNull();
    expect(s.events.map((e: { toStatus: string | null }) => e.toStatus)).toEqual(['terminated', 'active', 'suspended', 'active', 'pending']);
    expect(s.events.every((e: { actorLabel: string | null }) => e.actorLabel === null)).toBe(true); // staff identities hidden from customers
  });
});

describe('tickets and remote hands', () => {
  it('customers open tickets for themselves; numbers are sequential', async () => {
    expect((await acmeViewer.post(T, { kind: 'support', subject: 'x', body: 'y' })).status).toBe(403);
    expect((await acme.post(T, { customerId: ctx.customers.globex, kind: 'support', subject: 'x', body: 'y' })).status).toBe(403);
    expect((await acme.post(T, { kind: 'remote_hands', subject: 'x', body: 'y', deviceId: ids.globexSrv })).body.error).toBe('invalid_device');
    const t = await ok(acme.post(T, { kind: 'remote_hands', priority: 'high', subject: 'Reseat PSU 2 on ACME-01', body: 'PSU 2 shows amber', deviceId: ids.acmeSrv, authorizedMinutes: 30 }));
    const t2 = await ok(globex.post(T, { kind: 'support', subject: 'Globex question', body: 'Hello' }));
    expect(t2.number).toBe(t.number + 1);
    ids.ticket = t.id;
    ids.gticket = t2.id;
    const internal = await ok(admin.post(T, { kind: 'other', subject: 'Replace aisle 3 lamp', body: 'internal' }));
    ids.internal = internal.id;
  });

  it('customers see only their tickets and never internal notes', async () => {
    await ok(admin.post(`${T}/${ids.ticket}/messages`, { body: 'Technician assigned, will check at 14:00', internal: false }));
    await ok(admin.post(`${T}/${ids.ticket}/messages`, { body: 'Customer has a history of loose PSUs', internal: true }));
    expect((await acme.post(`${T}/${ids.ticket}/messages`, { body: 'sneaky', internal: true })).status).toBe(403);
    const mine = await ok(acme.get(`${T}/${ids.ticket}`));
    expect(mine.messages.map((m: { body: string }) => m.body)).toEqual(['PSU 2 shows amber', 'Technician assigned, will check at 14:00']);
    expect(JSON.stringify(mine)).not.toContain('history of loose');
    const staffView = await ok(admin.get(`${T}/${ids.ticket}`));
    expect(staffView.messages.some((m: { internal: boolean }) => m.internal)).toBe(true);
    expect(staffView.firstResponseAt).not.toBeNull();
    expect((await ok(acme.get(`${T}?status=all`))).items.map((x: { id: string }) => x.id)).toEqual([ids.ticket]);
    expect((await acme.get(`${T}/${ids.gticket}`)).status).toBe(404);
    expect((await acme.get(`${T}/${ids.internal}`)).status).toBe(404);
    expect((await acme.post(`${T}/${ids.gticket}/messages`, { body: 'hi' })).status).toBe(404);
    expect((await ok(acmeViewer.get(`${T}/${ids.ticket}`))).subject).toBe('Reseat PSU 2 on ACME-01');
    expect((await acmeViewer.post(`${T}/${ids.ticket}/messages`, { body: 'x' })).status).toBe(403);
  });

  it('staff assign, set priority and log remote-hands time; going over the authorization is flagged', async () => {
    const staffList = await ok(admin.get(`${T}/assignees`));
    const nocUser = staffList.find((u: { email: string }) => u.email === ctx.emails.noc);
    expect((await acme.patch(`${T}/${ids.ticket}`, { assigneeUserId: nocUser.id })).status).toBe(403);
    expect((await acme.get(`${T}/assignees`)).status).toBe(403);
    const [acmeUser] = await ctx.db.select().from(users).where(eq(users.email, ctx.emails.acmeAdmin));
    expect((await admin.patch(`${T}/${ids.ticket}`, { assigneeUserId: acmeUser!.id })).body.error).toBe('invalid_assignee');
    await ok(admin.patch(`${T}/${ids.ticket}`, { assigneeUserId: nocUser.id, status: 'in_progress' }));
    expect((await acme.post(`${T}/${ids.ticket}/time`, { minutes: 5, note: 'x' })).status).toBe(403);
    const t1 = await ok(admin.post(`${T}/${ids.ticket}/time`, { minutes: 20, note: 'Reseated PSU 2, LED green' }));
    expect(t1.overAuthorized).toBe(false);
    await ok(admin.post(`${T}/${ids.ticket}/time`, { minutes: 5, note: 'Internal handover', billable: false }));
    const t2 = await ok(admin.post(`${T}/${ids.ticket}/time`, { minutes: 15, note: 'Checked PSU 1 as well' }));
    expect(t2).toMatchObject({ totalBillableMinutes: 35, overAuthorized: true });
    const mine = await ok(acme.get(`${T}/${ids.ticket}`));
    expect(mine.time.map((e: { minutes: number }) => e.minutes)).toEqual([20, 15]); // non-billable entries are staff-only
    expect(mine.minutesSpent).toBe(35);
    expect((await ok(admin.get(`${T}/${ids.ticket}`))).minutesSpent).toBe(40);
    expect(mine.assigneeUserId).toBeNull();
    expect(mine.assigneeName).toBeNull();
    // Staff appear to customers as the team, not by email.
    expect(JSON.stringify(mine)).not.toContain(ctx.emails.superAdmin);
    expect(mine.time[0].userLabel).toBe('Datacenter team');
    expect(JSON.stringify(mine.messages)).not.toContain('over the');
  });

  it('a customer reply reopens a resolved ticket; customers can close but not set other states', async () => {
    await ok(admin.patch(`${T}/${ids.ticket}`, { status: 'resolved' }));
    expect((await acme.patch(`${T}/${ids.ticket}`, { status: 'in_progress' })).status).toBe(400);
    await ok(acme.post(`${T}/${ids.ticket}/messages`, { body: 'PSU 2 went amber again' }));
    expect((await ok(admin.get(`${T}/${ids.ticket}`))).status).toBe('open');
    await ok(acme.patch(`${T}/${ids.ticket}`, { status: 'closed' }));
    expect((await acme.post(`${T}/${ids.ticket}/messages`, { body: 'one more' })).body.error).toBe('ticket_closed');
    expect((await acme.patch(`${T}/${ids.ticket}`, { status: 'open' })).status).toBe(400);
  });

  it('staff see every ticket including internal ones', async () => {
    const all = await ok(admin.get(`${T}?status=all`));
    expect(all.items.map((x: { id: string }) => x.id).sort()).toEqual([ids.ticket, ids.gticket, ids.internal].sort());
    expect((await ok(admin.get(`${T}?q=%23${(await ok(admin.get(`${T}/${ids.gticket}`))).number}`))).items).toHaveLength(1);
  });
});

describe('customer portal overview', () => {
  it('summarises only the customer’s own space, power, requests and bandwidth', async () => {
    const o = await ok(acme.get(`${C}/overview`));
    expect(o).toMatchObject({ allocations: 1, units: 21, contractedPowerW: 2000, measuredW: 450, estimatedW: 300, overContract: [] });
    expect(o.open.shipments).toBe(0);
    expect(o.activeCrossConnects).toBe(1);
    expect(o.bandwidth).toMatchObject({ ports: 0 });
    const g = await ok(globex.get(`${C}/overview`));
    expect(g).toMatchObject({ allocations: 0, contractedPowerW: 0, activeCrossConnects: 0 });
    expect(g.open.tickets).toBe(1);
    // Viewers can read the portal.
    expect((await ok(acmeViewer.get(`${C}/overview`))).allocations).toBe(1);
  });
});
