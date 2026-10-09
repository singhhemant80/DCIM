/**
 * Regression tests for defects found in the independent Phase 2 review.
 * Each test reproduces the original problem and asserts it is now refused.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, devices, racks } from '../src/db/schema';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let acme: Client;
const V = '/api/v1/dcim';
const ids: Record<string, string> = {};
let seq = 0;

async function ok<T = any>(res: Promise<import('supertest').Response>): Promise<T> {
  const r = await res;
  if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const dev = async (model: string, extra: Record<string, unknown> = {}) =>
  (await ok(admin.post(`${V}/devices`, { modelId: ids[model], assetTag: `R-${++seq}`, initialState: 'inventory', ...extra }))).id as string;
const rack = async (name: string, extra: Record<string, unknown> = {}) => (await ok(admin.post(`${V}/racks`, { roomId: ids.room, name, ...extra }))).id as string;
const place = (id: string, rackId: string, positionU?: number) => admin.post(`${V}/devices/${id}/placement`, { rackId, positionU, face: 'front' });

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  ids.dc = (await ok(admin.post(`${V}/datacenters`, { code: 'REG', name: 'Regression' }))).id;
  ids.b = (await ok(admin.post(`${V}/buildings`, { datacenterId: ids.dc, name: 'B' }))).id;
  ids.room = (await ok(admin.post(`${V}/rooms`, { buildingId: ids.b, name: 'R' }))).id;
  ids.mfr = (await ok(admin.post(`${V}/manufacturers`, { name: 'Dell' }))).id;
  ids.srv = (await ok(admin.post(`${V}/models`, { manufacturerId: ids.mfr, name: 'R640', category: 'server', uHeight: 1, depthMm: 700, fullDepth: true }))).id;
  ids.pdu = (await ok(admin.post(`${V}/models`, { manufacturerId: ids.mfr, name: 'PDU', category: 'pdu', uHeight: 0, fullDepth: false }))).id;
  ids.big = (await ok(admin.post(`${V}/models`, { manufacturerId: ids.mfr, name: 'R740', category: 'server', uHeight: 2, depthMm: 700, fullDepth: true }))).id;
});
afterAll(async () => ctx?.close());

describe('dedicated racks cannot be bypassed', () => {
  it('changing a racked device’s customer is checked against the rack’s dedication (single and bulk)', async () => {
    const r = await rack('DED-1', { customerId: ctx.customers.acme });
    const d = await dev('srv', { ownership: 'customer', customerId: ctx.customers.acme });
    await ok(place(d, r, 5));
    const patch = await admin.patch(`${V}/devices/${d}`, { modelId: ids.srv, assetTag: `R-${seq}`, ownership: 'customer', customerId: ctx.customers.globex });
    expect(patch.status).toBe(409);
    expect(patch.body.error).toBe('rack_dedicated');
    const bulk = await ok(admin.post(`${V}/devices/bulk`, { ids: [d], set: { customerId: ctx.customers.globex } }));
    expect(bulk.updated).toBe(0);
    expect(bulk.failed[0].message).toMatch(/dedicated/);
  });

  it('a rack holding someone else’s equipment cannot be rededicated or decommissioned', async () => {
    const r = await rack('DED-2');
    const d = await dev('srv', { ownership: 'customer', customerId: ctx.customers.acme });
    await ok(place(d, r, 3));
    const rededicate = await admin.patch(`${V}/racks/${r}`, { roomId: ids.room, name: 'DED-2', customerId: ctx.customers.globex });
    expect(rededicate.status).toBe(409);
    const decommission = await admin.patch(`${V}/racks/${r}`, { roomId: ids.room, name: 'DED-2', status: 'decommissioned' });
    expect(decommission.status).toBe(409);
    // Dedicating it to the customer who owns everything in it is fine.
    expect((await admin.patch(`${V}/racks/${r}`, { roomId: ids.room, name: 'DED-2', customerId: ctx.customers.acme })).status).toBe(200);
  });

  it('a dedicated rack can only be reserved for its own customer', async () => {
    const r = await rack('DED-3', { customerId: ctx.customers.acme });
    const res = await admin.post(`${V}/racks/${r}/reservations`, { startU: 1, endU: 2, customerId: ctx.customers.globex, reason: 'x' });
    expect(res.status).toBe(409);
  });
});

describe('concurrency', () => {
  it('a rack shrink and a placement above the new height never both succeed', async () => {
    for (let i = 0; i < 8; i++) {
      const r = await rack(`RACE-${i}`, { uHeight: 42 });
      const d = await dev('srv');
      const [shrink, put] = await Promise.all([admin.patch(`${V}/racks/${r}`, { roomId: ids.room, name: `RACE-${i}`, uHeight: 20 }), place(d, r, 30)]);
      expect([shrink.status, put.status]).not.toEqual([200, 200]);
      const [row] = await ctx.db.select({ h: racks.uHeight }).from(racks).where(eq(racks.id, r));
      const bad = await ctx.db.select().from(devices).where(and(eq(devices.rackId, r), sql`${devices.positionU} + ${devices.uHeight} - 1 > ${row!.h}`));
      expect(bad).toHaveLength(0);
    }
  });

  it('a placement and a conflicting reservation never both succeed', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await rack(`RES-RACE-${i}`);
      const d = await dev('srv');
      const [reserve, put] = await Promise.all([
        admin.post(`${V}/racks/${r}/reservations`, { startU: 10, endU: 12, customerId: ctx.customers.globex, reason: 'race' }),
        place(d, r, 11),
      ]);
      expect([reserve.status, put.status]).not.toEqual([201, 200]);
    }
  });
});

describe('0U equipment and model changes', () => {
  it('a 0U device cannot be marked racked or active without a rack', async () => {
    const pdu = await dev('pdu');
    const res = await admin.post(`${V}/devices/${pdu}/transition`, { to: 'racked' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('place_first');
    const r = await rack('PDU-RACK');
    await ok(place(pdu, r));
    expect((await admin.post(`${V}/devices/${pdu}/transition`, { to: 'racked' })).status).toBe(200);
  });

  it('a racked 0U device cannot switch to a model that takes rack units', async () => {
    const pdu = await dev('pdu');
    const r = await rack('PDU-RACK-2');
    await ok(place(pdu, r));
    const res = await admin.patch(`${V}/devices/${pdu}`, { modelId: ids.big, assetTag: `R-${seq}` });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unrack_first');
  });

  it('the database itself refuses a sized device in a rack without a unit', async () => {
    const d = await dev('srv');
    const r = await rack('DB-CHECK');
    const msg = await ctx.db
      .execute(sql`update devices set rack_id = ${r} where id = ${d}`)
      .then(() => 'succeeded', (e: { cause?: { constraint?: string } }) => e.cause?.constraint);
    expect(msg).toBe('devices_sized_needs_position_ck');
  });
});

describe('CSV import validation', () => {
  it('rejects invalid numbers and dates with readable messages, never raw SQL', async () => {
    const csv = [
      'asset_tag,manufacturer,model,cpu_count,ram_gb,purchase_cost,warranty_expires,datacenter,room,rack,position_u,state',
      'BAD-1,Dell,R640,-4,,,,,,,,inventory',
      'BAD-2,Dell,R640,,-9,,,,,,,inventory',
      'BAD-3,Dell,R640,,,-500,,,,,,inventory',
      'BAD-4,Dell,R640,,,,2024-13-45,,,,,inventory',
      'BAD-5,Dell,R640,99999999999,,,,,,,,inventory',
      `BAD-6,Dell,R640,,,,,REG,R,DED-2,1.5,active`,
    ].join('\n');
    const res = await ok(admin.post(`${V}/devices/import`, { csv, dryRun: true }));
    expect(res.created).toBe(0);
    for (const r of res.results) {
      expect(r.ok).toBe(false);
      expect(r.message).not.toMatch(/Failed query|insert into|params/i);
    }
    expect(res.results.map((r: { message: string }) => r.message.split(':')[0])).toEqual(['cpu_count', 'ram_gb', 'purchase_cost', 'warranty_expires', 'cpu_count', 'position_u']);
  });

  it('round-trips values that export protected against formula injection', async () => {
    const csv = "asset_tag,manufacturer,model,hostname\nRT-1,Dell,R640,'=not-a-formula";
    await ok(admin.post(`${V}/devices/import`, { csv, dryRun: false }));
    const [row] = await ctx.db.select().from(devices).where(eq(devices.assetTag, 'RT-1'));
    expect(row!.hostname).toBe('=not-a-formula');
  });

  it('audits states set by import', async () => {
    const r = await rack('IMP-AUD');
    const name = (await ctx.db.select({ n: racks.name }).from(racks).where(eq(racks.id, r)))[0]!.n;
    await ok(admin.post(`${V}/devices/import`, { csv: `asset_tag,manufacturer,model,datacenter,room,rack,position_u,state\nAUD-1,Dell,R640,REG,R,${name},7,active`, dryRun: false }));
    const [d] = await ctx.db.select().from(devices).where(eq(devices.assetTag, 'AUD-1'));
    const audits = await ctx.db.select().from(auditEvents).where(and(eq(auditEvents.targetId, d!.id), eq(auditEvents.action, 'device.transition')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ to: 'active', imported: true });
  });
});

describe('audit and search', () => {
  it('bulk updates are audited with the tenant and before/after values', async () => {
    const d = await dev('srv');
    await ok(admin.post(`${V}/devices/bulk`, { ids: [d], set: { customerId: ctx.customers.acme, supplier: 'Dell India' } }));
    const [a] = await ctx.db.select().from(auditEvents).where(and(eq(auditEvents.targetId, d), eq(auditEvents.action, 'device.bulk_update')));
    expect(a!.customerId).toBe(ctx.customers.acme);
    expect(a!.metadata).toMatchObject({ before: { customerId: null, supplier: null }, after: { customerId: ctx.customers.acme, supplier: 'Dell India' } });
  });

  it('customers cannot search by the staff-only management address', async () => {
    await dev('srv', { ownership: 'customer', customerId: ctx.customers.acme, mgmtAddress: '10.99.88.7' });
    const res = await ok(acme.get(`${V}/devices?q=10.99.88`));
    expect(res.total).toBe(0);
    const staff = await ok(admin.get(`${V}/devices?q=10.99.88`));
    expect(staff.total).toBe(1);
  });
});
