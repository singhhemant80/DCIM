import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ALLOCATION_KIND_LABELS,
  CROSS_CONNECT_TRANSITIONS,
  SHIPMENT_TRANSITIONS,
  VISIT_TRANSITIONS,
  allocationRange,
  type AllocationInput,
  type CrossConnectInput,
  type CrossConnectStatus,
  type ShipmentInput,
  type ShipmentStatus,
  type VisitInput,
  type VisitStatus,
  allocationEndSchema,
  allocationUpdateSchema,
  coloListQuerySchema,
  crossConnectStatusSchema,
  shipmentStatusSchema,
  visitStatusSchema,
} from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { cables, coloAllocations, crossConnects, datacenters, devices, interfaces, rackEvents, rackReservations, racks, services, shipments, visits } from '../db/schema';
import { emitEvent } from '../events/events';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';
import { PowerService } from '../power/power.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { assertCanRequest, assertStaffWrite, customerFor, transitionAllowed, visibleTo } from './common';

type ListQuery = z.infer<typeof coloListQuerySchema>;
const staff = (p: Principal) => p.userType === 'staff';

/**
 * Colocation: rack space contracted to customers (with contracted power),
 * cross-connects, shipments received for customers and site visits.
 *
 * Customers see and request only their own; staff manage everything.
 * An active allocation holds its units with a rack reservation, so the rack
 * elevation and device placement rules already keep other customers out.
 */
@Injectable()
export class ColocationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly power: PowerService,
    private readonly monitoring: MonitoringService,
  ) {}

  private record(p: Principal, meta: RequestMeta, action: string, target: { type: string; id: string }, customerId: string | null, metadata?: Record<string, unknown>, tx?: DbOrTx) {
    return this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: customerId ?? p.customerId, action, target, outcome: 'success', meta, metadata }, tx);
  }

  /** Customers see their own colleagues by email, and the operator's staff only as "Datacenter team". */
  private static who(p: Principal, email: unknown, type: unknown): string | null {
    if (!email) return null;
    return staff(p) || type === 'customer' ? String(email) : 'Datacenter team';
  }

  private scope(p: Principal, alias: string): SQL {
    const a = sql.raw(alias);
    if (staff(p)) return sql`${a}.org_id = ${p.orgId}`;
    if (!p.customerId) return sql`false`;
    return sql`${a}.org_id = ${p.orgId} and ${a}.customer_id = ${p.customerId}`;
  }

  /* ================================================================ allocations */

  async allocations(p: Principal, q: Partial<ListQuery> & { id?: string; active?: boolean } = {}) {
    const conds: SQL[] = [this.scope(p, 'a')];
    if (q.id) conds.push(sql`a.id = ${q.id}`);
    if (q.customerId && staff(p)) conds.push(sql`a.customer_id = ${q.customerId}`);
    if (q.datacenterId) conds.push(sql`b.datacenter_id = ${q.datacenterId}`);
    if (q.status === 'active' || q.active) conds.push(sql`a.ended_at is null`);
    if (q.status === 'ended') conds.push(sql`a.ended_at is not null`);
    const r = await this.db.execute<Record<string, unknown>>(sql`
      select a.*, c.name as customer_name, k.name as rack_name, k.u_height as rack_height, rm.name as room_name, dc.id as datacenter_id, dc.code as datacenter_code, dc.name as datacenter_name,
             s.name as service_name, s.status as service_status
        from colo_allocations a
        join customers c on c.id = a.customer_id
        join racks k on k.id = a.rack_id join rooms rm on rm.id = k.room_id join buildings b on b.id = rm.building_id join datacenters dc on dc.id = b.datacenter_id
        left join services s on s.id = a.service_id
       where ${sql.join(conds, sql` and `)}
       order by (a.ended_at is not null), c.name, dc.code, k.name, a.start_u`);
    const rows = r.rows;
    // Power of the customer's equipment inside each allocation, measured and estimated kept apart.
    const active = rows.filter((x) => !x.ended_at);
    const byAlloc = new Map<string, { measuredW: number; estimatedW: number; unknownDevices: number; devices: number }>();
    if (active.length) {
      const rackIds = [...new Set(active.map((x) => x.rack_id as string))];
      const placed = await this.db.execute<{ id: string; rack_id: string; customer_id: string | null; lo: number | null; hi: number | null }>(sql`
        select d.id, d.rack_id, d.customer_id, lower(d.u_range) as lo, upper(d.u_range) - 1 as hi
          from devices d where d.org_id = ${p.orgId} and d.rack_id in (${sql.join(rackIds.map((x) => sql`${x}::uuid`), sql`, `)})`);
      const now = await this.power.current(p, sql`d.rack_id in (${sql.join(rackIds.map((x) => sql`${x}::uuid`), sql`, `)})`);
      const pw = new Map(now.map((d) => [d.deviceId, d]));
      // Each device belongs to one allocation only: the lowest one of its customer in that rack that it
      // overlaps; zero-U or unpositioned equipment goes to the customer's lowest allocation in the rack.
      const owner = new Map<string, string>();
      const sorted = [...active].sort((x, y) => (x.start_u as number) - (y.start_u as number));
      for (const d of placed.rows) {
        const a = sorted.find((x) => x.rack_id === d.rack_id && x.customer_id === d.customer_id && (d.lo === null || (d.lo <= (x.end_u as number) && (d.hi as number) >= (x.start_u as number))));
        if (a) owner.set(d.id, a.id as string);
      }
      for (const a of active) {
        const acc = { measuredW: 0, estimatedW: 0, unknownDevices: 0, devices: 0 };
        for (const d of placed.rows) {
          if (owner.get(d.id) !== a.id) continue;
          const x = pw.get(d.id);
          if (!x || !x.counted) continue;
          acc.devices++;
          if (x.quality === 'measured') acc.measuredW += x.watts ?? 0;
          else if (x.quality === 'estimated') acc.estimatedW += x.watts ?? 0;
          else if (x.quality === 'unknown') acc.unknownDevices++;
        }
        byAlloc.set(a.id as string, acc);
      }
    }
    return rows.map((a) => {
      const pw = byAlloc.get(a.id as string) ?? null;
      const contracted = a.contracted_power_w as number;
      return {
        id: a.id,
        customerId: a.customer_id,
        customerName: a.customer_name,
        serviceId: a.service_id ?? null,
        serviceName: a.service_name ?? null,
        serviceStatus: a.service_status ?? null,
        rackId: a.rack_id,
        rackName: a.rack_name,
        rackHeight: a.rack_height,
        roomName: a.room_name,
        datacenterId: a.datacenter_id,
        datacenterCode: a.datacenter_code,
        datacenterName: a.datacenter_name,
        kind: a.kind,
        part: a.part ?? null,
        startU: a.start_u,
        endU: a.end_u,
        units: (a.end_u as number) - (a.start_u as number) + 1,
        contractedPowerW: contracted,
        feeds: a.feeds,
        breakerAmps: a.breaker_amps ?? null,
        voltage: a.voltage ?? null,
        startDate: a.start_date,
        endDate: a.end_date ?? null,
        endedAt: a.ended_at ?? null,
        endReason: a.end_reason ?? null,
        active: !a.ended_at,
        notes: staff(p) ? (a.notes ?? null) : null,
        power: pw
          ? {
              ...pw,
              /** Share of contracted power in use: measured alone, and measured + estimated. */
              measuredPct: contracted > 0 ? Math.round((pw.measuredW / contracted) * 1000) / 10 : null,
              totalPct: contracted > 0 ? Math.round(((pw.measuredW + pw.estimatedW) / contracted) * 1000) / 10 : null,
              /** Measured draw alone is above the contract. */
              overContract: contracted > 0 && pw.measuredW > contracted,
              /** Only with estimates included would it be above the contract (not proven by measurement). */
              mayExceed: contracted > 0 && pw.measuredW <= contracted && pw.measuredW + pw.estimatedW > contracted,
            }
          : null,
      };
    });
  }

  async allocation(p: Principal, id: string) {
    const [a] = await this.allocations(p, { id });
    if (!a) throw new NotFoundException({ error: 'not_found', message: 'Allocation not found' });
    // The customer's equipment in this space.
    const devs = await this.db.execute(sql`
      select d.id, d.asset_tag, d.hostname, d.position_u, d.face::text as face, m.u_height, m.name as model
        from devices d join device_models m on m.id = d.model_id
       where d.rack_id = ${a.rackId} and d.customer_id = ${a.customerId} and d.org_id = ${p.orgId}
         and (d.u_range is null or d.u_range && int4range(${a.startU as number}, ${(a.endU as number) + 1}))
       order by d.position_u nulls last`);
    return { ...a, devices: devs.rows };
  }

  async createAllocation(p: Principal, input: AllocationInput, meta: RequestMeta) {
    assertStaffWrite(p);
    const customerId = (await customerFor(this.db, p, input.customerId))!;
    try {
      return await this.db.transaction(async (tx) => {
        // Lock the rack: placements and reservations lock it too.
        const [rack] = await tx.select().from(racks).where(and(eq(racks.id, input.rackId), eq(racks.orgId, p.orgId))).for('update');
        if (!rack) throw new BadRequestException({ error: 'invalid_rack', message: 'Rack not found' });
        if (rack.status !== 'active') throw new ConflictException({ error: 'rack_unavailable', message: 'The rack is not in service' });
        if (rack.customerId && rack.customerId !== customerId) throw new ConflictException({ error: 'rack_dedicated', message: 'This rack is dedicated to another customer' });
        const range = allocationRange(input.kind, rack.uHeight, input.part, input.startU, input.endU);
        if (!range) throw new BadRequestException({ error: 'invalid_range', message: `That space does not fit a ${rack.uHeight}U rack` });
        if (input.serviceId) {
          const [s] = await tx.select({ customerId: services.customerId, status: services.status }).from(services).where(and(eq(services.id, input.serviceId), eq(services.orgId, p.orgId)));
          if (!s || s.customerId !== customerId) throw new BadRequestException({ error: 'invalid_service', message: 'The service does not belong to this customer' });
          if (s.status === 'cancelled' || s.status === 'terminated') throw new BadRequestException({ error: 'invalid_service', message: 'The service has ended' });
        }
        // Equipment of anyone else in those units?
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(devices)
          .where(and(eq(devices.rackId, rack.id), sql`${devices.uRange} && int4range(${range.startU}, ${range.endU + 1})`, sql`${devices.customerId} is distinct from ${customerId}`));
        if (n > 0) throw new ConflictException({ error: 'space_in_use', message: `${n} device(s) in U${range.startU}–U${range.endU} belong to someone else` });
        const [a] = await tx
          .insert(coloAllocations)
          .values({
            orgId: p.orgId,
            customerId,
            serviceId: input.serviceId ?? null,
            rackId: rack.id,
            kind: input.kind,
            part: input.kind === 'half' || input.kind === 'quarter' ? input.part! : null,
            startU: range.startU,
            endU: range.endU,
            contractedPowerW: input.contractedPowerW,
            feeds: input.feeds,
            breakerAmps: input.breakerAmps ?? null,
            voltage: input.voltage ?? null,
            startDate: input.startDate,
            notes: input.notes ?? null,
            createdBy: p.email,
          })
          .returning();
        // Hold the units: overlapping reservations are refused by the database.
        await tx.insert(rackReservations).values({ orgId: p.orgId, rackId: rack.id, startU: range.startU, endU: range.endU, customerId, reason: `Colocation: ${ALLOCATION_KIND_LABELS[input.kind]}`, allocationId: a!.id, createdBy: p.userId });
        await tx.insert(rackEvents).values({ orgId: p.orgId, rackId: rack.id, kind: 'allocation', summary: `Allocated U${range.startU}–U${range.endU} (${ALLOCATION_KIND_LABELS[input.kind].toLowerCase()}, ${input.contractedPowerW} W contracted)`, data: { allocationId: a!.id, customerId }, actorId: p.userId, actorLabel: p.email });
        await this.record(p, meta, 'colo.allocation_create', { type: 'colo_allocation', id: a!.id }, customerId, { rackId: rack.id, startU: range.startU, endU: range.endU, kind: input.kind, contractedPowerW: input.contractedPowerW }, tx);
        await emitEvent(tx, { orgId: p.orgId, type: 'allocation.created', customerId, subject: { type: 'colo_allocation', id: a!.id }, payload: { allocationId: a!.id, rackId: rack.id, rack: rack.name, kind: input.kind, startU: range.startU, endU: range.endU, contractedPowerW: input.contractedPowerW } });
        return a!;
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  async updateAllocation(p: Principal, id: string, input: z.infer<typeof allocationUpdateSchema>, meta: RequestMeta) {
    assertStaffWrite(p);
    try {
      return await this.db.transaction(async (tx) => {
        const [a] = await tx.select().from(coloAllocations).where(and(eq(coloAllocations.id, id), eq(coloAllocations.orgId, p.orgId))).for('update');
        if (!a) throw new NotFoundException({ error: 'not_found', message: 'Allocation not found' });
        if (a.endedAt) throw new ConflictException({ error: 'allocation_ended', message: 'The allocation has ended' });
        if (input.serviceId) {
          const [s] = await tx.select({ customerId: services.customerId, status: services.status }).from(services).where(and(eq(services.id, input.serviceId), eq(services.orgId, p.orgId)));
          if (!s || s.customerId !== a.customerId) throw new BadRequestException({ error: 'invalid_service', message: 'The service does not belong to this customer' });
          if (input.serviceId !== a.serviceId && (s.status === 'cancelled' || s.status === 'terminated')) throw new BadRequestException({ error: 'invalid_service', message: 'The service has ended' });
        }
        // Fields left out keep their value; null clears them.
        const keep = <T,>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
        const [u] = await tx
          .update(coloAllocations)
          .set({
            serviceId: keep(input.serviceId, a.serviceId),
            contractedPowerW: input.contractedPowerW,
            feeds: input.feeds,
            breakerAmps: keep(input.breakerAmps, a.breakerAmps),
            voltage: keep(input.voltage, a.voltage),
            notes: keep(input.notes, a.notes),
          })
          .where(eq(coloAllocations.id, id))
          .returning();
        await this.record(p, meta, 'colo.allocation_update', { type: 'colo_allocation', id }, a.customerId, { contractedPowerW: { from: a.contractedPowerW, to: input.contractedPowerW } }, tx);
        return u!;
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  /** Ends an allocation and frees its units. Equipment still in the space is reported, not moved. */
  async endAllocation(p: Principal, id: string, input: z.infer<typeof allocationEndSchema>, meta: RequestMeta) {
    assertStaffWrite(p);
    return this.db.transaction(async (tx) => {
      const [a] = await tx.select().from(coloAllocations).where(and(eq(coloAllocations.id, id), eq(coloAllocations.orgId, p.orgId))).for('update');
      if (!a) throw new NotFoundException({ error: 'not_found', message: 'Allocation not found' });
      if (a.endedAt) throw new ConflictException({ error: 'allocation_ended', message: 'The allocation has already ended' });
      if (input.endDate < String(a.startDate)) throw new BadRequestException({ error: 'invalid_date', message: 'The end date is before the start date' });
      // Ending frees the units now, so the end date can't be later than today (end it on the day).
      if (input.endDate > new Date().toISOString().slice(0, 10)) throw new BadRequestException({ error: 'invalid_date', message: 'End the allocation on or after its last day; the space is released immediately' });
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(devices)
        .where(and(eq(devices.rackId, a.rackId), eq(devices.customerId, a.customerId), sql`${devices.uRange} && int4range(${a.startU}, ${a.endU + 1})`));
      await tx.update(coloAllocations).set({ endDate: input.endDate, endedAt: new Date(), endReason: input.reason ?? null }).where(eq(coloAllocations.id, id));
      await tx.delete(rackReservations).where(eq(rackReservations.allocationId, id));
      await tx.insert(rackEvents).values({ orgId: p.orgId, rackId: a.rackId, kind: 'allocation', summary: `Allocation U${a.startU}–U${a.endU} ended${n ? `; ${n} of the customer's device(s) are still in that space` : ''}`, data: { allocationId: id }, actorId: p.userId, actorLabel: p.email });
      await this.record(p, meta, 'colo.allocation_end', { type: 'colo_allocation', id }, a.customerId, { endDate: input.endDate, reason: input.reason ?? null, devicesRemaining: n }, tx);
      await emitEvent(tx, { orgId: p.orgId, type: 'allocation.ended', customerId: a.customerId, subject: { type: 'colo_allocation', id }, payload: { allocationId: id, rackId: a.rackId, startU: a.startU, endU: a.endU, endDate: input.endDate, devicesRemaining: n } });
      return { id, devicesRemaining: n };
    });
  }

  /* ================================================================ cross-connects */

  async crossConnects(p: Principal, q: Partial<ListQuery> & { id?: string } = {}) {
    const conds: SQL[] = [this.scope(p, 'x')];
    if (q.id) conds.push(sql`x.id = ${q.id}`);
    if (q.customerId && staff(p)) conds.push(sql`x.customer_id = ${q.customerId}`);
    if (q.status === 'open') conds.push(sql`x.status in ('requested','approved','in_progress')`);
    else if (q.status) conds.push(sql`x.status::text = ${q.status}`);
    const r = await this.db.execute<Record<string, unknown>>(sql`
      select x.*, c.name as customer_name, coalesce(d.hostname, d.asset_tag) as a_device_name, i.name as a_interface_name, s.name as service_name, cb.label as cable_label,
             (select u.user_type::text from users u where u.org_id = x.org_id and lower(u.email) = lower(x.requested_by) limit 1) as requester_type
        from cross_connects x join customers c on c.id = x.customer_id
        left join devices d on d.id = x.a_device_id left join interfaces i on i.id = x.a_interface_id
        left join services s on s.id = x.service_id left join cables cb on cb.id = x.cable_id
       where ${sql.join(conds, sql` and `)}
       order by (x.status in ('requested','approved','in_progress')) desc, x.requested_at desc
       limit 500`);
    return r.rows.map((x) => ({
      id: x.id,
      customerId: x.customer_id,
      customerName: x.customer_name,
      serviceId: x.service_id ?? null,
      serviceName: x.service_name ?? null,
      aDeviceId: x.a_device_id ?? null,
      aDeviceName: x.a_device_name ?? null,
      aInterfaceId: x.a_interface_id ?? null,
      aInterfaceName: x.a_interface_name ?? null,
      aLabel: x.a_label,
      zLabel: x.z_label,
      loaReference: x.loa_reference ?? null,
      media: x.media,
      speed: x.speed ?? null,
      status: x.status,
      circuitId: x.circuit_id ?? null,
      cableId: staff(p) ? (x.cable_id ?? null) : null,
      cableLabel: staff(p) ? (x.cable_label ?? null) : null,
      statusReason: x.status_reason ?? null,
      notes: staff(p) ? (x.notes ?? null) : null,
      requestedBy: ColocationService.who(p, x.requested_by, x.requester_type),
      requestedAt: x.requested_at,
      completedAt: x.completed_at ?? null,
      decommissionedAt: x.decommissioned_at ?? null,
    }));
  }

  async createCrossConnect(p: Principal, input: CrossConnectInput, meta: RequestMeta) {
    assertCanRequest(p);
    const customerId = (await customerFor(this.db, p, input.customerId))!;
    if (input.aDeviceId) {
      const [d] = await this.db.select({ customerId: devices.customerId }).from(devices).where(and(eq(devices.id, input.aDeviceId), eq(devices.orgId, p.orgId)));
      if (!d || d.customerId !== customerId) throw new BadRequestException({ error: 'invalid_device', message: 'The A-side device is not this customer’s' });
    }
    if (input.aInterfaceId) {
      if (!input.aDeviceId) throw new BadRequestException({ error: 'invalid_interface', message: 'Choose the device of the port' });
      const [i] = await this.db.select({ deviceId: interfaces.deviceId }).from(interfaces).where(eq(interfaces.id, input.aInterfaceId));
      if (!i || i.deviceId !== input.aDeviceId) throw new BadRequestException({ error: 'invalid_interface', message: 'The port is not on that device' });
    }
    if (input.serviceId) await this.serviceOf(customerId, p, input.serviceId);
    try {
      return await this.db.transaction(async (tx) => {
        const [x] = await tx
          .insert(crossConnects)
          .values({
            orgId: p.orgId,
            customerId,
            serviceId: input.serviceId ?? null,
            aDeviceId: input.aDeviceId ?? null,
            aInterfaceId: input.aInterfaceId ?? null,
            aLabel: input.aLabel,
            zLabel: input.zLabel,
            loaReference: input.loaReference ?? null,
            media: input.media,
            speed: input.speed ?? null,
            notes: staff(p) ? (input.notes ?? null) : null,
            requestedBy: p.email,
          })
          .returning();
        await this.record(p, meta, 'colo.cross_connect_request', { type: 'cross_connect', id: x!.id }, customerId, { aLabel: input.aLabel, zLabel: input.zLabel, media: input.media }, tx);
        await emitEvent(tx, { orgId: p.orgId, type: 'cross_connect.requested', customerId, subject: { type: 'cross_connect', id: x!.id }, payload: { crossConnectId: x!.id, aLabel: input.aLabel, zLabel: input.zLabel, media: input.media, speed: input.speed ?? null, by: p.userType } });
        return x!;
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  private async serviceOf(customerId: string, p: Principal, serviceId: string) {
    const [s] = await this.db.select({ customerId: services.customerId }).from(services).where(and(eq(services.id, serviceId), eq(services.orgId, p.orgId)));
    if (!s || s.customerId !== customerId) throw new BadRequestException({ error: 'invalid_service', message: 'The service does not belong to this customer' });
  }

  /**
   * Staff move a cross-connect through its lifecycle. A customer may only
   * withdraw its own request before work starts (recorded as rejected).
   */
  async crossConnectStatus(p: Principal, id: string, input: z.infer<typeof crossConnectStatusSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [x] = await tx.select().from(crossConnects).where(and(eq(crossConnects.id, id), eq(crossConnects.orgId, p.orgId))).for('update');
      visibleTo(p, x, 'Cross-connect');
      const from = x!.status as CrossConnectStatus;
      if (staff(p)) assertStaffWrite(p);
      else {
        assertCanRequest(p);
        if (!(input.status === 'rejected' && (from === 'requested' || from === 'approved'))) throw new BadRequestException({ error: 'invalid_transition', message: 'You can withdraw a request until installation starts; other changes are made by the datacenter team' });
      }
      transitionAllowed(CROSS_CONNECT_TRANSITIONS, from, input.status, 'A cross-connect');
      if (input.status === 'active' && !input.circuitId && !x!.circuitId) throw new BadRequestException({ error: 'circuit_required', message: 'Give the cross-connect id when it goes live' });
      if (input.cableId) {
        const [c] = await tx.select({ id: cables.id }).from(cables).where(and(eq(cables.id, input.cableId), eq(cables.orgId, p.orgId)));
        if (!c) throw new BadRequestException({ error: 'invalid_cable', message: 'Cable not found' });
      }
      const now = new Date();
      const [u] = await tx
        .update(crossConnects)
        .set({
          status: input.status,
          circuitId: staff(p) ? (input.circuitId ?? x!.circuitId) : x!.circuitId,
          cableId: staff(p) && input.cableId !== undefined ? input.cableId : x!.cableId,
          statusReason: input.reason ?? (staff(p) ? null : 'Withdrawn by the customer'),
          completedAt: input.status === 'active' ? now : x!.completedAt,
          decommissionedAt: input.status === 'decommissioned' ? now : x!.decommissionedAt,
        })
        .where(eq(crossConnects.id, id))
        .returning();
      await this.record(p, meta, 'colo.cross_connect_status', { type: 'cross_connect', id }, x!.customerId, { from, to: input.status, circuitId: u!.circuitId, reason: input.reason ?? null }, tx);
      await emitEvent(tx, { orgId: p.orgId, type: 'cross_connect.status_changed', customerId: x!.customerId, subject: { type: 'cross_connect', id }, payload: { crossConnectId: id, from, to: input.status, circuitId: u!.circuitId, aLabel: x!.aLabel, zLabel: x!.zLabel, by: p.userType } });
      return u!;
    });
  }

  /* ================================================================ shipments */

  async shipments(p: Principal, q: Partial<ListQuery> & { id?: string } = {}) {
    const conds: SQL[] = [this.scope(p, 's')];
    if (q.id) conds.push(sql`s.id = ${q.id}`);
    if (q.customerId && staff(p)) conds.push(sql`s.customer_id = ${q.customerId}`);
    if (q.datacenterId) conds.push(sql`s.datacenter_id = ${q.datacenterId}`);
    if (q.status === 'open') conds.push(sql`s.status in ('expected','received')`);
    else if (q.status) conds.push(sql`s.status::text = ${q.status}`);
    const r = await this.db.execute<Record<string, unknown>>(sql`
      select s.*, c.name as customer_name, dc.code as datacenter_code,
             (select u.user_type::text from users u where u.org_id = s.org_id and lower(u.email) = lower(s.created_by) limit 1) as requester_type
        from shipments s join customers c on c.id = s.customer_id join datacenters dc on dc.id = s.datacenter_id
       where ${sql.join(conds, sql` and `)} order by (s.status in ('expected','received')) desc, coalesce(s.expected_on, s.created_at::date) desc limit 500`);
    return r.rows.map((s) => ({
      id: s.id,
      customerId: s.customer_id,
      customerName: s.customer_name,
      datacenterId: s.datacenter_id,
      datacenterCode: s.datacenter_code,
      direction: s.direction,
      carrier: s.carrier,
      trackingNumber: s.tracking_number ?? null,
      expectedOn: s.expected_on ?? null,
      packages: s.packages,
      description: s.description,
      instructions: s.instructions ?? null,
      status: s.status,
      packagesReceived: s.packages_received ?? null,
      storageLocation: s.storage_location ?? null,
      conditionNote: s.condition_note ?? null,
      receivedAt: s.received_at ?? null,
      receivedBy: s.received_by ? (staff(p) ? s.received_by : 'Datacenter team') : null,
      closedAt: s.closed_at ?? null,
      createdBy: ColocationService.who(p, s.created_by, s.requester_type),
      createdAt: s.created_at,
    }));
  }

  private async datacenter(p: Principal, id: string) {
    const [d] = await this.db.select({ id: datacenters.id }).from(datacenters).where(and(eq(datacenters.id, id), eq(datacenters.orgId, p.orgId)));
    if (!d) throw new BadRequestException({ error: 'invalid_datacenter', message: 'Datacenter not found' });
  }

  async createShipment(p: Principal, input: ShipmentInput, meta: RequestMeta) {
    assertCanRequest(p);
    const customerId = (await customerFor(this.db, p, input.customerId))!;
    await this.datacenter(p, input.datacenterId);
    return this.db.transaction(async (tx) => {
      const [s] = await tx
        .insert(shipments)
        .values({ orgId: p.orgId, customerId, datacenterId: input.datacenterId, direction: input.direction, carrier: input.carrier, trackingNumber: input.trackingNumber ?? null, expectedOn: input.expectedOn ?? null, packages: input.packages, description: input.description, instructions: input.instructions ?? null, createdBy: p.email })
        .returning();
      await this.record(p, meta, 'colo.shipment_create', { type: 'shipment', id: s!.id }, customerId, { carrier: input.carrier, trackingNumber: input.trackingNumber ?? null, direction: input.direction }, tx);
      await emitEvent(tx, { orgId: p.orgId, type: 'shipment.created', customerId, subject: { type: 'shipment', id: s!.id }, payload: { shipmentId: s!.id, direction: input.direction, carrier: input.carrier, trackingNumber: input.trackingNumber ?? null, expectedOn: input.expectedOn ?? null, packages: input.packages } });
      return s!;
    });
  }

  async shipmentStatus(p: Principal, id: string, input: z.infer<typeof shipmentStatusSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(shipments).where(and(eq(shipments.id, id), eq(shipments.orgId, p.orgId))).for('update');
      visibleTo(p, s, 'Shipment');
      const from = s!.status as ShipmentStatus;
      if (staff(p)) assertStaffWrite(p);
      else {
        assertCanRequest(p);
        if (!(input.status === 'cancelled' && from === 'expected')) throw new BadRequestException({ error: 'invalid_transition', message: 'You can cancel a shipment until it arrives; the datacenter team records everything else' });
      }
      transitionAllowed(SHIPMENT_TRANSITIONS, from, input.status, 'A shipment');
      const now = new Date();
      const [u] = await tx
        .update(shipments)
        .set({
          status: input.status,
          storageLocation: staff(p) ? (input.storageLocation ?? s!.storageLocation) : s!.storageLocation,
          packagesReceived: staff(p) && input.packagesReceived != null ? input.packagesReceived : s!.packagesReceived,
          conditionNote: staff(p) ? (input.conditionNote ?? s!.conditionNote) : s!.conditionNote,
          receivedAt: input.status === 'received' ? now : s!.receivedAt,
          receivedBy: input.status === 'received' ? p.email : s!.receivedBy,
          closedAt: ['delivered', 'shipped_out', 'cancelled'].includes(input.status) ? now : s!.closedAt,
        })
        .where(eq(shipments.id, id))
        .returning();
      await this.record(p, meta, 'colo.shipment_status', { type: 'shipment', id }, s!.customerId, { from, to: input.status, storageLocation: u!.storageLocation, packagesReceived: u!.packagesReceived }, tx);
      await emitEvent(tx, { orgId: p.orgId, type: 'shipment.status_changed', customerId: s!.customerId, subject: { type: 'shipment', id }, payload: { shipmentId: id, from, to: input.status, carrier: s!.carrier, trackingNumber: s!.trackingNumber, packages: s!.packages, packagesReceived: u!.packagesReceived } });
      return u!;
    });
  }

  /* ================================================================ visits */

  async visits(p: Principal, q: Partial<ListQuery> & { id?: string } = {}) {
    const conds: SQL[] = [this.scope(p, 'v')];
    if (q.id) conds.push(sql`v.id = ${q.id}`);
    if (q.customerId && staff(p)) conds.push(sql`v.customer_id = ${q.customerId}`);
    if (q.datacenterId) conds.push(sql`v.datacenter_id = ${q.datacenterId}`);
    if (q.status === 'open') conds.push(sql`v.status in ('requested','approved','checked_in')`);
    else if (q.status) conds.push(sql`v.status::text = ${q.status}`);
    const r = await this.db.execute<Record<string, unknown>>(sql`
      select v.*, c.name as customer_name, dc.code as datacenter_code,
             (select u.user_type::text from users u where u.org_id = v.org_id and lower(u.email) = lower(v.requested_by) limit 1) as requester_type
        from visits v join customers c on c.id = v.customer_id join datacenters dc on dc.id = v.datacenter_id
       where ${sql.join(conds, sql` and `)} order by (v.status in ('requested','approved','checked_in')) desc, v.starts_at desc limit 500`);
    return r.rows.map((v) => ({
      id: v.id,
      customerId: v.customer_id,
      customerName: v.customer_name,
      datacenterId: v.datacenter_id,
      datacenterCode: v.datacenter_code,
      visitors: v.visitors,
      startsAt: v.starts_at,
      endsAt: v.ends_at,
      purpose: v.purpose,
      status: v.status,
      escort: v.escort,
      badge: v.badge ?? null,
      decisionNote: v.decision_note ?? null,
      decidedBy: staff(p) ? (v.decided_by ?? null) : null,
      checkedInAt: v.checked_in_at ?? null,
      checkedOutAt: v.checked_out_at ?? null,
      requestedBy: ColocationService.who(p, v.requested_by, v.requester_type),
      createdAt: v.created_at,
    }));
  }

  async createVisit(p: Principal, input: VisitInput, meta: RequestMeta) {
    assertCanRequest(p);
    const customerId = (await customerFor(this.db, p, input.customerId))!;
    await this.datacenter(p, input.datacenterId);
    if (Date.parse(input.startsAt) < Date.now() - 3600_000 && !staff(p)) throw new BadRequestException({ error: 'invalid_time', message: 'The visit would start in the past' });
    if (Date.parse(input.endsAt) < Date.now()) throw new BadRequestException({ error: 'invalid_time', message: 'The visit is already over' });
    if (Date.parse(input.startsAt) > Date.now() + 180 * 86_400_000) throw new BadRequestException({ error: 'invalid_time', message: 'Visits can be requested up to 180 days ahead' });
    try {
      return await this.db.transaction(async (tx) => {
        const [v] = await tx
          .insert(visits)
          .values({
            orgId: p.orgId,
            customerId,
            datacenterId: input.datacenterId,
            visitors: input.visitors.map((x) => ({ name: x.name, company: x.company ?? null, idLast4: x.idLast4 ?? null })),
            startsAt: new Date(input.startsAt),
            endsAt: new Date(input.endsAt),
            purpose: input.purpose,
            requestedBy: p.email,
          })
          .returning();
        // Names are personal data: the audit trail keeps the count, not the names.
        await this.record(p, meta, 'colo.visit_request', { type: 'visit', id: v!.id }, customerId, { visitors: input.visitors.length, startsAt: input.startsAt, endsAt: input.endsAt }, tx);
        // No visitor names in events (they leave the system through webhooks).
        await emitEvent(tx, { orgId: p.orgId, type: 'visit.requested', customerId, subject: { type: 'visit', id: v!.id }, payload: { visitId: v!.id, datacenterId: input.datacenterId, visitors: input.visitors.length, startsAt: input.startsAt, endsAt: input.endsAt } });
        return v!;
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  async visitStatus(p: Principal, id: string, input: z.infer<typeof visitStatusSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [v] = await tx.select().from(visits).where(and(eq(visits.id, id), eq(visits.orgId, p.orgId))).for('update');
      visibleTo(p, v, 'Visit');
      const from = v!.status as VisitStatus;
      if (staff(p)) assertStaffWrite(p);
      else {
        assertCanRequest(p);
        if (input.status !== 'cancelled') throw new BadRequestException({ error: 'invalid_transition', message: 'You can cancel a visit; approvals and check-in are done by the datacenter team' });
      }
      transitionAllowed(VISIT_TRANSITIONS, from, input.status, 'A visit');
      const now = new Date();
      // Check-in only around the approved window (from 2 hours before it starts until it ends).
      if (input.status === 'checked_in' && (now.getTime() < v!.startsAt.getTime() - 2 * 3600_000 || now > v!.endsAt)) throw new BadRequestException({ error: 'outside_window', message: 'The visit is not approved for this time' });
      const [u] = await tx
        .update(visits)
        .set({
          status: input.status,
          escort: staff(p) && input.escort !== undefined ? input.escort : v!.escort,
          badge: staff(p) ? (input.badge ?? v!.badge) : v!.badge,
          // The team's note to the customer; a customer's cancellation reason goes to the audit log only.
          decisionNote: staff(p) ? (input.note ?? v!.decisionNote) : v!.decisionNote,
          decidedBy: input.status === 'approved' || input.status === 'denied' ? p.email : v!.decidedBy,
          checkedInAt: input.status === 'checked_in' ? now : v!.checkedInAt,
          checkedOutAt: input.status === 'checked_out' ? now : v!.checkedOutAt,
        })
        .where(eq(visits.id, id))
        .returning();
      await this.record(p, meta, 'colo.visit_status', { type: 'visit', id }, v!.customerId, { from, to: input.status, note: input.note ?? null }, tx);
      await emitEvent(tx, { orgId: p.orgId, type: 'visit.status_changed', customerId: v!.customerId, subject: { type: 'visit', id }, payload: { visitId: id, datacenterId: v!.datacenterId, from, to: input.status, visitors: v!.visitors.length, startsAt: v!.startsAt.toISOString() } });
      return u!;
    });
  }

  /** Sites a request can be for (code and name only; customers need them to announce shipments and visits). */
  async sites(p: Principal) {
    return this.db.select({ id: datacenters.id, code: datacenters.code, name: datacenters.name }).from(datacenters).where(eq(datacenters.orgId, p.orgId)).orderBy(datacenters.code);
  }

  /* ================================================================ overview */

  /** Customer portal home (and the staff summary): space, contracted vs used power, bandwidth, open requests. */
  async overview(p: Principal) {
    const allocs = await this.allocations(p, { active: true });
    const sum = (k: 'measuredW' | 'estimatedW' | 'unknownDevices') => allocs.reduce((a, x) => a + (x.power?.[k] ?? 0), 0);
    const counts = await this.db.execute<{ k: string; n: number }>(sql`
      select 'cross_connects' as k, count(*)::int as n from cross_connects x where ${this.scope(p, 'x')} and x.status in ('requested','approved','in_progress')
      union all select 'cross_connects_active', count(*)::int from cross_connects x where ${this.scope(p, 'x')} and x.status = 'active'
      union all select 'shipments', count(*)::int from shipments s where ${this.scope(p, 's')} and s.status in ('expected','received')
      union all select 'visits', count(*)::int from visits v where ${this.scope(p, 'v')} and v.status in ('requested','approved','checked_in') and v.ends_at > now()
      union all select 'tickets', count(*)::int from tickets t where ${staff(p) ? sql`t.org_id = ${p.orgId}` : sql`t.org_id = ${p.orgId} and t.customer_id = ${p.customerId}`} and t.status in ('open','in_progress','waiting_customer')
      union all select 'services', count(*)::int from services sv where ${this.scope(p, 'sv')} and sv.status = 'active'`);
    const c = Object.fromEntries(counts.rows.map((x) => [x.k, x.n]));
    const bandwidth = await this.monitoring.totals(p).catch(() => null);
    return {
      allocations: allocs.length,
      units: allocs.reduce((a, x) => a + (x.units as number), 0),
      contractedPowerW: allocs.reduce((a, x) => a + (x.contractedPowerW as number), 0),
      measuredW: sum('measuredW'),
      estimatedW: sum('estimatedW'),
      unknownDevices: sum('unknownDevices'),
      overContract: allocs.filter((x) => x.power?.overContract).map((x) => ({ id: x.id, customerName: x.customerName, rackName: x.rackName, datacenterCode: x.datacenterCode })),
      mayExceed: allocs.filter((x) => x.power?.mayExceed).map((x) => ({ id: x.id, customerName: x.customerName, rackName: x.rackName, datacenterCode: x.datacenterCode })),
      bandwidth: bandwidth ? { inBps: bandwidth.inBps, outBps: bandwidth.outBps, ports: bandwidth.ports, freshPorts: bandwidth.freshPorts } : null,
      open: { crossConnects: c.cross_connects ?? 0, shipments: c.shipments ?? 0, visits: c.visits ?? 0, tickets: c.tickets ?? 0 },
      activeCrossConnects: c.cross_connects_active ?? 0,
      activeServices: c.services ?? 0,
    };
  }
}
