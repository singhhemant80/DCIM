/**
 * Phase 8: API keys, the event bus, outbound webhooks (signing, retries,
 * no duplicate deliveries), the WHMCS integration (signatures, duplicate
 * events, lifecycle sync, reconciliation, usage), workflows (conditions,
 * approvals with four eyes, dry-run, loop guard), reports (CSV/PDF/schedules)
 * and incidents/maintenance notices with tenant isolation.
 */
import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiKeys,
  auditEvents,
  billingEvents,
  customers,
  devices,
  domainEvents,
  interfaces,
  notifications,
  reportSchedules,
  roles,
  serviceEvents,
  services,
  ticketMessages,
  tickets,
  userRoles,
  users,
  webhookDeliveries,
  workflowRuns,
} from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { PasswordService } from '../src/auth/password.service';
import { deliverWebhooks, dispatchEvents, runWorkflows, signWebhook, type AutomationDeps } from '../src/worker/automation/dispatch';
import { runReportSchedules } from '../src/worker/automation/reports';
import type { EmailMessage } from '../src/worker/monitoring/notify';
import { Client, PASSWORD, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let ops: Client;
let noc: Client;
let acme: Client;
let globex: Client;
let deps: AutomationDeps;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}
const bearer = (token: string) => ({
  get: (path: string) => request(ctx.server).get(path).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object = {}) => request(ctx.server).post(path).set('Authorization', `Bearer ${token}`).send(body),
});
const silent = pino({ level: 'silent' });
/** Runs the worker's event pipeline once. */
async function pump() {
  await dispatchEvents(deps);
  await runWorkflows(deps);
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  ops = await Client.login(ctx.server, ctx.emails.opsAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  deps = { db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, allowPrivate: true };

  const D = '/api/v1/dcim';
  ids.dc = (await ok(admin.post(`${D}/datacenters`, { code: 'BOM1', name: 'Mumbai 1' }))).id;
  const b = (await ok(admin.post(`${D}/buildings`, { datacenterId: ids.dc, name: 'B1' }))).id;
  const room = (await ok(admin.post(`${D}/rooms`, { buildingId: b, name: 'Hall 1' }))).id;
  ids.rack = (await ok(admin.post(`${D}/racks`, { roomId: room, name: 'A01', uHeight: 42 }))).id;
  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell' }))).id;
  ids.model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'R650', category: 'server', uHeight: 2, fullDepth: true, typicalPowerW: 300 }))).id;
  ids.acmeSrv = (await ok(admin.post(`${D}/devices`, { modelId: ids.model, assetTag: 'ACME-01', hostname: 'acme-01', initialState: 'inventory', customerId: ctx.customers.acme }))).id;
  // Place it so Acme has equipment at BOM1.
  await ctx.db.update(devices).set({ rackId: ids.rack, positionU: 10, face: 'front' } as never).where(eq(devices.id, ids.acmeSrv));
});

afterAll(async () => {
  await ctx?.close();
});

/* ====================================================================== API keys */

describe('API keys', () => {
  it('are created by staff with apikeys.manage, shown once and stored hashed', async () => {
    expect((await noc.post('/api/v1/api-keys', { name: 'x', scopes: ['dcim.read'] })).status).toBe(403);
    expect((await acme.post('/api/v1/api-keys', { name: 'x', scopes: ['dcim.read'] })).status).toBe(403);
    const k = await ok(admin.post('/api/v1/api-keys', { name: 'read-only', scopes: ['services.read', 'dcim.read'], expiresInDays: 30 }));
    expect(k.token).toMatch(/^ndc_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    ids.readKey = k.token;
    ids.readKeyId = k.id;
    const list = await ok(admin.get('/api/v1/api-keys'));
    const row = list.find((x: { id: string }) => x.id === k.id);
    expect(row.prefix).toMatch(/^ndc_[0-9a-f]{12}_…$/);
    expect(JSON.stringify(list)).not.toContain(k.token.split('_')[2]);
    const [stored] = await ctx.db.select().from(apiKeys).where(eq(apiKeys.id, k.id));
    expect(stored!.secretHash).not.toContain(k.token);
  });

  it('authenticate with Bearer, limited to their scopes, without CSRF', async () => {
    const key = bearer(ids.readKey);
    expect((await key.get('/api/v1/services')).status).toBe(200);
    expect((await key.get('/api/v1/customers')).status).toBe(403);
    // A write needs a write scope; with one, no CSRF token is needed.
    expect((await key.post('/api/v1/services', { customerId: ctx.customers.acme, kind: 'other', name: 'via key' })).status).toBe(403);
    const w = await ok(admin.post('/api/v1/api-keys', { name: 'writer', scopes: ['services.read', 'services.write'] }));
    const created = await bearer(w.token).post('/api/v1/services', { customerId: ctx.customers.acme, kind: 'other', name: 'Created by key' });
    expect(created.status).toBe(201);
    const [a] = await ctx.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'service.create'), eq(auditEvents.targetId, created.body.id)));
    expect(a!.actorType).toBe('api_key');
    expect(a!.actorLabel).toContain('writer');
  });

  it('cannot manage keys, sign in flows or approvals (session only)', async () => {
    const key = bearer(ids.readKey);
    expect((await key.get('/api/v1/api-keys')).body.error).toBe('session_required');
    expect((await key.get('/api/v1/auth/me')).body.error).toBe('session_required');
    expect((await key.post('/api/v1/workflows/runs/00000000-0000-0000-0000-000000000000/approve')).body.error).toBe('session_required');
    // Accounts, roles and security settings can't be changed with a key, whatever its scopes.
    const admin2 = await ok(admin.post('/api/v1/api-keys', { name: 'too powerful', scopes: ['users.read', 'users.write', 'roles.read', 'settings.read', 'settings.write'] }));
    for (const path of ['/api/v1/users', '/api/v1/roles', '/api/v1/settings']) expect((await bearer(admin2.token).get(path)).body.error).toBe('session_required');
    expect((await bearer(admin2.token).post('/api/v1/users', { email: 'x@test.example', name: 'x', userType: 'staff', roleIds: [] })).body.error).toBe('session_required');
  });

  it('stop working when revoked, expired, wrong, or when the owner is disabled or loses the permission', async () => {
    expect((await bearer('ndc_000000000000_' + 'A'.repeat(43)).get('/api/v1/services')).status).toBe(401);
    expect((await bearer(ids.readKey.slice(0, -1) + (ids.readKey.endsWith('A') ? 'B' : 'A')).get('/api/v1/services')).status).toBe(401);

    // A separate owner we can disable.
    const [role] = await ctx.db.select().from(roles).where(and(eq(roles.orgId, ctx.org.id), eq(roles.systemKey, 'super_admin')));
    const [u] = await ctx.db.insert(users).values({ orgId: ctx.org.id, email: 'keyowner@test.example', name: 'keyowner', passwordHash: await new PasswordService().hash(PASSWORD), userType: 'staff' }).returning();
    await ctx.db.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
    const owner = await Client.login(ctx.server, 'keyowner@test.example');
    const k = await ok(owner.post('/api/v1/api-keys', { name: 'owner key', scopes: ['services.read'] }));
    expect((await bearer(k.token).get('/api/v1/services')).status).toBe(200);
    // Losing the role takes the scope away.
    await ctx.db.delete(userRoles).where(eq(userRoles.userId, u!.id));
    expect((await bearer(k.token).get('/api/v1/services')).status).toBe(403);
    await ctx.db.insert(userRoles).values({ userId: u!.id, roleId: role!.id });
    expect((await bearer(k.token).get('/api/v1/services')).status).toBe(200);
    await ctx.db.update(users).set({ status: 'disabled' }).where(eq(users.id, u!.id));
    expect((await bearer(k.token).get('/api/v1/services')).status).toBe(401);

    await ctx.db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, ids.readKeyId));
    expect((await bearer(ids.readKey).get('/api/v1/services')).status).toBe(401);
    await ctx.db.update(apiKeys).set({ expiresAt: null }).where(eq(apiKeys.id, ids.readKeyId));
    expect((await bearer(ids.readKey).get('/api/v1/services')).status).toBe(200);
    await ok(admin.delete(`/api/v1/api-keys/${ids.readKeyId}`));
    expect((await bearer(ids.readKey).get('/api/v1/services')).status).toBe(401);
    expect((await admin.delete(`/api/v1/api-keys/${ids.readKeyId}`)).status).toBe(404);
  });
});

/* ====================================================================== webhooks */

describe('outbound webhooks', () => {
  it('only accept https URLs and return the signing secret once', async () => {
    expect((await admin.post('/api/v1/automation/webhooks', { name: 'plain', url: 'ftp://example.com/h', events: ['*'] })).status).toBe(400);
    expect((await acme.post('/api/v1/automation/webhooks', { name: 'x', url: 'https://example.com/h', events: ['*'] })).status).toBe(403);
    const s = await ok(admin.post('/api/v1/automation/webhooks', { name: 'tickets', url: 'https://127.0.0.1:9/hook', events: ['ticket.created'] }));
    expect(s.signingSecret).toMatch(/^whsec_/);
    expect(s.secretEnc).toBeUndefined();
    ids.sub = s.id;
    ids.subSecret = s.signingSecret;
    const list = await ok(admin.get('/api/v1/automation/webhooks'));
    expect(JSON.stringify(list)).not.toContain(s.signingSecret);
  });

  it('fan out each event exactly once, even if dispatch runs again', async () => {
    await ctx.db.execute(sql`update domain_events set processed_at = now() where processed_at is null`);
    const t = await ok(acme.post('/api/v1/tickets', { kind: 'support', priority: 'normal', subject: 'Webhook me', body: 'hello' }));
    const [ev] = await ctx.db.select().from(domainEvents).where(and(eq(domainEvents.type, 'ticket.created'), eq(domainEvents.subjectId, t.id)));
    expect(ev).toBeTruthy();
    ids.ticketEvent = ev!.id;
    await Promise.all([dispatchEvents(deps), dispatchEvents(deps), dispatchEvents(deps)]);
    expect(await dispatchEvents(deps)).toBe(0);
    // Re-inserting the fan-out for the same event is a no-op (unique per subscription and event).
    await ctx.db.execute(sql`update domain_events set processed_at = null where id = ${ev!.id}`);
    await dispatchEvents(deps);
    const rows = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, ev!.id));
    expect(rows).toHaveLength(1);
    ids.delivery = rows[0]!.id;
  });

  it('are signed (HMAC over timestamp.body) and carry the event id', async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await deliverWebhooks({ ...deps, fetchImpl: fake });
    expect(r.sent).toBe(1);
    const h = seen[0]!.headers;
    expect(h['x-nexoradc-event']).toBe('ticket.created');
    expect(h['x-nexoradc-event-id']).toBe(String(ids.ticketEvent));
    expect(h['x-nexoradc-signature']).toBe(`sha256=${createHmac('sha256', ids.subSecret).update(`${h['x-nexoradc-timestamp']}.${seen[0]!.body}`).digest('hex')}`);
    expect(signWebhook(ids.subSecret, h['x-nexoradc-timestamp']!, seen[0]!.body)).toBe(h['x-nexoradc-signature']);
    // Same vector as integrations/whmcs/tests/client_test.php: PHP and the API sign identically.
    expect(signWebhook('k', '1700000000', '{"a":1}')).toBe('sha256=1b6ad1bc9bf48c52ce01939866d5877c6cc4e87ddad27e16673cb8c4964394a3');
    const body = JSON.parse(seen[0]!.body);
    expect(body).toMatchObject({ id: ids.ticketEvent, type: 'ticket.created', data: { subject: 'Webhook me' } });
    // Nothing left to send: a delivered event is not sent twice.
    expect((await deliverWebhooks({ ...deps, fetchImpl: fake })).sent).toBe(0);
    // A manual redelivery reuses the same event id.
    await ok(admin.post(`/api/v1/automation/deliveries/${ids.delivery}/redeliver`));
    await deliverWebhooks({ ...deps, fetchImpl: fake });
    expect(seen[1]!.headers['x-nexoradc-event-id']).toBe(String(ids.ticketEvent));
  });

  it('retry with backoff and give up after 8 attempts', async () => {
    await ctx.db.update(webhookDeliveries).set({ status: 'pending', attempts: 0, nextAttemptAt: new Date() }).where(eq(webhookDeliveries.id, ids.delivery));
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await deliverWebhooks({ ...deps, fetchImpl: failing });
    let [d] = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, ids.delivery));
    expect(d).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 503 });
    expect(d!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    await ctx.db.update(webhookDeliveries).set({ attempts: 7, nextAttemptAt: new Date() }).where(eq(webhookDeliveries.id, ids.delivery));
    expect((await deliverWebhooks({ ...deps, fetchImpl: failing })).failed).toBe(1);
    [d] = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, ids.delivery));
    expect(d).toMatchObject({ status: 'failed', attempts: 8 });
    const [sub] = await ok(admin.get('/api/v1/automation/webhooks'));
    expect(sub.failed).toBe(1);
  });

  it('refuse private destinations unless allowed', async () => {
    await ctx.db.update(webhookDeliveries).set({ status: 'pending', attempts: 0, nextAttemptAt: new Date() }).where(eq(webhookDeliveries.id, ids.delivery));
    let called = false;
    const fake = (async () => ((called = true), new Response('ok'))) as unknown as typeof fetch;
    await deliverWebhooks({ ...deps, allowPrivate: false, fetchImpl: fake });
    expect(called).toBe(false);
    const [d] = await ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, ids.delivery));
    expect(d!.lastError).toMatch(/private|not allowed|blocked/i);
  });
});

/* ====================================================================== WHMCS */

function signed(integrationId: string, secret: string, path: 'events' | 'reconcile' | 'usage' | 'ping', body: object, opts: { ts?: number; sig?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = opts.sig ?? `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  return request(ctx.server).post(`/api/v1/billing/whmcs/${integrationId}/${path}`).set('content-type', 'application/json').set('x-nexoradc-timestamp', ts).set('x-nexoradc-signature', sig).send(raw);
}

describe('WHMCS integration', () => {
  it('is configured by staff with billing.manage; the module secret is shown once', async () => {
    expect((await ops.post('/api/v1/billing/integrations', { name: 'WHMCS' })).status).toBe(403);
    expect((await acme.get('/api/v1/billing/integrations')).status).toBe(403);
    const i = await ok(admin.post('/api/v1/billing/integrations', { name: 'WHMCS', url: 'https://billing.example.com' }));
    expect(i.webhookSecret).toMatch(/^whmcs_/);
    ids.whmcs = i.id;
    ids.whmcsSecret = i.webhookSecret;
    expect(JSON.stringify(await ok(admin.get('/api/v1/billing/integrations')))).not.toContain(i.webhookSecret);
    await ok(admin.put(`/api/v1/billing/integrations/${i.id}/mappings`, { productId: '7', kind: 'colocation', label: 'Quarter rack' }));
  });

  it('rejects unsigned, wrongly signed and stale requests', async () => {
    const ev = { id: 'evt-x', type: 'client.upsert', data: { clientId: 1, name: 'X' } };
    expect((await request(ctx.server).post(`/api/v1/billing/whmcs/${ids.whmcs}/events`).send(ev)).status).toBe(401);
    expect((await signed(ids.whmcs, 'wrong-secret', 'events', ev)).status).toBe(401);
    expect((await signed(ids.whmcs, ids.whmcsSecret, 'events', ev, { ts: Math.floor(Date.now() / 1000) - 3600 })).body.error).toBe('stale_timestamp');
    expect((await signed('00000000-0000-0000-0000-000000000000', ids.whmcsSecret, 'events', ev)).status).toBe(401);
    expect((await signed('not-a-uuid', ids.whmcsSecret, 'events', ev)).status).toBe(401);
    // A body changed after signing fails.
    const raw = JSON.stringify(ev);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `sha256=${createHmac('sha256', ids.whmcsSecret).update(`${ts}.${raw}`).digest('hex')}`;
    const tampered = await request(ctx.server).post(`/api/v1/billing/whmcs/${ids.whmcs}/events`).set('content-type', 'application/json').set('x-nexoradc-timestamp', ts).set('x-nexoradc-signature', sig).send(raw.replace('"X"', '"Y"'));
    expect(tampered.status).toBe(401);
    expect(await ctx.db.select().from(billingEvents)).toHaveLength(0);
  });

  it('answers a signed ping without recording anything', async () => {
    expect(await ok(signed(ids.whmcs, ids.whmcsSecret, 'ping', { ping: true }))).toMatchObject({ ok: true, integration: 'WHMCS' });
    expect((await signed(ids.whmcs, 'nope', 'ping', { ping: true })).status).toBe(401);
    expect(await ok(admin.get(`/api/v1/billing/integrations/${ids.whmcs}/reconciliations`))).toHaveLength(0);
  });

  it('applies a client once; a duplicate event id changes nothing', async () => {
    const ev = { id: 'evt-client-500', type: 'client.upsert', data: { clientId: 500, name: 'Initech', email: 'ap@initech.example' } };
    const first = await ok(signed(ids.whmcs, ids.whmcsSecret, 'events', ev));
    expect(first).toMatchObject({ duplicate: false, status: 'applied' });
    const [c] = await ctx.db.select().from(customers).where(eq(customers.billingReference, '500'));
    expect(c).toMatchObject({ code: 'WHMCS-500', name: 'Initech', status: 'active' });
    ids.initech = c!.id;
    // A later event without an email keeps the one on file.
    expect(await ok(signed(ids.whmcs, ids.whmcsSecret, 'events', { id: 'evt-client-500b', type: 'client.upsert', data: { clientId: 500, name: 'Initech' } }))).toMatchObject({ status: 'ignored' });
    expect((await ctx.db.select().from(customers).where(eq(customers.id, ids.initech)))[0]!.contactEmail).toBe('ap@initech.example');
    const again = await ok(signed(ids.whmcs, ids.whmcsSecret, 'events', { ...ev, data: { ...ev.data, name: 'Changed' } }));
    expect(again).toMatchObject({ duplicate: true, status: 'applied' });
    expect((await ctx.db.select().from(customers).where(eq(customers.billingReference, '500')))[0]!.name).toBe('Initech');
    // The same event delivered concurrently is applied once.
    const burst = { id: 'evt-client-501', type: 'client.upsert', data: { clientId: 501, name: 'Hooli' } };
    const results = await Promise.all(Array.from({ length: 6 }, () => signed(ids.whmcs, ids.whmcsSecret, 'events', burst)));
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(results.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(await ctx.db.select().from(customers).where(eq(customers.billingReference, '501'))).toHaveLength(1);
    expect(await ctx.db.select().from(billingEvents).where(eq(billingEvents.eventId, 'evt-client-501'))).toHaveLength(1);
  });

  it('syncs the service lifecycle as records only, ignoring repeats and refusing invalid transitions', async () => {
    const send = (id: string, type: string, data: object) => ok(signed(ids.whmcs, ids.whmcsSecret, 'events', { id, type, data }));
    expect(await send('s1', 'service.created', { serviceId: 9001, clientId: 500, productId: 7, name: 'Quarter rack BOM1' })).toMatchObject({ status: 'applied' });
    const [svc] = await ctx.db.select().from(services).where(eq(services.billingReference, '9001'));
    expect(svc).toMatchObject({ customerId: ids.initech, kind: 'colocation', status: 'pending' });
    ids.svc9001 = svc!.id;
    expect(await send('s2', 'service.activated', { serviceId: 9001 })).toMatchObject({ status: 'applied' });
    expect(await send('s3', 'service.activated', { serviceId: 9001 })).toMatchObject({ status: 'ignored', message: 'Already active' });
    expect(await send('s4', 'service.suspended', { serviceId: 9001, reason: 'Overdue invoice' })).toMatchObject({ status: 'applied' });
    expect(await send('s5', 'service.unsuspended', { serviceId: 9001 })).toMatchObject({ status: 'applied' });
    expect(await send('s6', 'service.terminated', { serviceId: 9001 })).toMatchObject({ status: 'applied' });
    expect(await send('s7', 'service.activated', { serviceId: 9001 })).toMatchObject({ status: 'rejected' });
    expect(await send('s8', 'service.suspended', { serviceId: 424242 })).toMatchObject({ status: 'review' });
    // The wrong client for a known service is held for review.
    expect(await send('s9', 'service.suspended', { serviceId: 9001, clientId: 501 })).toMatchObject({ status: 'review' });
    const [after] = await ctx.db.select().from(services).where(eq(services.id, ids.svc9001));
    expect(after!.status).toBe('terminated');
    expect(after!.endDate).toBeTruthy();
    const hist = await ctx.db.select().from(serviceEvents).where(eq(serviceEvents.serviceId, ids.svc9001));
    expect(hist.map((h) => h.toStatus)).toEqual(['pending', 'active', 'suspended', 'active', 'terminated']);
    expect(hist[2]!.summary).toContain('Overdue invoice');
    // Each applied event is announced on the bus.
    const applied = await ctx.db.select().from(domainEvents).where(eq(domainEvents.type, 'billing.event_applied'));
    expect(applied.length).toBeGreaterThanOrEqual(6);
    // Two different events creating the same new service at once create it once.
    const race = await Promise.all([send('r1', 'service.created', { serviceId: 9050, clientId: 500, name: 'Race' }), send('r2', 'service.created', { serviceId: 9050, clientId: 500, name: 'Race' })]);
    expect(race.map((r) => r.status).sort()).toEqual(['applied', 'ignored']);
    expect(await ctx.db.select().from(services).where(eq(services.billingReference, '9050'))).toHaveLength(1);
    // A pending service that is cancelled ends as cancelled, not terminated.
    await send('c1', 'service.created', { serviceId: 9010, clientId: 500, name: 'Never started' });
    await send('c2', 'service.cancelled', { serviceId: 9010 });
    expect((await ctx.db.select().from(services).where(eq(services.billingReference, '9010')))[0]!.status).toBe('cancelled');
  });

  it('holds closed clients for review and lists events for staff', async () => {
    expect(await ok(signed(ids.whmcs, ids.whmcsSecret, 'events', { id: 'close-500', type: 'client.upsert', data: { clientId: 500, name: 'Initech', status: 'Closed' } }))).toMatchObject({ status: 'review' });
    expect((await ctx.db.select().from(customers).where(eq(customers.id, ids.initech)))[0]!.status).toBe('active');
    const list = await ok(admin.get(`/api/v1/billing/integrations/${ids.whmcs}/events?status=review`));
    expect(list.map((e: { eventId: string }) => e.eventId)).toEqual(expect.arrayContaining(['close-500', 's8', 's9']));
    const [i] = await ok(admin.get('/api/v1/billing/integrations'));
    expect(i.events30d.applied).toBeGreaterThan(0);
  });

  it('reconciles a WHMCS snapshot without changing anything', async () => {
    await ok(admin.post('/api/v1/services', { customerId: ctx.customers.acme, kind: 'vps', name: 'Billing-only VPS', billingReference: 'X-77' }));
    await ctx.db.update(services).set({ status: 'active' }).where(eq(services.billingReference, 'X-77'));
    const before = await ctx.db.select().from(services);
    const snap = {
      services: [
        { serviceId: 9001, clientId: 500, status: 'Active', name: 'Quarter rack BOM1' },
        { serviceId: 9010, clientId: 500, status: 'Cancelled' },
        { serviceId: 9999, clientId: 500, status: 'Active', name: 'Only in WHMCS' },
        { serviceId: 9050, clientId: 500, status: 'Pending', name: 'Race' },
      ],
    };
    const r = await ok(signed(ids.whmcs, ids.whmcsSecret, 'reconcile', snap));
    expect(r.summary).toMatchObject({ whmcsServices: 4, matched: 2, statusMismatch: 1, missingInNexoradc: 1, missingInWhmcs: 1 });
    expect(r.items.find((x: { kind: string }) => x.kind === 'status_mismatch')).toMatchObject({ serviceId: '9001', whmcsStatus: 'Active', nexoradcStatus: 'terminated' });
    expect(r.items.find((x: { kind: string }) => x.kind === 'missing_in_whmcs')).toMatchObject({ serviceId: 'X-77' });
    expect(await ctx.db.select().from(services)).toEqual(before);
    // Staff can upload the same export; the history is kept.
    await ok(admin.post(`/api/v1/billing/integrations/${ids.whmcs}/reconcile`, snap));
    expect(await ok(admin.get(`/api/v1/billing/integrations/${ids.whmcs}/reconciliations`))).toHaveLength(2);
    expect((await signed(ids.whmcs, 'wrong', 'reconcile', snap)).status).toBe(401);
  });

  it('reports usage: measured and estimated energy apart, 95th-percentile bandwidth with coverage', async () => {
    const svc = await ok(admin.post('/api/v1/services', { customerId: ctx.customers.acme, kind: 'dedicated_server', name: 'Server ACME-01', billingReference: 'U-1', deviceId: ids.acmeSrv }));
    const from = new Date(Date.UTC(2026, 8, 1));
    const to = new Date(Date.UTC(2026, 8, 2));
    for (let h = 0; h < 24; h++) {
      const measured = h < 12;
      await ctx.db.execute(sql`insert into power_hourly (device_id, hour, org_id, customer_id, category, counted, measured_wh, measured_seconds, estimated_wh, estimated_seconds, samples)
        values (${ids.acmeSrv}, ${new Date(from.getTime() + h * 3600_000).toISOString()}, ${ctx.org.id}, ${ctx.customers.acme}, 'server', true, ${measured ? 250 : 0}, ${measured ? 3600 : 0}, ${measured ? 0 : 300}, ${measured ? 0 : 3600}, 60)`);
    }
    // One uncabled customer port with 100 five-minute samples: 1..100 Mbit/s in, half that out.
    const [ifc] = await ctx.db.insert(interfaces).values({ orgId: ctx.org.id, deviceId: ids.acmeSrv, name: 'eno1', kind: 'physical' } as never).returning();
    for (let i = 1; i <= 100; i++) {
      await ctx.db.execute(sql`insert into interface_rates_5m (interface_id, bucket, org_id, device_id, in_bps, out_bps, in_max, out_max, samples, covered_seconds)
        values (${ifc!.id}, ${new Date(from.getTime() + i * 300_000).toISOString()}, ${ctx.org.id}, ${ids.acmeSrv}, ${i * 1e6}, ${i * 5e5}, ${i * 1e6}, ${i * 5e5}, 5, 300)`);
    }
    const q = `billingReference=U-1&from=${from.toISOString()}&to=${to.toISOString()}`;
    const u = await ok(admin.get(`/api/v1/billing/usage?${q}`));
    expect(u.service.id).toBe(svc.id);
    expect(u.energy).toMatchObject({ devices: 1, measuredKwh: 3, estimatedKwh: 3.6 });
    expect(u.bandwidth).toMatchObject({ ports: 1, samples: 100, expectedSamples: 288, inP95Bps: 95e6, outP95Bps: 47.5e6, billableP95Bps: 95e6 });
    expect(u.bandwidth.coverage).toBeCloseTo(34.7, 1);
    // The module gets the same answer through a signed call.
    const m = await ok(signed(ids.whmcs, ids.whmcsSecret, 'usage', { billingReference: 'U-1', from: from.toISOString(), to: to.toISOString() }));
    expect(m.energy).toEqual(u.energy);
    expect(u.bandwidth.basis).toBe('customer_ports');
    // Once an operator port is cabled to the customer, only that uplink counts: the customer's own port is internal.
    const sw = (await ok(admin.post('/api/v1/dcim/devices', { modelId: ids.model, assetTag: 'CORE-SW1', hostname: 'core-sw1', initialState: 'inventory', customerId: null }))).id;
    const [up] = await ctx.db.insert(interfaces).values({ orgId: ctx.org.id, deviceId: sw, name: 'xe-0/0/1', kind: 'physical' } as never).returning();
    await ctx.db.transaction(async (tx) => {
      const cable = await tx.execute<{ id: string }>(sql`insert into cables (org_id, label) values (${ctx.org.id}, 'C-1') returning id`);
      await tx.execute(sql`insert into cable_ends (cable_id, "end", interface_id) values (${cable.rows[0]!.id}, 'a', ${up!.id}), (${cable.rows[0]!.id}, 'b', ${ifc!.id})`);
    });
    for (let i = 1; i <= 100; i++) {
      await ctx.db.execute(sql`insert into interface_rates_5m (interface_id, bucket, org_id, device_id, in_bps, out_bps, in_max, out_max, samples, covered_seconds)
        values (${up!.id}, ${new Date(from.getTime() + i * 300_000).toISOString()}, ${ctx.org.id}, ${sw}, ${i * 5e5}, ${i * 1e6}, ${i * 5e5}, ${i * 1e6}, 5, 300)`);
    }
    const u2 = await ok(admin.get(`/api/v1/billing/usage?${q}`));
    expect(u2.bandwidth).toMatchObject({ basis: 'uplinks', ports: 1, inP95Bps: 47.5e6, outP95Bps: 95e6, billableP95Bps: 95e6 });
    expect((await acme.get(`/api/v1/billing/usage?${q}`)).status).toBe(403);
    expect((await admin.get(`/api/v1/billing/usage?billingReference=U-1&from=${to.toISOString()}&to=${from.toISOString()}`)).body.error).toBe('invalid_period');
  });
});

/* ====================================================================== workflows */

describe('workflows', () => {
  const wf = (over: object = {}) => ({
    name: 'Urgent tickets',
    trigger: 'ticket.created',
    conditions: [{ field: 'payload.priority', op: 'eq', value: 'urgent' }],
    actions: [
      { type: 'add_ticket_note', body: 'Auto-triage: urgent ticket {{payload.subject}} from {{customer.name}}' },
      { type: 'set_ticket_priority', priority: 'high', requiresApproval: true },
    ],
    ...over,
  });

  it('are managed by staff with workflows.manage', async () => {
    expect((await acme.post('/api/v1/workflows', wf())).status).toBe(403);
    expect((await noc.post('/api/v1/workflows', wf())).status).toBe(403);
    expect((await admin.post('/api/v1/workflows', wf({ actions: [{ type: 'reboot_server' }] }))).status).toBe(400);
    const w = await ok(admin.post('/api/v1/workflows', wf()));
    expect(w.version).toBe(1);
    ids.wf = w.id;
  });

  it('dry-run evaluates without executing', async () => {
    const before = (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(ticketMessages))[0]!.n;
    const hit = await ok(admin.post('/api/v1/workflows/dry-run', { workflow: wf(), sample: { customerId: ctx.customers.acme, payload: { priority: 'urgent', subject: 'Disk dead' } } }));
    expect(hit.wouldRun).toBe(true);
    expect(JSON.stringify(hit)).toContain('Auto-triage: urgent ticket Disk dead from Acme');
    expect(JSON.stringify(hit)).toMatch(/approval/i);
    const miss = await ok(admin.post('/api/v1/workflows/dry-run', { workflow: wf(), sample: { payload: { priority: 'low' } } }));
    expect(miss.wouldRun).toBe(false);
    expect((await ctx.db.select({ n: sql<number>`count(*)::int` }).from(ticketMessages))[0]!.n).toBe(before);
  });

  it('run on matching events, stop for approval, and need a second person to approve', async () => {
    await ctx.db.execute(sql`update domain_events set processed_at = now() where processed_at is null`);
    const t = await ok(acme.post('/api/v1/tickets', { kind: 'remote_hands', priority: 'urgent', subject: 'Server down', body: 'Please check' }));
    const low = await ok(acme.post('/api/v1/tickets', { kind: 'support', priority: 'low', subject: 'Question', body: 'Hi' }));
    await pump();
    const runs = await ok(admin.get(`/api/v1/workflows/runs?workflowId=${ids.wf}`));
    const run = runs.find((r: { subject_id: string }) => r.subject_id === t.id);
    const skipped = runs.find((r: { subject_id: string }) => r.subject_id === low.id);
    expect(run.status).toBe('waiting_approval');
    expect(skipped.status).toBe('skipped');
    const notes = await ctx.db.select().from(ticketMessages).where(and(eq(ticketMessages.ticketId, t.id), eq(ticketMessages.internal, true)));
    expect(notes.map((n) => n.body)).toContain('Auto-triage: urgent ticket Server down from Acme');
    // The internal note is not shown to the customer.
    expect(JSON.stringify(await ok(acme.get(`/api/v1/tickets/${t.id}`)))).not.toContain('Auto-triage');
    // Four eyes: the workflow's last editor can't approve.
    expect((await admin.post(`/api/v1/workflows/runs/${run.id}/approve`, {})).body.error).toBe('four_eyes');
    await ok(ops.post(`/api/v1/workflows/runs/${run.id}/approve`, { note: 'ok' }));
    expect((await ops.post(`/api/v1/workflows/runs/${run.id}/approve`, {})).body.error).toBe('not_waiting');
    await runWorkflows(deps);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.priority).toBe('high');
    const [done] = await ctx.db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(done!.status).toBe('completed');
    expect(done!.decidedBy).toBe(ctx.emails.opsAdmin);
  });

  it('reject waiting runs when the workflow is edited or a run is rejected', async () => {
    const t = await ok(acme.post('/api/v1/tickets', { kind: 'support', priority: 'urgent', subject: 'Second', body: 'x' }));
    await pump();
    const [run] = await ctx.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ids.wf), eq(workflowRuns.status, 'waiting_approval')));
    expect(run).toBeTruthy();
    const w = await ok(ops.put(`/api/v1/workflows/${ids.wf}`, wf({ description: 'edited' })));
    expect(w.version).toBe(2);
    expect((await ctx.db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id)))[0]!.status).toBe('rejected');
    // Now ops is the last editor: admin may approve, ops may not.
    const t2 = await ok(acme.post('/api/v1/tickets', { kind: 'support', priority: 'urgent', subject: 'Third', body: 'x' }));
    await pump();
    const [run2] = await ctx.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ids.wf), eq(workflowRuns.status, 'waiting_approval')));
    expect((await ops.post(`/api/v1/workflows/runs/${run2!.id}/approve`, {})).body.error).toBe('four_eyes');
    await ok(ops.post(`/api/v1/workflows/runs/${run2!.id}/reject`, { note: 'not needed' }));
    await runWorkflows(deps);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t2.id)))[0]!.priority).toBe('urgent');
    void t;
  });

  it('fail an approved step if the workflow was changed before it ran', async () => {
    await ok(acme.post('/api/v1/tickets', { kind: 'support', priority: 'urgent', subject: 'Fourth', body: 'x' }));
    await pump();
    const [run] = await ctx.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ids.wf), eq(workflowRuns.status, 'waiting_approval')));
    await ok(admin.post(`/api/v1/workflows/runs/${run!.id}/approve`, {}));
    // ops edits the step after admin approved it, before the worker ran it.
    await ok(ops.put(`/api/v1/workflows/${ids.wf}`, wf({ actions: [{ type: 'add_ticket_note', body: 'n' }, { type: 'set_ticket_priority', priority: 'low', requiresApproval: true }] })));
    expect((await ctx.db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id)))[0]!.status).toBe('rejected');
    // Even if an approved run slipped through, the version check stops it.
    await ctx.db.update(workflowRuns).set({ status: 'approved', finishedAt: null }).where(eq(workflowRuns.id, run!.id));
    await runWorkflows(deps);
    const [after] = await ctx.db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(after!.status).toBe('failed');
    expect(JSON.stringify(after!.log)).toContain('was changed');
  });

  it('give up on a run the worker keeps crashing on', async () => {
    const t = await ok(acme.post('/api/v1/tickets', { kind: 'support', priority: 'urgent', subject: 'Crashy', body: 'x' }));
    await dispatchEvents(deps);
    const [run] = await ctx.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowId, ids.wf), eq(workflowRuns.status, 'pending')));
    expect(run).toBeTruthy();
    // A database that fails every transaction (the worker's per-run work) but still answers plain queries.
    const broken = new Proxy(ctx.db, { get: (target, k) => (k === 'transaction' ? () => Promise.reject(new Error('connection reset')) : (target as never)[k]) });
    const crashing = { ...deps, db: broken };
    for (let i = 0; i < 4; i++) await runWorkflows(crashing);
    expect((await ctx.db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id)))[0]).toMatchObject({ status: 'pending', attempts: 4 });
    await runWorkflows(crashing);
    const [after] = await ctx.db.select().from(workflowRuns).where(eq(workflowRuns.id, run!.id));
    expect(after).toMatchObject({ status: 'failed', attempts: 5 });
    expect(JSON.stringify(after!.log)).toContain('connection reset');
    void t;
  });

  it('never trigger on events caused by a workflow (no loops)', async () => {
    const loop = await ok(admin.post('/api/v1/workflows', {
      name: 'Follow-up on every ticket',
      trigger: 'ticket.created',
      conditions: [{ field: 'payload.subject', op: 'contains', value: 'LOOP' }],
      actions: [{ type: 'create_ticket', forCustomer: 'event', kind: 'support', priority: 'normal', subject: 'Follow-up LOOP: {{payload.subject}}', body: 'Created automatically' }],
    }));
    await ok(acme.post('/api/v1/tickets', { kind: 'support', priority: 'normal', subject: 'LOOP start', body: 'x' }));
    for (let i = 0; i < 4; i++) await pump();
    const runs = await ctx.db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, loop.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('completed');
    const created = await ctx.db.select().from(tickets).where(sql`${tickets.subject} like 'Follow-up LOOP%'`);
    expect(created).toHaveLength(1);
    expect(created[0]!.customerId).toBe(ctx.customers.acme);
    // The follow-up's own event exists (webhooks still see it) but carries the run id.
    const [ev] = await ctx.db.select().from(domainEvents).where(eq(domainEvents.subjectId, created[0]!.id));
    expect(ev!.causedByRunId).toBe(runs[0]!.id);
    await ok(admin.delete(`/api/v1/workflows/${loop.id}`));
  });

  it('notify actions queue a notification through a channel', async () => {
    const ch = await ok(admin.post('/api/v1/alerts/channels', { kind: 'email', name: 'Ops mail', to: ['ops@test.example'], from: 'dcim@test.example', smtpHost: '127.0.0.1', smtpPassword: 'smtp-secret-value' }));
    ids.channel = ch.id;
    await ok(admin.post('/api/v1/workflows', { name: 'Tell ops', trigger: 'service.status_changed', conditions: [{ field: 'payload.to', op: 'eq', value: 'suspended' }], actions: [{ type: 'notify', channelId: ch.id, title: 'Suspended: {{payload.name}}', text: 'Service {{payload.name}} was suspended ({{payload.reason}})' }] }));
    await ok(signed(ids.whmcs, ids.whmcsSecret, 'events', { id: 'n1', type: 'service.created', data: { serviceId: 9020, clientId: 500, name: 'Notify me' } }));
    await ok(signed(ids.whmcs, ids.whmcsSecret, 'events', { id: 'n2', type: 'service.activated', data: { serviceId: 9020 } }));
    await ok(signed(ids.whmcs, ids.whmcsSecret, 'events', { id: 'n3', type: 'service.suspended', data: { serviceId: 9020, reason: 'unpaid' } }));
    await pump();
    const rows = await ctx.db.select().from(notifications).where(eq(notifications.channelId, ch.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ title: 'Suspended: Notify me', text: 'Service Notify me was suspended (unpaid)' });
  });
});

/* ====================================================================== reports */

describe('reports', () => {
  it('export CSV with formula injection neutralized', async () => {
    await ok(admin.post('/api/v1/services', { customerId: ctx.customers.acme, kind: 'other', name: '=HYPERLINK("http://evil","x")' }));
    const r = await admin.get('/api/v1/reports?type=services&format=csv');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toMatch(/attachment; filename="nexoradc-services-.*\.csv"/);
    const text = r.text ?? r.body.toString();
    expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(text).not.toMatch(/,=HYPERLINK/);
  });

  it('export PDF', async () => {
    const r = await admin.get('/api/v1/reports?type=energy&period=last_30d&format=pdf').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('keep customers to their own data and the capacity report to staff', async () => {
    const mine = await ok(acme.get('/api/v1/reports?type=services&format=json'));
    expect(mine.scope).toBe('Acme');
    expect(mine.rows.every((r: { customer: string }) => r.customer === 'Acme (ACME)')).toBe(true);
    expect((await ok(globex.get('/api/v1/reports?type=services'))).rows).toHaveLength(0);
    expect((await acme.get('/api/v1/reports?type=capacity')).status).toBe(403);
    expect((await ok(acme.get('/api/v1/reports/types'))).types.map((t: { key: string }) => t.key)).not.toContain('capacity');
    const cap = await ok(admin.get('/api/v1/reports?type=capacity'));
    expect(cap.rows[0]).toMatchObject({ datacenter: 'Mumbai 1 (BOM1)', racks: 1, totalU: 42, usedU: 2 });
    // Energy: customers see their own measured and estimated split, without costs.
    const e = await ok(acme.get('/api/v1/reports?type=energy&period=last_30d'));
    expect(e.columns.map((c: { key: string }) => c.key)).not.toContain('cost');
  });

  it('are emailed on a schedule through an email channel', async () => {
    const webhookCh = await ok(admin.post('/api/v1/alerts/channels', { kind: 'webhook', name: 'Hook', url: 'https://example.com/h', signingSecret: 'x'.repeat(24) }));
    const body = { name: 'Monthly services', type: 'services', period: 'last_month', format: 'csv', frequency: 'monthly', hour: 6, dayOfMonth: 1, channelId: ids.channel, recipients: ['finance@test.example'] };
    expect((await admin.post('/api/v1/reports/schedules', { ...body, channelId: webhookCh.id })).body.error).toBe('invalid_channel');
    expect((await acme.post('/api/v1/reports/schedules', body)).status).toBe(403);
    expect((await admin.post('/api/v1/reports/schedules', { ...body, dayOfMonth: null })).status).toBe(400);
    const s = await ok(admin.post('/api/v1/reports/schedules', body));
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const sent: { config: Record<string, unknown>; secret: Record<string, unknown>; m: EmailMessage }[] = [];
    const send = async (config: Record<string, unknown>, secret: Record<string, unknown>, m: EmailMessage) => void sent.push({ config, secret, m });
    expect(await runReportSchedules({ ...deps, send })).toBe(0);
    await ok(admin.post(`/api/v1/reports/schedules/${s.id}/run`));
    expect(await runReportSchedules({ ...deps, send })).toBe(1);
    expect(sent[0]!.m.to).toEqual(['finance@test.example']);
    expect(sent[0]!.m.attachments![0]!.filename).toMatch(/\.csv$/);
    expect(sent[0]!.m.attachments![0]!.content.toString()).toContain('Billing-only VPS');
    expect(sent[0]!.secret.smtpPassword).toBe('smtp-secret-value');
    const [after] = await ctx.db.select().from(reportSchedules).where(eq(reportSchedules.id, s.id));
    expect(after).toMatchObject({ lastStatus: 'sent', lastError: null });
    expect(after!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    // Nothing is due any more.
    expect(await runReportSchedules({ ...deps, send })).toBe(0);
    // The schedule list never includes the SMTP password.
    expect(JSON.stringify(await ok(admin.get('/api/v1/reports/schedules')))).not.toContain('smtp-secret-value');
  });
});

/* ====================================================================== incidents */

describe('incidents and maintenance notices', () => {
  it('are written by staff with alerts.manage and shown to affected customers only', async () => {
    expect((await acme.post('/api/v1/status/incidents', { title: 'x', severity: 'minor', message: 'x', customerIds: [] , datacenterId: ids.dc })).status).toBe(403);
    expect((await admin.post('/api/v1/status/incidents', { title: 'No audience', severity: 'minor', message: 'x' })).body.error).toBe('no_audience');
    const inc = await ok(noc.post('/api/v1/status/incidents', { title: 'Power feed A degraded', severity: 'major', datacenterId: ids.dc, message: 'Feed A at BOM1 is on generator.' }));
    const internal = await ok(admin.post('/api/v1/status/incidents', { title: 'Internal only', severity: 'minor', public: false, datacenterId: ids.dc, message: 'staff only' }));
    await ok(noc.post(`/api/v1/status/incidents/${inc.id}/updates`, { status: 'identified', message: 'Utility fault upstream.' }));
    await ok(noc.post(`/api/v1/status/incidents/${inc.id}/updates`, { status: 'identified', message: 'Vendor ticket 4411, engineer J. Smith', public: false }));
    // Acme has equipment at BOM1; Globex has nothing there.
    const a = await ok(acme.get('/api/v1/status/incidents'));
    expect(a.items.map((i: { id: string }) => i.id)).toEqual([inc.id]);
    const detail = await ok(acme.get(`/api/v1/status/incidents/${inc.id}`));
    expect(detail.updates.map((u: { message: string }) => u.message)).toEqual(['Feed A at BOM1 is on generator.', 'Utility fault upstream.']);
    expect(JSON.stringify(detail)).not.toContain(ctx.emails.noc);
    expect((await acme.get(`/api/v1/status/incidents/${internal.id}`)).status).toBe(404);
    expect((await ok(globex.get('/api/v1/status/incidents'))).items).toHaveLength(0);
    expect((await globex.get(`/api/v1/status/incidents/${inc.id}`)).status).toBe(404);
    // Named customers see it without a site.
    const named = await ok(admin.post('/api/v1/status/incidents', { title: 'Globex circuit', severity: 'minor', customerIds: [ctx.customers.globex], message: 'Your cross-connect is flapping.' }));
    expect((await ok(globex.get('/api/v1/status/incidents'))).items.map((i: { id: string }) => i.id)).toEqual([named.id]);
    await ok(noc.post(`/api/v1/status/incidents/${inc.id}/updates`, { status: 'resolved', message: 'Back on utility.' }));
    expect((await ok(acme.get('/api/v1/status/incidents?status=resolved'))).items[0].resolvedAt).toBeTruthy();
    const evs = await ctx.db.select().from(domainEvents).where(sql`${domainEvents.type} like 'incident.%'`);
    expect(evs.length).toBeGreaterThanOrEqual(4);
    // Internal updates don't carry their text on the bus.
    expect(JSON.stringify(evs)).not.toContain('J. Smith');
  });

  it('maintenance windows reach customers only when published', async () => {
    const start = new Date(Date.now() + 86400_000).toISOString();
    const end = new Date(Date.now() + 90000_000).toISOString();
    const m = await ok(admin.post('/api/v1/alerts/maintenance', { name: 'UPS swap', startsAt: start, endsAt: end, scope: 'datacenter', datacenterId: ids.dc, notes: 'internal: vendor badge 77' }));
    expect(await ok(acme.get('/api/v1/status/maintenance'))).toHaveLength(0);
    expect((await admin.put(`/api/v1/status/maintenance/${m.id}/notice`, { customerVisible: true })).body.error).toBe('description_required');
    expect((await acme.put(`/api/v1/status/maintenance/${m.id}/notice`, { customerVisible: true, description: 'x' })).status).toBe(403);
    await ok(admin.put(`/api/v1/status/maintenance/${m.id}/notice`, { customerVisible: true, description: 'UPS B replacement; feeds stay up.' }));
    const seen = await ok(acme.get('/api/v1/status/maintenance'));
    expect(seen).toHaveLength(1);
    // The window's internal name stays with staff.
    expect(seen[0]).toMatchObject({ name: 'Planned maintenance', description: 'UPS B replacement; feeds stay up.', state: 'scheduled' });
    expect(JSON.stringify(seen)).not.toContain('UPS swap');
    expect(JSON.stringify(seen)).not.toContain('vendor badge');
    expect(await ok(globex.get('/api/v1/status/maintenance'))).toHaveLength(0);
  });
});
