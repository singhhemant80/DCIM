import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { SERVICE_TRANSITIONS, type ServiceInput, type ServiceStatus, serviceListQuerySchema, serviceStatusSchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { devices, serviceEvents, services, virtGuests } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';
import { assertStaffWrite, customerFor, transitionAllowed, visibleTo } from './common';

const staff = (p: Principal) => p.userType === 'staff';

/**
 * Orders & Services: what each customer has (colocation space, servers, VMs,
 * transit, cross-connects…) and its lifecycle. Status changes are records
 * only: suspending or terminating a service never switches equipment off.
 */
@Injectable()
export class ServicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private view(p: Principal, r: Record<string, unknown>) {
    return {
      id: r.id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      kind: r.kind,
      name: r.name,
      description: r.description ?? null,
      status: r.status,
      startDate: r.start_date ?? null,
      endDate: r.end_date ?? null,
      billingReference: r.billing_reference ?? null,
      deviceId: r.device_id ?? null,
      deviceName: r.device_name ?? null,
      guestId: r.guest_id ?? null,
      guestName: r.guest_name ?? null,
      notes: staff(p) ? (r.notes ?? null) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async list(p: Principal, q: z.infer<typeof serviceListQuerySchema> & { id?: string }) {
    const conds: SQL[] = [staff(p) ? sql`s.org_id = ${p.orgId}` : p.customerId ? sql`s.org_id = ${p.orgId} and s.customer_id = ${p.customerId}` : sql`false`];
    if (q.id) conds.push(sql`s.id = ${q.id}`);
    if (q.customerId && staff(p)) conds.push(sql`s.customer_id = ${q.customerId}`);
    if (q.kind) conds.push(sql`s.kind = ${q.kind}`);
    if (q.status) conds.push(sql`s.status = ${q.status}`);
    if (q.q) conds.push(sql`(s.name ilike ${'%' + q.q + '%'} or s.billing_reference = ${q.q})`);
    const where = sql.join(conds, sql` and `);
    const [rows, total] = await Promise.all([
      this.db.execute<Record<string, unknown>>(sql`
        select s.*, c.name as customer_name, coalesce(d.hostname, d.asset_tag) as device_name, g.name as guest_name
          from services s join customers c on c.id = s.customer_id left join devices d on d.id = s.device_id left join virt_guests g on g.id = s.guest_id
         where ${where}
         order by (s.status in ('pending','active','suspended')) desc, c.name, s.name
         limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
      this.db.execute<{ n: number }>(sql`select count(*)::int as n from services s where ${where}`),
    ]);
    return { items: rows.rows.map((r) => this.view(p, r)), page: q.page, pageSize: q.pageSize, total: total.rows[0]?.n ?? 0 };
  }

  async get(p: Principal, id: string) {
    const { items } = await this.list(p, { id, page: 1, pageSize: 1 });
    const s = items[0];
    if (!s) throw new NotFoundException({ error: 'not_found', message: 'Service not found' });
    const [events, allocations, xconns] = await Promise.all([
      this.db.select().from(serviceEvents).where(eq(serviceEvents.serviceId, id)).orderBy(desc(serviceEvents.id)),
      this.db.execute(sql`select a.id, a.kind, a.start_u, a.end_u, a.contracted_power_w, a.ended_at, k.name as rack_name from colo_allocations a join racks k on k.id = a.rack_id where a.service_id = ${id}`),
      this.db.execute(sql`select x.id, x.a_label, x.z_label, x.status, x.circuit_id from cross_connects x where x.service_id = ${id}`),
    ]);
    return {
      ...s,
      events: events.map((e) => ({ ...e, actorLabel: staff(p) ? e.actorLabel : null })),
      allocations: allocations.rows,
      crossConnects: xconns.rows,
    };
  }

  private async refs(db: DbOrTx, p: Principal, customerId: string, input: ServiceInput) {
    if (input.deviceId) {
      const [d] = await db.select({ customerId: devices.customerId }).from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.orgId, p.orgId)));
      if (!d) throw new BadRequestException({ error: 'invalid_device', message: 'Device not found' });
      if (d.customerId && d.customerId !== customerId) throw new BadRequestException({ error: 'invalid_device', message: 'The device belongs to another customer' });
    }
    if (input.guestId) {
      const [g] = await db.select({ customerId: virtGuests.customerId }).from(virtGuests).where(and(eq(virtGuests.id, input.guestId), eq(virtGuests.orgId, p.orgId)));
      if (!g) throw new BadRequestException({ error: 'invalid_vm', message: 'VM not found' });
      if (g.customerId && g.customerId !== customerId) throw new BadRequestException({ error: 'invalid_vm', message: 'The VM belongs to another customer' });
    }
  }

  private values(input: ServiceInput) {
    return {
      kind: input.kind,
      name: input.name,
      description: input.description ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      billingReference: input.billingReference ?? null,
      deviceId: input.deviceId ?? null,
      guestId: input.guestId ?? null,
      notes: input.notes ?? null,
    };
  }

  async create(p: Principal, input: ServiceInput, meta: RequestMeta) {
    assertStaffWrite(p);
    const customerId = (await customerFor(this.db, p, input.customerId))!;
    await this.refs(this.db, p, customerId, input);
    try {
      return await this.db.transaction(async (tx) => {
        const [s] = await tx.insert(services).values({ orgId: p.orgId, customerId, ...this.values(input) }).returning();
        await tx.insert(serviceEvents).values({ serviceId: s!.id, actorLabel: p.email, toStatus: 'pending', summary: 'Created' });
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId, action: 'service.create', target: { type: 'service', id: s!.id }, outcome: 'success', meta, metadata: { kind: input.kind, name: input.name } }, tx);
        return s!;
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  async update(p: Principal, id: string, input: ServiceInput, meta: RequestMeta) {
    assertStaffWrite(p);
    try {
      return await this.db.transaction(async (tx) => {
        const [cur] = await tx.select().from(services).where(and(eq(services.id, id), eq(services.orgId, p.orgId))).for('update');
        visibleTo(p, cur, 'Service');
        if (input.customerId !== cur!.customerId) throw new BadRequestException({ error: 'customer_fixed', message: 'A service cannot move to another customer; end it and create a new one' });
        await this.refs(tx, p, cur!.customerId, input);
        const [s] = await tx.update(services).set(this.values(input)).where(eq(services.id, id)).returning();
        const changed = (['name', 'kind', 'startDate', 'endDate', 'billingReference', 'deviceId', 'guestId'] as const).filter((k) => (cur as Record<string, unknown>)[k] !== (s as Record<string, unknown>)[k]);
        if (changed.length) await tx.insert(serviceEvents).values({ serviceId: id, actorLabel: p.email, summary: `Changed ${changed.join(', ')}` });
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: cur!.customerId, action: 'service.update', target: { type: 'service', id }, outcome: 'success', meta, metadata: { changed } }, tx);
        return s!;
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  async setStatus(p: Principal, id: string, input: z.infer<typeof serviceStatusSchema>, meta: RequestMeta) {
    assertStaffWrite(p);
    return this.db.transaction(async (tx) => {
      const [cur] = await tx.select().from(services).where(and(eq(services.id, id), eq(services.orgId, p.orgId))).for('update');
      visibleTo(p, cur, 'Service');
      const from = cur!.status as ServiceStatus;
      if (from === input.status) return cur!;
      transitionAllowed(SERVICE_TRANSITIONS, from, input.status, 'A service');
      const today = new Date().toISOString().slice(0, 10);
      const [s] = await tx
        .update(services)
        .set({
          status: input.status,
          startDate: input.status === 'active' && !cur!.startDate ? today : cur!.startDate,
          endDate: (input.status === 'terminated' || input.status === 'cancelled') && !cur!.endDate ? today : cur!.endDate,
        })
        .where(eq(services.id, id))
        .returning();
      await tx.insert(serviceEvents).values({ serviceId: id, actorLabel: p.email, fromStatus: from, toStatus: input.status, summary: input.reason ? `${from} → ${input.status}: ${input.reason}` : `${from} → ${input.status}` });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: cur!.customerId, action: 'service.status', target: { type: 'service', id }, outcome: 'success', meta, metadata: { from, to: input.status, reason: input.reason ?? null } }, tx);
      return s!;
    });
  }
}
