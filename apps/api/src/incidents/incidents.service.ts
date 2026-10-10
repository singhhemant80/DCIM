import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { incidentListQuerySchema, incidentSchema, incidentUpdateSchema, maintenanceNoticeSchema } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { customers, datacenters, incidentUpdates, incidents, maintenanceWindows } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import type { Principal, RequestMeta } from '../auth/principal';
import { emitEvent } from '../events/events';

/** Datacenters where a customer has equipment, rack space or a dedicated rack. */
const customerSites = (customerId: string) => sql`(
  select b.datacenter_id from devices d join racks r on r.id = d.rack_id join rooms ro on ro.id = r.room_id join buildings b on b.id = ro.building_id where d.customer_id = ${customerId}
  union select b.datacenter_id from colo_allocations a join racks r on r.id = a.rack_id join rooms ro on ro.id = r.room_id join buildings b on b.id = ro.building_id where a.customer_id = ${customerId} and a.ended_at is null
  union select b.datacenter_id from racks r join rooms ro on ro.id = r.room_id join buildings b on b.id = ro.building_id where r.customer_id = ${customerId})`;

/**
 * Incidents and customer-facing maintenance notices.
 *
 * Staff see everything. A customer sees public incidents that name it or
 * affect a site where it has equipment or space, with public updates only, and
 * maintenance windows marked customer-visible that cover all sites, one of its
 * sites, or one of its devices. Internal notes and staff identities are never
 * shown to customers.
 */
@Injectable()
export class IncidentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private visible(p: Principal) {
    if (p.userType === 'staff') return sql`i.org_id = ${p.orgId}`;
    if (!p.customerId) return sql`false`;
    return sql`i.org_id = ${p.orgId} and i.public and (${p.customerId}::uuid = any(i.customer_ids) or i.datacenter_id in ${customerSites(p.customerId)})`;
  }

  async list(p: Principal, q: z.infer<typeof incidentListQuerySchema>) {
    const st = q.status === 'open' ? sql`i.status <> 'resolved'` : q.status === 'resolved' ? sql`i.status = 'resolved'` : sql`true`;
    const where = sql`${this.visible(p)} and ${st}`;
    const total = (await this.db.execute<{ n: number }>(sql`select count(*)::int as n from incidents i where ${where}`)).rows[0]?.n ?? 0;
    const rows = await this.db.execute<Record<string, unknown>>(sql`
      select i.id, i.title, i.severity, i.status, i.datacenter_id, dc.code as datacenter_code, dc.name as datacenter_name, i.public, i.started_at, i.resolved_at, i.updated_at,
             ${p.userType === 'staff' ? sql`i.customer_ids, i.created_by` : sql`null::uuid[] as customer_ids, null as created_by`},
             (select u.message from incident_updates u where u.incident_id = i.id ${p.userType === 'staff' ? sql`` : sql`and u.public`} order by u.id desc limit 1) as latest
        from incidents i left join datacenters dc on dc.id = i.datacenter_id
       where ${where} order by i.started_at desc limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`);
    return {
      items: rows.rows.map((r) => ({
        id: r.id,
        title: r.title,
        severity: r.severity,
        status: r.status,
        datacenter: r.datacenter_id ? { id: r.datacenter_id, code: r.datacenter_code, name: r.datacenter_name } : null,
        public: r.public,
        startedAt: r.started_at,
        resolvedAt: r.resolved_at,
        updatedAt: r.updated_at,
        latest: r.latest,
        ...(p.userType === 'staff' ? { customerIds: r.customer_ids, createdBy: r.created_by } : {}),
      })),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }

  async get(p: Principal, id: string) {
    const r = await this.db.execute<{ id: string }>(sql`select i.id from incidents i where i.id = ${id} and ${this.visible(p)}`);
    if (!r.rows.length) throw new NotFoundException({ error: 'not_found', message: 'Incident not found' });
    const [i] = await this.db.select().from(incidents).where(eq(incidents.id, id));
    const ups = await this.db
      .select()
      .from(incidentUpdates)
      .where(and(eq(incidentUpdates.incidentId, id), p.userType === 'staff' ? sql`true` : eq(incidentUpdates.public, true)))
      .orderBy(asc(incidentUpdates.id));
    const [dc] = i!.datacenterId ? await this.db.select({ id: datacenters.id, code: datacenters.code, name: datacenters.name }).from(datacenters).where(eq(datacenters.id, i!.datacenterId)) : [];
    const staff = p.userType === 'staff';
    return {
      id: i!.id,
      title: i!.title,
      severity: i!.severity,
      status: i!.status,
      datacenter: dc ?? null,
      public: i!.public,
      startedAt: i!.startedAt,
      resolvedAt: i!.resolvedAt,
      ...(staff ? { customerIds: i!.customerIds, createdBy: i!.createdBy } : {}),
      updates: ups.map((u) => ({ id: u.id, at: u.at, status: u.status, message: u.message, ...(staff ? { public: u.public, author: u.author } : {}) })),
    };
  }

  private async checkRefs(p: Principal, input: z.infer<typeof incidentSchema>) {
    if (input.datacenterId) {
      const [dc] = await this.db.select({ id: datacenters.id }).from(datacenters).where(and(eq(datacenters.id, input.datacenterId), eq(datacenters.orgId, p.orgId)));
      if (!dc) throw new BadRequestException({ error: 'invalid_datacenter', message: 'Datacenter not found' });
    }
    const ids = [...new Set(input.customerIds)];
    if (ids.length) {
      const r = await this.db.execute<{ n: number }>(sql`select count(*)::int as n from customers where org_id = ${p.orgId} and id in (${sql.join(ids.map((x) => sql`${x}::uuid`), sql`, `)})`);
      if (r.rows[0]!.n !== ids.length) throw new BadRequestException({ error: 'invalid_customer', message: 'One or more customers do not exist' });
    }
    if (!input.datacenterId && !ids.length && input.public) throw new BadRequestException({ error: 'no_audience', message: 'Choose the affected site or customers, or make the incident internal' });
    return ids;
  }

  async create(p: Principal, input: z.infer<typeof incidentSchema>, meta: RequestMeta) {
    const ids = await this.checkRefs(p, input);
    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
    if (startedAt.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException({ error: 'invalid_time', message: 'An incident cannot start in the future (use a maintenance window for planned work)' });
    return this.db.transaction(async (tx) => {
      const [i] = await tx.insert(incidents).values({ orgId: p.orgId, title: input.title, severity: input.severity, datacenterId: input.datacenterId ?? null, customerIds: ids, public: input.public, startedAt, createdBy: p.email }).returning();
      await tx.insert(incidentUpdates).values({ incidentId: i!.id, status: 'investigating', message: input.message, public: input.public, author: p.email });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'incident.create', target: { type: 'incident', id: i!.id }, outcome: 'success', meta, metadata: { title: input.title, severity: input.severity, public: input.public } }, tx);
      await emitEvent(tx, { orgId: p.orgId, type: 'incident.created', subject: { type: 'incident', id: i!.id }, payload: { incidentId: i!.id, title: i!.title, severity: i!.severity, status: i!.status, public: i!.public, datacenterId: i!.datacenterId, customerIds: ids } });
      return i!;
    });
  }

  async update(p: Principal, id: string, input: z.infer<typeof incidentUpdateSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [i] = await tx.select().from(incidents).where(and(eq(incidents.id, id), eq(incidents.orgId, p.orgId))).for('update');
      if (!i) throw new NotFoundException({ error: 'not_found', message: 'Incident not found' });
      // An internal incident only gets internal updates.
      const pub = i.public && input.public;
      await tx.insert(incidentUpdates).values({ incidentId: id, status: input.status, message: input.message, public: pub, author: p.email });
      const resolvedAt = input.status === 'resolved' ? (i.resolvedAt ?? new Date()) : null;
      const [n] = await tx.update(incidents).set({ status: input.status, resolvedAt }).where(eq(incidents.id, id)).returning();
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'incident.update', target: { type: 'incident', id }, outcome: 'success', meta, metadata: { from: i.status, to: input.status, public: pub } }, tx);
      await emitEvent(tx, { orgId: p.orgId, type: 'incident.updated', subject: { type: 'incident', id }, payload: { incidentId: id, title: i.title, severity: i.severity, from: i.status, status: input.status, public: pub, message: pub ? input.message : null, datacenterId: i.datacenterId, customerIds: i.customerIds } });
      return n!;
    });
  }

  /* ---------------------------------------------------------------- maintenance notices */

  /** Maintenance windows: staff get all recent ones; customers get the visible ones that affect them. */
  async maintenance(p: Principal) {
    const where =
      p.userType === 'staff'
        ? sql`m.org_id = ${p.orgId}`
        : p.customerId
          ? sql`m.org_id = ${p.orgId} and m.customer_visible and (m.scope = 'all'
               or (m.scope = 'datacenter' and m.datacenter_id in ${customerSites(p.customerId)})
               or (m.scope = 'devices' and exists (select 1 from devices d where d.id = any(m.device_ids) and d.customer_id = ${p.customerId})))`
          : sql`false`;
    const r = await this.db.execute<Record<string, unknown>>(sql`
      select m.id, m.name, m.starts_at, m.ends_at, m.scope, m.datacenter_id, dc.code as datacenter_code, dc.name as datacenter_name, m.description, m.customer_visible,
             ${p.userType === 'staff' ? sql`m.notes, cardinality(m.device_ids) as devices` : p.customerId ? sql`null as notes, (select count(*)::int from devices d where d.id = any(m.device_ids) and d.customer_id = ${p.customerId}) as devices` : sql`null as notes, 0 as devices`}
        from maintenance_windows m left join datacenters dc on dc.id = m.datacenter_id
       where ${where} and m.ends_at > now() - interval '30 days' order by m.starts_at desc limit 200`);
    return r.rows.map((m) => ({
      id: m.id,
      // The window's name is internal (it may name other customers or equipment); customers get the notice.
      name: p.userType === 'staff' ? m.name : 'Planned maintenance',
      startsAt: m.starts_at,
      endsAt: m.ends_at,
      scope: m.scope,
      datacenter: m.datacenter_id ? { id: m.datacenter_id, code: m.datacenter_code, name: m.datacenter_name } : null,
      description: m.description,
      affectedDevices: Number(m.devices ?? 0),
      state: new Date(m.starts_at as string) > new Date() ? 'scheduled' : new Date(m.ends_at as string) > new Date() ? 'in_progress' : 'completed',
      ...(p.userType === 'staff' ? { customerVisible: m.customer_visible, notes: m.notes } : {}),
    }));
  }

  async setNotice(p: Principal, id: string, input: z.infer<typeof maintenanceNoticeSchema>, meta: RequestMeta) {
    if (input.customerVisible && !input.description) throw new BadRequestException({ error: 'description_required', message: 'Write the notice customers will see' });
    return this.db.transaction(async (tx) => {
      const [m] = await tx
        .update(maintenanceWindows)
        .set({ customerVisible: input.customerVisible, description: input.description ?? null })
        .where(and(eq(maintenanceWindows.id, id), eq(maintenanceWindows.orgId, p.orgId)))
        .returning();
      if (!m) throw new NotFoundException({ error: 'not_found', message: 'Maintenance window not found' });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'maintenance.notice', target: { type: 'maintenance_window', id }, outcome: 'success', meta, metadata: { customerVisible: input.customerVisible } }, tx);
      return { id: m.id, customerVisible: m.customerVisible, description: m.description };
    });
  }

  /** Staff picker: customers for incident targeting. */
  async customerOptions(p: Principal) {
    return this.db.select({ id: customers.id, code: customers.code, name: customers.name }).from(customers).where(and(eq(customers.orgId, p.orgId), sql`${customers.status} <> 'closed'`)).orderBy(customers.name);
  }
}
