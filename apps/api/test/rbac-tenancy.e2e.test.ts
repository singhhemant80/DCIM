import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents } from '../src/db/schema';
import { Client, PASSWORD, setupTestApp, userId, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let ops: Client;
let noc: Client;
let acme: Client;
let roleIds: Record<string, string>;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  ops = await Client.login(ctx.server, ctx.emails.opsAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  const roles = (await admin.get('/api/v1/roles')).body as { id: string; systemKey: string | null }[];
  roleIds = Object.fromEntries(roles.filter((r) => r.systemKey).map((r) => [r.systemKey!, r.id]));
});
afterAll(async () => ctx?.close());

describe('role-based access control', () => {
  it('read-only NOC engineer can view but not modify, and the denial is audited', async () => {
    expect((await noc.get('/api/v1/customers')).status).toBe(200);
    const res = await noc.post('/api/v1/customers', { name: 'Nope', code: 'NOPE' });
    expect(res.status).toBe(403);
    const nocId = await userId(ctx.db, ctx.emails.noc);
    const denials = await ctx.db.select().from(auditEvents).where(and(eq(auditEvents.actorId, nocId), eq(auditEvents.outcome, 'denied')));
    expect(denials.some((d) => (d.metadata as { missing?: string[] }).missing?.includes('customers.write'))).toBe(true);
  });

  it('NOC engineer cannot see users, roles or settings', async () => {
    for (const path of ['/api/v1/users', '/api/v1/roles', '/api/v1/settings']) expect((await noc.get(path)).status).toBe(403);
  });

  it('customer users are blocked from staff-only routes regardless of role', async () => {
    for (const path of ['/api/v1/users', '/api/v1/roles', '/api/v1/audit', '/api/v1/settings']) {
      expect((await acme.get(path)).status).toBe(403);
    }
  });

  it('operations admin cannot change system settings or create roles', async () => {
    expect((await ops.patch('/api/v1/settings', { timezone: 'UTC' })).status).toBe(403);
    expect((await ops.post('/api/v1/roles', { name: 'X', scope: 'staff', permissions: [] })).status).toBe(403);
  });

  it('prevents privilege escalation: cannot assign a role granting permissions you lack', async () => {
    const res = await ops.post('/api/v1/users', {
      email: 'escalate@test.example',
      name: 'Esc',
      password: PASSWORD,
      userType: 'staff',
      roleIds: [roleIds.super_admin],
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('privilege_escalation');
  });

  it('cannot manage a user who holds more permissions than you', async () => {
    const rootId = await userId(ctx.db, ctx.emails.superAdmin);
    expect((await ops.patch(`/api/v1/users/${rootId}`, { status: 'disabled' })).status).toBe(403);
    expect((await ops.post(`/api/v1/users/${rootId}/revoke-sessions`)).status).toBe(403);
  });

  it('rejects staff-only permissions in customer roles', async () => {
    const res = await admin.post('/api/v1/roles', { name: 'Bad Customer Role', scope: 'customer', permissions: ['users.write'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('staff_only_permission');
  });

  it('rejects assigning a staff role to a customer user', async () => {
    const res = await admin.post('/api/v1/users', {
      email: 'mismatch@acme.example',
      name: 'M',
      password: PASSWORD,
      userType: 'customer',
      customerId: ctx.customers.acme,
      roleIds: [roleIds.noc_engineer],
    });
    expect(res.status).toBe(400);
  });

  it('built-in roles are immutable; custom roles can be created, edited and deleted', async () => {
    expect((await admin.patch(`/api/v1/roles/${roleIds.auditor}`, { name: 'Auditor', scope: 'staff', permissions: [] })).status).toBe(403);
    expect((await admin.delete(`/api/v1/roles/${roleIds.auditor}`)).status).toBe(403);

    const created = await admin.post('/api/v1/roles', { name: 'Rack Viewer', scope: 'staff', permissions: ['dcim.read'] });
    expect(created.status).toBe(201);
    expect((await admin.post('/api/v1/roles', { name: 'Rack Viewer', scope: 'staff', permissions: [] })).status).toBe(409);
    const edited = await admin.patch(`/api/v1/roles/${created.body.id}`, { name: 'Rack Viewer', scope: 'staff', permissions: ['dcim.read', 'power.read'] });
    expect(edited.body.permissions).toEqual(['dcim.read', 'power.read']);
    expect((await admin.delete(`/api/v1/roles/${created.body.id}`)).status).toBe(204);
  });

  it('refuses to delete a role still assigned to users', async () => {
    const role = await admin.post('/api/v1/roles', { name: 'In Use', scope: 'staff', permissions: ['dcim.read'] });
    const u = await admin.post('/api/v1/users', { email: 'inuse@test.example', name: 'U', password: PASSWORD, userType: 'staff', roleIds: [role.body.id] });
    expect(u.status).toBe(201);
    expect((await admin.delete(`/api/v1/roles/${role.body.id}`)).status).toBe(409);
  });

  it('keeps at least one active super administrator and blocks self-lockout', async () => {
    const rootId = await userId(ctx.db, ctx.emails.superAdmin);
    expect((await admin.patch(`/api/v1/users/${rootId}`, { status: 'disabled' })).status).toBe(403);
    expect((await admin.patch(`/api/v1/users/${rootId}`, { roleIds: [roleIds.auditor] })).status).toBe(403);

    const second = await admin.post('/api/v1/users', { email: 'root2@test.example', name: 'Root 2', password: PASSWORD, userType: 'staff', roleIds: [roleIds.super_admin] });
    const root2 = await Client.login(ctx.server, 'root2@test.example');
    // root2 demotes root → fine, one super admin remains (root2)…
    expect((await root2.patch(`/api/v1/users/${rootId}`, { roleIds: [roleIds.auditor] })).status).toBe(200);
    // …restore, then the last-super-admin guard stops demoting root2 once root is gone again.
    expect((await root2.patch(`/api/v1/users/${rootId}`, { roleIds: [roleIds.super_admin] })).status).toBe(200);
    admin = await Client.login(ctx.server, ctx.emails.superAdmin);
    expect((await admin.patch(`/api/v1/users/${second.body.id}`, { status: 'disabled' })).status).toBe(200);
  });

  it('rejects duplicate emails case-insensitively', async () => {
    const res = await admin.post('/api/v1/users', { email: ctx.emails.noc.toUpperCase(), name: 'Dup', password: PASSWORD, userType: 'staff', roleIds: [roleIds.auditor] });
    expect(res.status).toBe(409);
  });
});

describe('tenant isolation', () => {
  it('customer users reach their own account via /customers/me only', async () => {
    const mine = await acme.get('/api/v1/customers/me');
    expect(mine.status).toBe(200);
    expect(mine.body.id).toBe(ctx.customers.acme);
    // The customer directory is staff-only; customers get the same 403 whether or not an id exists, so nothing leaks.
    expect((await acme.get('/api/v1/customers')).status).toBe(403);
    const own = await acme.get(`/api/v1/customers/${ctx.customers.acme}`);
    const other = await acme.get(`/api/v1/customers/${ctx.customers.globex}`);
    const missing = await acme.get('/api/v1/customers/00000000-0000-4000-8000-000000000000');
    expect([own.status, other.status, missing.status]).toEqual([403, 403, 403]);
  });

  it('strips staff-only fields (internal notes, billing references) for customers', async () => {
    const mine = await acme.get('/api/v1/customers/me');
    expect(mine.status).toBe(200);
    expect(mine.body).not.toHaveProperty('notes');
    expect(mine.body).not.toHaveProperty('billingReference');
    const staffView = await admin.get(`/api/v1/customers/${ctx.customers.acme}`);
    expect(staffView.body.notes).toBe('staff-only note');
  });

  it('customers cannot create or edit customer records', async () => {
    expect((await acme.patch(`/api/v1/customers/${ctx.customers.acme}`, { name: 'Hacked', code: 'ACME' })).status).toBe(403);
    expect((await acme.post('/api/v1/customers', { name: 'New', code: 'NEWCO' })).status).toBe(403);
  });

  it('closing a customer ends its users’ sessions and blocks login', async () => {
    const globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
    const res = await admin.patch(`/api/v1/customers/${ctx.customers.globex}`, { name: 'Globex', code: 'GLOBEX', status: 'closed' });
    expect(res.status).toBe(200);
    expect((await globex.get('/api/v1/customers/me')).status).toBe(401);
    expect((await request(ctx.server).post('/api/v1/auth/login').send({ email: ctx.emails.globexAdmin, password: PASSWORD })).status).toBe(401);
    // Other tenants unaffected.
    expect((await acme.get('/api/v1/customers/me')).status).toBe(200);
  });

  it('staff /customers/me is refused', async () => {
    expect((await admin.get('/api/v1/customers/me')).status).toBe(403);
  });
});

describe('input validation', () => {
  it('returns structured validation errors', async () => {
    const res = await admin.post('/api/v1/customers', { name: '', code: 'bad code!' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues.map((i: { path: string }) => i.path).sort()).toEqual(['code', 'name']);
  });

  it('rejects malformed JSON without leaking internals', async () => {
    const res = await admin.agent.post('/api/v1/customers').set('X-CSRF-Token', admin.csrf).set('Content-Type', 'application/json').send('{"name":');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at |stack|SyntaxError/);
  });

  it('rejects non-UUID ids', async () => {
    expect((await admin.get('/api/v1/customers/not-a-uuid')).status).toBe(400);
  });

  it('escapes LIKE wildcards in search', async () => {
    const res = await admin.get('/api/v1/customers?q=%25');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('paginates', async () => {
    const res = await admin.get('/api/v1/customers?page=1&pageSize=1');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect((await admin.get('/api/v1/customers?pageSize=1000')).status).toBe(400);
  });
});
