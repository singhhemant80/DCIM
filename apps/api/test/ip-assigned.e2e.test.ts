/**
 * The date an IP address was given to its customer: set when the customer
 * changes (by any writer, through a database trigger), kept by other edits,
 * cleared on release; shown to staff and to the customer.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let acme: Client;
let globex: Client;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201, 204].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const setAt = (id: string, when: string) => ctx.db.execute(sql`update ip_addresses set assigned_at = ${when}::timestamptz where id = ${id}`);
const row = async (id: string) => (await ctx.db.execute<{ assigned_at: string | null }>(sql`select assigned_at from ip_addresses where id = ${id}`)).rows[0]!;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  await ok(admin.post('/api/v1/ipam/prefixes', { prefix: '198.18.40.0/24', status: 'active' }));
});
afterAll(async () => {
  await ctx?.close();
});

describe('IP assignment date', () => {
  it('set when given to a customer and shown to that customer; organization addresses have none', async () => {
    const a = await ok(admin.post('/api/v1/ipam/addresses', { address: '198.18.40.10', customerId: ctx.customers.acme }));
    const own = await ok(admin.post('/api/v1/ipam/addresses', { address: '198.18.40.11' }));
    const list = await ok(admin.get('/api/v1/ipam/addresses?q=198.18.40.0/24'));
    const by = Object.fromEntries(list.items.map((x: { address: string }) => [x.address, x]));
    expect(Math.abs(Date.parse(by['198.18.40.10'].assignedAt) - Date.now())).toBeLessThan(60_000);
    expect(by['198.18.40.11'].assignedAt).toBeNull();
    const mine = await ok(acme.get('/api/v1/ipam/addresses'));
    expect(mine.items.find((x: { id: string }) => x.id === a.id).assignedAt).toBe(by['198.18.40.10'].assignedAt);

    // Other edits keep the date; a new customer gets a new one.
    await setAt(a.id, '2025-03-01T10:00:00Z');
    await ok(admin.patch(`/api/v1/ipam/addresses/${a.id}`, { status: 'allocated', customerId: ctx.customers.acme, dnsName: 'web1.acme.example' }));
    expect(new Date((await row(a.id)).assigned_at!).toISOString()).toBe('2025-03-01T10:00:00.000Z');
    await ok(admin.patch(`/api/v1/ipam/addresses/${a.id}`, { status: 'allocated', customerId: ctx.customers.globex }));
    expect(Date.parse((await row(a.id)).assigned_at!)).toBeGreaterThan(Date.parse('2026-01-01'));
    expect((await ok(globex.get('/api/v1/ipam/addresses'))).items.map((x: { id: string }) => x.id)).toContain(a.id);

    // Released: no date; allocated again to the same customer: a new date.
    await ok(admin.post(`/api/v1/ipam/addresses/${a.id}/release`, {}));
    expect((await row(a.id)).assigned_at).toBeNull();
    const again = await ok(admin.post('/api/v1/ipam/addresses', { address: '198.18.40.10', customerId: ctx.customers.globex }));
    expect((await row(again.id)).assigned_at).not.toBeNull();
    // The organization's own address given to a customer later.
    await ok(admin.patch(`/api/v1/ipam/addresses/${own.id}`, { status: 'allocated', customerId: ctx.customers.acme }));
    expect((await row(own.id)).assigned_at).not.toBeNull();
  });

  it('writers outside IPAM (hypervisor sync) get a date too', async () => {
    const org = (await ctx.db.execute<{ id: string }>(sql`select org_id as id from customers where id = ${ctx.customers.acme}`)).rows[0]!.id;
    const r = await ctx.db.execute<{ assigned_at: string | null }>(sql`
      insert into ip_addresses (org_id, address, status, customer_id, source) values (${org}, '198.18.40.50', 'allocated', ${ctx.customers.acme}, 'hypervisor') returning assigned_at`);
    expect(r.rows[0]!.assigned_at).not.toBeNull();
  });
});
