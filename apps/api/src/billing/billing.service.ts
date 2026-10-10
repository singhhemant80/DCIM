import { createHmac, randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  SERVICE_TRANSITIONS,
  billingClientSchema,
  billingEventSchema,
  billingServiceSchema,
  type ServiceStatus,
  billingIntegrationSchema,
  productMappingSchema,
  reconcileSchema,
  usageQuerySchema,
} from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { billingEvents, billingIntegrations, billingProductMappings, billingReconciliations, coloAllocations, customers, serviceEvents, services, type BillingIntegration } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { SecretBox } from '../common/secret-box';
import { hashToken, safeEqual } from '../common/tokens';
import type { Principal, RequestMeta } from '../auth/principal';
import { billingContext } from '../automation/contexts';
import { emitEvent } from '../events/events';
import { PowerService } from '../power/power.service';
import { customerP95 } from '../reports/bandwidth';

const SKEW_SECONDS = 300;
const isUnique = (e: unknown) => ((e as { cause?: { code?: string } }).cause ?? (e as { code?: string })).code === '23505';

/** What each WHMCS service event asks for, from each current status. */
const TARGET: Record<string, (from: ServiceStatus) => ServiceStatus> = {
  'service.activated': () => 'active',
  'service.unsuspended': () => 'active',
  'service.suspended': () => 'suspended',
  'service.terminated': (from) => (from === 'pending' ? 'cancelled' : 'terminated'),
  'service.cancelled': (from) => (from === 'pending' ? 'cancelled' : 'terminated'),
};

type Outcome = { status: 'applied' | 'ignored' | 'rejected' | 'review'; message: string; customerId?: string | null; serviceId?: string | null };

/**
 * WHMCS integration.
 *
 * Inbound: the NexoraDC WHMCS module posts signed events
 * (HMAC-SHA256 over "<timestamp>.<raw body>", timestamps within 5 minutes).
 * Every event id is stored once: a repeat is acknowledged and not applied
 * again. Events update customers and services as records only; a suspended
 * or terminated service never switches equipment off.
 *
 * Also: product → service kind mapping, reconciliation against a snapshot of
 * WHMCS services, and usage (energy, 95th-percentile bandwidth) for billing.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
    private readonly power: PowerService,
  ) {}

  private static view(i: BillingIntegration) {
    const { secretEnc: _s, ...rest } = i;
    return rest;
  }

  private async integration(p: Principal, id: string) {
    const [i] = await this.db.select().from(billingIntegrations).where(and(eq(billingIntegrations.id, id), eq(billingIntegrations.orgId, p.orgId)));
    if (!i) throw new NotFoundException({ error: 'not_found', message: 'Integration not found' });
    return i;
  }

  /* ================================================================ configuration (staff, billing.manage) */

  async list(p: Principal) {
    const rows = await this.db.select().from(billingIntegrations).where(eq(billingIntegrations.orgId, p.orgId)).orderBy(billingIntegrations.name);
    const stats = await this.db.execute<{ integration_id: string; status: string; n: number }>(sql`
      select e.integration_id, e.status, count(*)::int as n from billing_events e join billing_integrations i on i.id = e.integration_id
       where i.org_id = ${p.orgId} and e.received_at > now() - interval '30 days' group by 1, 2`);
    return rows.map((i) => ({ ...BillingService.view(i), events30d: Object.fromEntries(stats.rows.filter((s) => s.integration_id === i.id).map((s) => [s.status, s.n])) }));
  }

  async create(p: Principal, input: z.infer<typeof billingIntegrationSchema>, meta: RequestMeta) {
    const id = crypto.randomUUID();
    const webhookSecret = `whmcs_${randomBytes(24).toString('base64url')}`;
    try {
      return await this.db.transaction(async (tx) => {
        const [i] = await tx
          .insert(billingIntegrations)
          .values({ id, orgId: p.orgId, name: input.name, url: input.url ?? null, autoCreateCustomers: input.autoCreateCustomers, autoCreateServices: input.autoCreateServices, enabled: input.enabled, secretEnc: this.secrets.encrypt(JSON.stringify({ webhookSecret }), billingContext(p.orgId, id)) })
          .returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'billing.integration_create', target: { type: 'billing_integration', id }, outcome: 'success', meta, metadata: { name: input.name } }, tx);
        // Shown once: paste it into the WHMCS module settings.
        return { ...BillingService.view(i!), webhookSecret };
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ error: 'duplicate_name', message: 'An integration with this name already exists' });
      throw e;
    }
  }

  async update(p: Principal, id: string, input: z.infer<typeof billingIntegrationSchema>, meta: RequestMeta) {
    await this.integration(p, id);
    return this.db.transaction(async (tx) => {
      const [i] = await tx
        .update(billingIntegrations)
        .set({ name: input.name, url: input.url ?? null, autoCreateCustomers: input.autoCreateCustomers, autoCreateServices: input.autoCreateServices, enabled: input.enabled })
        .where(eq(billingIntegrations.id, id))
        .returning();
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'billing.integration_update', target: { type: 'billing_integration', id }, outcome: 'success', meta, metadata: input }, tx);
      return BillingService.view(i!);
    });
  }

  async rotateSecret(p: Principal, id: string, meta: RequestMeta) {
    await this.integration(p, id);
    const webhookSecret = `whmcs_${randomBytes(24).toString('base64url')}`;
    await this.db.transaction(async (tx) => {
      await tx.update(billingIntegrations).set({ secretEnc: this.secrets.encrypt(JSON.stringify({ webhookSecret }), billingContext(p.orgId, id)) }).where(eq(billingIntegrations.id, id));
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'billing.rotate_secret', target: { type: 'billing_integration', id }, outcome: 'success', meta }, tx);
    });
    return { webhookSecret };
  }

  async mappings(p: Principal, id: string) {
    await this.integration(p, id);
    return this.db.select().from(billingProductMappings).where(eq(billingProductMappings.integrationId, id)).orderBy(billingProductMappings.productId);
  }

  async putMapping(p: Principal, id: string, input: z.infer<typeof productMappingSchema>, meta: RequestMeta) {
    await this.integration(p, id);
    return this.db.transaction(async (tx) => {
      const [m] = await tx
        .insert(billingProductMappings)
        .values({ integrationId: id, productId: input.productId, kind: input.kind, label: input.label ?? null })
        .onConflictDoUpdate({ target: [billingProductMappings.integrationId, billingProductMappings.productId], set: { kind: input.kind, label: input.label ?? null } })
        .returning();
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'billing.mapping', target: { type: 'billing_integration', id }, outcome: 'success', meta, metadata: input }, tx);
      return m!;
    });
  }

  async deleteMapping(p: Principal, id: string, mappingId: string, meta: RequestMeta) {
    await this.integration(p, id);
    const rows = await this.db.delete(billingProductMappings).where(and(eq(billingProductMappings.id, mappingId), eq(billingProductMappings.integrationId, id))).returning();
    if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Mapping not found' });
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'billing.mapping_delete', target: { type: 'billing_integration', id }, outcome: 'success', meta, metadata: { productId: rows[0]!.productId } });
    return { ok: true };
  }

  async events(p: Principal, id: string, status?: string) {
    await this.integration(p, id);
    return this.db
      .select()
      .from(billingEvents)
      .where(and(eq(billingEvents.integrationId, id), status ? eq(billingEvents.status, status) : sql`true`))
      .orderBy(desc(billingEvents.id))
      .limit(300);
  }

  async reconciliations(p: Principal, id: string) {
    await this.integration(p, id);
    return this.db.select().from(billingReconciliations).where(eq(billingReconciliations.integrationId, id)).orderBy(desc(billingReconciliations.at)).limit(20);
  }

  /* ================================================================ inbound (signed, no session) */

  /** Verifies the signature and timestamp; returns the integration. Constant-time comparison. */
  async verify(integrationId: string, headers: Record<string, string | string[] | undefined>, raw: Buffer | undefined): Promise<BillingIntegration> {
    if (!/^[0-9a-f-]{36}$/.test(integrationId)) throw new UnauthorizedException({ error: 'bad_signature', message: 'Signature check failed' });
    const [i] = await this.db.select().from(billingIntegrations).where(eq(billingIntegrations.id, integrationId));
    const ts = String(headers['x-nexoradc-timestamp'] ?? '');
    const sig = String(headers['x-nexoradc-signature'] ?? '');
    if (!i || !raw || !/^\d{9,11}$/.test(ts) || !/^sha256=[0-9a-f]{64}$/.test(sig)) throw new UnauthorizedException({ error: 'bad_signature', message: 'Signature check failed' });
    if (Math.abs(Date.now() / 1000 - Number(ts)) > SKEW_SECONDS) throw new UnauthorizedException({ error: 'stale_timestamp', message: 'The timestamp is too far from the server time' });
    const secret = JSON.parse(this.secrets.decrypt(i.secretEnc, billingContext(i.orgId, i.id))).webhookSecret as string;
    const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex')}`;
    if (!safeEqual(hashToken(expected), hashToken(sig))) throw new UnauthorizedException({ error: 'bad_signature', message: 'Signature check failed' });
    if (!i.enabled) throw new ForbiddenException({ error: 'integration_disabled', message: 'The integration is disabled' });
    return i;
  }

  /** Applies one event once. A repeated event id returns the first outcome without applying anything. */
  async receive(i: BillingIntegration, body: unknown) {
    const parsed = billingEventSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_event', message: 'The event is not valid', issues: parsed.error.issues.map((x) => ({ path: x.path.join('.'), message: x.message })) });
    const ev = parsed.data;
    const [prev] = await this.db.select().from(billingEvents).where(and(eq(billingEvents.integrationId, i.id), eq(billingEvents.eventId, ev.id)));
    if (prev) return { duplicate: true, status: prev.status, message: prev.message };
    try {
      return await this.db.transaction(async (tx) => {
        // Claim the event id first: a concurrent copy of the same event waits here and then fails the unique check.
        const [row] = await tx.insert(billingEvents).values({ integrationId: i.id, eventId: ev.id, type: ev.type, payload: ev.data, status: 'review', message: 'processing' }).returning({ id: billingEvents.id });
        let out: Outcome;
        try {
          out = await tx.transaction((sp) => this.apply(sp, i, ev.type, ev.data));
        } catch (e) {
          out = { status: 'rejected', message: e instanceof BadRequestException ? String((e.getResponse() as { message?: string }).message) : 'The event could not be applied' };
        }
        await tx.update(billingEvents).set({ status: out.status, message: out.message.slice(0, 1000), customerId: out.customerId ?? null, serviceId: out.serviceId ?? null }).where(eq(billingEvents.id, row!.id));
        await tx.update(billingIntegrations).set({ lastEventAt: new Date() }).where(eq(billingIntegrations.id, i.id));
        await this.audit.record({ orgId: i.orgId, actor: { type: 'system', label: `billing integration ${i.name}` }, customerId: out.customerId ?? null, action: 'billing.event', target: { type: 'billing_event', id: String(row!.id) }, outcome: out.status === 'rejected' ? 'failure' : 'success', metadata: { eventId: ev.id, type: ev.type, status: out.status, message: out.message } }, tx);
        if (out.status === 'applied') await emitEvent(tx, { orgId: i.orgId, type: 'billing.event_applied', customerId: out.customerId ?? null, subject: out.serviceId ? { type: 'service', id: out.serviceId } : undefined, payload: { eventId: ev.id, type: ev.type, message: out.message, serviceId: out.serviceId ?? null } });
        return { duplicate: false, status: out.status, message: out.message };
      });
    } catch (e) {
      if (isUnique(e)) {
        const [again] = await this.db.select().from(billingEvents).where(and(eq(billingEvents.integrationId, i.id), eq(billingEvents.eventId, ev.id)));
        return { duplicate: true, status: again?.status ?? 'review', message: again?.message ?? null };
      }
      throw e;
    }
  }

  private async customerByClient(tx: DbOrTx, i: BillingIntegration, clientId: string) {
    const rows = await tx.select().from(customers).where(and(eq(customers.orgId, i.orgId), eq(customers.billingReference, clientId)));
    if (rows.length > 1) throw new BadRequestException({ message: `Several customers have billing reference ${clientId}` });
    return rows[0] ?? null;
  }

  private async apply(tx: DbOrTx, i: BillingIntegration, type: string, data: Record<string, unknown>): Promise<Outcome> {
    // Events with different ids for the same client or service are applied one at a time,
    // so two near-simultaneous "created" events can't create the record twice.
    const subject = type === 'client.upsert' ? `client:${String(data.clientId ?? '')}` : `service:${String(data.serviceId ?? '')}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${i.id}:${subject}`}))`);
    if (type === 'client.upsert') {
      const c = billingClientSchema.parse(data);
      const cur = await this.customerByClient(tx, i, c.clientId);
      if (c.status === 'Closed') {
        // Closing an account locks its portal users out: a person decides.
        return { status: 'review', message: `WHMCS closed client ${c.clientId}; close the customer in NexoraDC if that is intended`, customerId: cur?.id ?? null };
      }
      const status = c.status === 'Inactive' ? 'suspended' : 'active';
      if (!cur) {
        if (!i.autoCreateCustomers) return { status: 'review', message: `Unknown WHMCS client ${c.clientId} (automatic creation is off)` };
        const code = `WHMCS-${c.clientId}`.toUpperCase().replace(/[^A-Z0-9-]/g, '-').slice(0, 31);
        const [n] = await tx.insert(customers).values({ orgId: i.orgId, code, name: c.name, contactEmail: c.email ?? null, billingReference: c.clientId, status }).returning();
        return { status: 'applied', message: `Created customer ${n!.name} (${code})`, customerId: n!.id };
      }
      // An event without an email keeps the one on file.
      const email = c.email === undefined ? cur.contactEmail : c.email;
      const changes: string[] = [];
      if (cur.name !== c.name) changes.push('name');
      if ((cur.contactEmail ?? null) !== (email ?? null)) changes.push('email');
      if (cur.status !== status && cur.status !== 'closed') changes.push(`status ${cur.status} → ${status}`);
      if (!changes.length) return { status: 'ignored', message: 'No change', customerId: cur.id };
      await tx.update(customers).set({ name: c.name, contactEmail: email ?? null, ...(cur.status !== 'closed' ? { status } : {}) }).where(eq(customers.id, cur.id));
      return { status: 'applied', message: `Updated customer: ${changes.join(', ')}`, customerId: cur.id };
    }

    const s = billingServiceSchema.parse(data);
    const existing = await tx.select().from(services).where(and(eq(services.orgId, i.orgId), eq(services.billingReference, s.serviceId)));
    if (existing.length > 1) return { status: 'review', message: `Several services have billing reference ${s.serviceId}` };
    let svc = existing[0] ?? null;

    if (type === 'service.created' || (!svc && type === 'service.activated')) {
      if (!svc) {
        if (!i.autoCreateServices) return { status: 'review', message: `Unknown WHMCS service ${s.serviceId} (automatic creation is off)` };
        if (!s.clientId) return { status: 'rejected', message: 'The event has no client id' };
        const cust = await this.customerByClient(tx, i, s.clientId);
        if (!cust) return { status: 'review', message: `WHMCS client ${s.clientId} is not linked to a customer yet` };
        const [m] = s.productId ? await tx.select().from(billingProductMappings).where(and(eq(billingProductMappings.integrationId, i.id), eq(billingProductMappings.productId, s.productId))) : [];
        const [n] = await tx
          .insert(services)
          .values({ orgId: i.orgId, customerId: cust.id, kind: m?.kind ?? 'other', name: s.name || m?.label || `WHMCS service ${s.serviceId}`, billingReference: s.serviceId, status: 'pending' })
          .returning();
        await tx.insert(serviceEvents).values({ serviceId: n!.id, actorLabel: `WHMCS (${i.name})`, toStatus: 'pending', summary: `Created from WHMCS${m ? '' : ' (product not mapped: kind “other”)'}` });
        await emitEvent(tx, { orgId: i.orgId, type: 'service.created', customerId: cust.id, subject: { type: 'service', id: n!.id }, payload: { serviceId: n!.id, kind: n!.kind, name: n!.name, status: 'pending', billingReference: s.serviceId, source: 'whmcs' } });
        svc = n!;
        if (type === 'service.created') return { status: 'applied', message: `Created service “${n!.name}”`, customerId: cust.id, serviceId: n!.id };
      } else {
        if (s.name && s.name !== svc.name) {
          await tx.update(services).set({ name: s.name }).where(eq(services.id, svc.id));
          return { status: 'applied', message: `Renamed service to “${s.name}”`, customerId: svc.customerId, serviceId: svc.id };
        }
        return { status: 'ignored', message: 'The service already exists', customerId: svc.customerId, serviceId: svc.id };
      }
    }
    if (!svc) return { status: 'review', message: `Unknown WHMCS service ${s.serviceId}` };
    if (s.clientId) {
      const cust = await this.customerByClient(tx, i, s.clientId);
      if (cust && cust.id !== svc.customerId) return { status: 'review', message: `WHMCS says service ${s.serviceId} belongs to client ${s.clientId}, but it belongs to another customer here`, customerId: svc.customerId, serviceId: svc.id };
    }
    const from = svc.status as ServiceStatus;
    const to = TARGET[type]!(from);
    if (from === to) return { status: 'ignored', message: `Already ${to}`, customerId: svc.customerId, serviceId: svc.id };
    if (!SERVICE_TRANSITIONS[from].includes(to)) return { status: 'rejected', message: `A ${from} service can't become ${to}`, customerId: svc.customerId, serviceId: svc.id };
    const today = new Date().toISOString().slice(0, 10);
    await tx
      .update(services)
      .set({ status: to, startDate: to === 'active' && !svc.startDate ? today : svc.startDate, endDate: (to === 'terminated' || to === 'cancelled') && !svc.endDate ? today : svc.endDate })
      .where(eq(services.id, svc.id));
    await tx.insert(serviceEvents).values({ serviceId: svc.id, actorLabel: `WHMCS (${i.name})`, fromStatus: from, toStatus: to, summary: `${from} → ${to} from WHMCS${s.reason ? `: ${s.reason}` : ''}` });
    await emitEvent(tx, { orgId: i.orgId, type: 'service.status_changed', customerId: svc.customerId, subject: { type: 'service', id: svc.id }, payload: { serviceId: svc.id, kind: svc.kind, name: svc.name, from, to, reason: s.reason ?? null, billingReference: s.serviceId, source: 'whmcs' } });
    return { status: 'applied', message: `${from} → ${to} (record only; no equipment was changed)`, customerId: svc.customerId, serviceId: svc.id };
  }

  /** Connection test from the module: the signature was already checked. */
  ping(i: BillingIntegration) {
    return { ok: true, integration: i.name, serverTime: new Date().toISOString() };
  }

  /* ================================================================ reconciliation */

  /** Compares a WHMCS snapshot with NexoraDC's services. Report only: nothing is changed. */
  async reconcile(i: BillingIntegration, input: z.infer<typeof reconcileSchema>, source: string) {
    const ours = await this.db.execute<{ id: string; billing_reference: string; status: string; name: string; client: string | null; customer_name: string }>(sql`
      select s.id, s.billing_reference, s.status::text as status, s.name, c.billing_reference as client, c.name as customer_name
        from services s join customers c on c.id = s.customer_id
       where s.org_id = ${i.orgId} and s.billing_reference is not null`);
    const byRef = new Map(ours.rows.map((r) => [r.billing_reference, r]));
    const seen = new Set<string>();
    const map: Record<string, string> = { Active: 'active', Suspended: 'suspended', Terminated: 'terminated', Cancelled: 'cancelled', Pending: 'pending', Fraud: 'cancelled', Completed: 'terminated' };
    const items: Record<string, unknown>[] = [];
    let ok = 0;
    for (const w of input.services) {
      seen.add(w.serviceId);
      const o = byRef.get(w.serviceId);
      const expected = map[w.status] ?? w.status.toLowerCase();
      if (!o) {
        if (expected !== 'terminated' && expected !== 'cancelled') items.push({ kind: 'missing_in_nexoradc', serviceId: w.serviceId, clientId: w.clientId, whmcsStatus: w.status, name: w.name ?? null });
        else ok++;
        continue;
      }
      const issues: string[] = [];
      if (o.status !== expected) issues.push('status');
      if (o.client !== w.clientId) issues.push('customer');
      if (issues.length) items.push({ kind: issues.includes('customer') ? 'customer_mismatch' : 'status_mismatch', serviceId: w.serviceId, id: o.id, name: o.name, whmcsStatus: w.status, nexoradcStatus: o.status, whmcsClientId: w.clientId, nexoradcClientId: o.client, customerName: o.customer_name });
      else ok++;
    }
    for (const o of ours.rows) {
      if (!seen.has(o.billing_reference) && !['terminated', 'cancelled'].includes(o.status)) items.push({ kind: 'missing_in_whmcs', serviceId: o.billing_reference, id: o.id, name: o.name, nexoradcStatus: o.status, customerName: o.customer_name });
    }
    const summary = {
      whmcsServices: input.services.length,
      matched: ok,
      missingInNexoradc: items.filter((x) => x.kind === 'missing_in_nexoradc').length,
      missingInWhmcs: items.filter((x) => x.kind === 'missing_in_whmcs').length,
      statusMismatch: items.filter((x) => x.kind === 'status_mismatch').length,
      customerMismatch: items.filter((x) => x.kind === 'customer_mismatch').length,
    };
    const [r] = await this.db.insert(billingReconciliations).values({ integrationId: i.id, source, summary, items: items.slice(0, 5000) }).returning();
    await this.audit.record({ orgId: i.orgId, actor: { type: 'system', label: `billing integration ${i.name}` }, action: 'billing.reconcile', target: { type: 'billing_integration', id: i.id }, outcome: 'success', metadata: { source, ...summary } });
    return { id: r!.id, at: r!.at, summary, items };
  }

  async reconcileByStaff(p: Principal, id: string, input: z.infer<typeof reconcileSchema>) {
    const i = await this.integration(p, id);
    return this.reconcile(i, input, `upload by ${p.email}`);
  }

  /* ================================================================ usage for billing */

  /**
   * Energy and bandwidth for a service over a period, for usage-based billing.
   * Energy covers the service's server and the equipment in its rack space;
   * measured and estimated kWh are separate. Bandwidth is the 95th percentile of
   * the customer's ports (all of them: ports are not tied to services).
   */
  async usage(p: Principal, q: z.infer<typeof usageQuerySchema>) {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (to <= from || to.getTime() - from.getTime() > 92 * 86_400_000) throw new BadRequestException({ error: 'invalid_period', message: 'Give a period of up to 92 days' });
    const rows = await this.db.select().from(services).where(and(eq(services.orgId, p.orgId), eq(services.billingReference, q.billingReference)));
    if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'No service with that billing reference' });
    if (rows.length > 1) throw new ConflictException({ error: 'ambiguous', message: 'Several services have that billing reference' });
    const s = rows[0]!;
    const devs = new Set<string>();
    if (s.deviceId) devs.add(s.deviceId);
    const allocs = await this.db.select().from(coloAllocations).where(eq(coloAllocations.serviceId, s.id));
    for (const a of allocs) {
      const r = await this.db.execute<{ id: string }>(sql`select id from devices where rack_id = ${a.rackId} and customer_id = ${s.customerId} and (u_range is null or u_range && int4range(${a.startU}, ${a.endU + 1}))`);
      r.rows.forEach((d) => devs.add(d.id));
    }
    const ids = [...devs];
    const energy = ids.length
      ? [...(await this.power.energy(p, from, to, 'all', sql`h.device_id in (${sql.join(ids.map((d) => sql`${d}::uuid`), sql`, `)})`)).values()][0]
      : undefined;
    const bw = await customerP95(this.db, p.orgId, s.customerId, from, to);
    return {
      service: { id: s.id, name: s.name, kind: s.kind, status: s.status, billingReference: s.billingReference },
      period: { from: from.toISOString(), to: to.toISOString() },
      energy: {
        devices: ids.length,
        measuredKwh: Math.round((energy?.measuredKwh ?? 0) * 1000) / 1000,
        estimatedKwh: Math.round((energy?.estimatedKwh ?? 0) * 1000) / 1000,
        unknownHours: Math.round((energy?.unknownHours ?? 0) * 10) / 10,
      },
      contractedPowerW: allocs.filter((a) => !a.endedAt).reduce((x, a) => x + a.contractedPowerW, 0) || null,
      bandwidth: { scope: 'customer', ...bw, coverage: bw.expectedSamples ? Math.round((bw.samples / bw.expectedSamples) * 1000) / 10 : null },
    };
  }
}
