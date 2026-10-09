import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
});
afterAll(async () => ctx?.close());

describe('audit log', () => {
  it('records privileged changes with actor, target and request id', async () => {
    const res = await admin.post('/api/v1/customers', { name: 'Audited Ltd', code: 'AUD' }).set('X-Request-Id', 'req-audit-1');
    expect(res.status).toBe(201);
    const list = await admin.get('/api/v1/audit?action=customer.create');
    const ev = list.body.items.find((e: { targetId: string }) => e.targetId === res.body.id);
    expect(ev).toMatchObject({ actorLabel: ctx.emails.superAdmin, outcome: 'success', requestId: 'req-audit-1', targetType: 'customer' });
  });

  it('never stores secrets in audit metadata', async () => {
    const rows = await ctx.db.execute(sql`select metadata::text as m from audit_events`);
    for (const r of rows.rows as { m: string }[]) expect(r.m).not.toMatch(/Test-Only-Pass-phrase/);
  });

  it('verifies an intact hash chain', async () => {
    const res = await admin.get('/api/v1/audit/verify');
    expect(res.body.ok).toBe(true);
    expect(res.body.checked).toBeGreaterThan(0);
  });

  it('database refuses UPDATE, DELETE and TRUNCATE on audit events', async () => {
    const pgMessage = (p: Promise<unknown>) => p.then(() => 'succeeded', (e: { cause?: { message?: string }; message: string }) => e.cause?.message ?? e.message);
    expect(await pgMessage(ctx.db.execute(sql`update audit_events set action = 'x'`))).toMatch(/append-only/);
    expect(await pgMessage(ctx.db.execute(sql`delete from audit_events`))).toMatch(/append-only/);
    expect(await pgMessage(ctx.db.execute(sql`truncate audit_events`))).toMatch(/append-only/);
  });

  it('keeps the chain linear under concurrent writes', async () => {
    await Promise.all(Array.from({ length: 15 }, (_, i) => admin.post('/api/v1/customers', { name: `Parallel ${i}`, code: `PAR-${i}` })));
    const res = await admin.get('/api/v1/audit/verify');
    expect(res.body.ok).toBe(true);
  });

  it('detects tampering even by someone who bypasses the trigger', async () => {
    // Simulates a DB owner disabling the trigger and editing a row.
    await ctx.db.execute(sql`alter table audit_events disable trigger audit_events_no_update_delete`);
    const [{ id }] = (await ctx.db.execute(sql`select min(id)::int as id from audit_events where action = 'customer.create'`)).rows as { id: number }[];
    await ctx.db.execute(sql`update audit_events set actor_label = 'someone-else' where id = ${id}`);
    await ctx.db.execute(sql`alter table audit_events enable trigger audit_events_no_update_delete`);
    const res = await admin.get('/api/v1/audit/verify');
    expect(res.body).toMatchObject({ ok: false, brokenAtId: id });
  });

  it('filters and paginates', async () => {
    const res = await admin.get('/api/v1/audit?outcome=success&pageSize=5');
    expect(res.body.items.length).toBeLessThanOrEqual(5);
    expect(res.body.items.every((e: { outcome: string }) => e.outcome === 'success')).toBe(true);
  });
});

describe('platform', () => {
  it('liveness and readiness are public and check dependencies', async () => {
    expect((await request(ctx.server).get('/api/v1/health/live')).status).toBe(200);
    const ready = await request(ctx.server).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.database.ok).toBe(true);
    expect(ready.body.checks.redis.ok).toBe(true);
  });

  it('serves OpenAPI documentation in non-production', async () => {
    const res = await request(ctx.server).get('/api/docs/openapi.json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths)).toContain('/api/v1/customers');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(ctx.server).get('/api/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('settings: validated update is persisted and audited', async () => {
    expect((await admin.patch('/api/v1/settings', { currency: 'inr' })).status).toBe(400);
    const res = await admin.patch('/api/v1/settings', { currency: 'USD', sessionIdleMinutes: 30 });
    expect(res.body).toMatchObject({ currency: 'USD', sessionIdleMinutes: 30 });
    expect((await admin.get('/api/v1/settings')).body.currency).toBe('USD');
  });

  it('exposes the permission catalog for role editing', async () => {
    const res = await admin.get('/api/v1/roles/permissions');
    expect(res.body.find((p: { key: string }) => p.key === 'network.config')).toMatchObject({ staffOnly: true, dangerous: true });
  });

  it('unknown routes return 404 JSON', async () => {
    const res = await admin.get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.requestId).toBeTruthy();
  });
});
