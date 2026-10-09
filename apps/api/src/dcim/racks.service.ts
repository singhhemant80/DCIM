import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { rackMoveSchema, rackSchema, reservationSchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { buildings, customers, datacenters, deviceModels, devices, manufacturers, rackEvents, rackReservations, rackRows, racks, rooms, type Rack } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';

type RackInput = z.infer<typeof rackSchema>;
type MoveInput = z.infer<typeof rackMoveSchema>;
type ReservationInput = z.infer<typeof reservationSchema>;

/** Distinct rack units occupied on either face (a front and a rear half-depth device at the same U count once). */
export const usedUnitsSql = (rackIdCol: SQL) =>
  sql<number>`(select count(distinct u)::int from devices d, generate_series(lower(d.u_range), upper(d.u_range) - 1) as u where d.rack_id = ${rackIdCol} and d.u_range is not null)`;
const reservedUnitsSql = (rackIdCol: SQL) =>
  sql<number>`(select coalesce(sum(r.end_u - r.start_u + 1), 0)::int from rack_reservations r where r.rack_id = ${rackIdCol} and (r.expires_at is null or r.expires_at > now()))`;

@Injectable()
export class RacksService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(p: Principal, q: { datacenterId?: string; roomId?: string; q?: string; id?: string }) {
    const conds: SQL[] = [eq(racks.orgId, p.orgId)];
    if (q.id) conds.push(eq(racks.id, q.id));
    if (q.roomId) conds.push(eq(racks.roomId, q.roomId));
    if (q.datacenterId) conds.push(eq(buildings.datacenterId, q.datacenterId));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      conds.push(or(ilike(racks.name, like), ilike(rooms.name, like), ilike(datacenters.code, like))!);
    }
    const rows = await this.db
      .select({
        rack: racks,
        roomName: rooms.name,
        buildingName: buildings.name,
        datacenterId: datacenters.id,
        datacenterCode: datacenters.code,
        rowName: rackRows.name,
        customerName: customers.name,
        usedU: usedUnitsSql(sql.raw('"racks"."id"')),
        reservedU: reservedUnitsSql(sql.raw('"racks"."id"')),
        deviceCount: sql<number>`(select count(*)::int from devices d where d.rack_id = "racks"."id")`,
      })
      .from(racks)
      .innerJoin(rooms, eq(rooms.id, racks.roomId))
      .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
      .innerJoin(datacenters, eq(datacenters.id, buildings.datacenterId))
      .leftJoin(rackRows, eq(rackRows.id, racks.rowId))
      .leftJoin(customers, eq(customers.id, racks.customerId))
      .where(and(...conds))
      .orderBy(asc(datacenters.code), asc(rooms.name), asc(rackRows.position), asc(racks.name));
    return rows.map((r) => ({
      ...r.rack,
      location: { datacenterId: r.datacenterId, datacenterCode: r.datacenterCode, buildingName: r.buildingName, roomName: r.roomName, rowName: r.rowName },
      customerName: r.customerName,
      usedU: r.usedU,
      reservedU: r.reservedU,
      freeU: Math.max(0, r.rack.uHeight - r.usedU),
      deviceCount: r.deviceCount,
    }));
  }

  async get(p: Principal, id: string): Promise<Rack> {
    const [r] = await this.db.select().from(racks).where(and(eq(racks.id, id), eq(racks.orgId, p.orgId)));
    if (!r) throw new NotFoundException({ error: 'not_found', message: 'Rack not found' });
    return r;
  }

  /** Everything needed to draw the front and rear elevation. */
  async elevation(p: Principal, id: string) {
    const [rack] = await this.list(p, { id });
    if (!rack) throw new NotFoundException({ error: 'not_found', message: 'Rack not found' });
    const [placed, reservations] = await Promise.all([
      this.db
        .select({
          id: devices.id,
          assetTag: devices.assetTag,
          hostname: devices.hostname,
          category: devices.category,
          lifecycleState: devices.lifecycleState,
          positionU: devices.positionU,
          uHeight: devices.uHeight,
          face: devices.face,
          fullDepth: devices.fullDepth,
          ownership: devices.ownership,
          customerId: devices.customerId,
          customerName: customers.name,
          modelName: deviceModels.name,
          manufacturerName: manufacturers.name,
        })
        .from(devices)
        .innerJoin(deviceModels, eq(deviceModels.id, devices.modelId))
        .innerJoin(manufacturers, eq(manufacturers.id, deviceModels.manufacturerId))
        .leftJoin(customers, eq(customers.id, devices.customerId))
        .where(eq(devices.rackId, id))
        .orderBy(desc(devices.positionU)),
      this.db
        .select({ r: rackReservations, customerName: customers.name })
        .from(rackReservations)
        .leftJoin(customers, eq(customers.id, rackReservations.customerId))
        .where(eq(rackReservations.rackId, id))
        .orderBy(asc(rackReservations.startU)),
    ]);
    const now = Date.now();
    return {
      rack,
      devices: placed.filter((d) => d.positionU !== null),
      zeroU: placed.filter((d) => d.positionU === null),
      reservations: reservations.map(({ r, customerName }) => ({
        id: r.id,
        startU: r.startU,
        endU: r.endU,
        customerId: r.customerId,
        customerName,
        reason: r.reason,
        expiresAt: r.expiresAt,
        expired: !!r.expiresAt && r.expiresAt.getTime() <= now,
      })),
    };
  }

  async create(p: Principal, input: RackInput, meta: RequestMeta) {
    await this.checkRefs(p, input);
    try {
      return await this.db.transaction(async (tx) => {
        const [r] = await tx.insert(racks).values({ ...input, orgId: p.orgId }).returning();
        await this.event(tx, p, r!.id, 'created', `Rack ${r!.name} created`);
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'rack.create', target: { type: 'rack', id: r!.id }, outcome: 'success', meta, metadata: { name: r!.name, uHeight: r!.uHeight } }, tx);
        return r!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async update(p: Principal, id: string, input: RackInput, meta: RequestMeta) {
    const before = await this.get(p, id);
    if (input.roomId !== before.roomId) {
      throw new BadRequestException({ error: 'use_move', message: 'Use “Move rack” to relocate a rack to another room' });
    }
    await this.checkRefs(p, input);
    try {
      return await this.db.transaction(async (tx) => {
        // Lock the rack so placements and reservations can't change underneath these checks.
        await tx.select({ id: racks.id }).from(racks).where(eq(racks.id, id)).for('update');
        const newCustomer = input.customerId ?? null;
        if (newCustomer && newCustomer !== before.customerId) {
          const [{ n } = { n: 0 }] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(devices)
            .where(and(eq(devices.rackId, id), sql`${devices.customerId} is distinct from ${newCustomer}`));
          if (n > 0) throw new ConflictException({ error: 'rack_in_use', message: `${n} device(s) in this rack belong to someone else; move them before dedicating the rack` });
          const [{ r: res } = { r: 0 }] = await tx
            .select({ r: sql<number>`count(*)::int` })
            .from(rackReservations)
            .where(and(eq(rackReservations.rackId, id), sql`${rackReservations.customerId} is distinct from ${newCustomer}`, sql`(${rackReservations.expiresAt} is null or ${rackReservations.expiresAt} > now())`));
          if (res > 0) throw new ConflictException({ error: 'rack_in_use', message: 'This rack has reservations for someone else; release them first' });
        }
        if (input.status === 'decommissioned' && before.status !== 'decommissioned') {
          const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(devices).where(eq(devices.rackId, id));
          if (n > 0) throw new ConflictException({ error: 'rack_in_use', message: `Rack still holds ${n} device(s); move them out before decommissioning it` });
        }
        const [r] = await tx.update(racks).set(input).where(eq(racks.id, id)).returning();
        const changed = diff(before, r!, ['name', 'uHeight', 'depthMm', 'status', 'customerId', 'rowId', 'gridX', 'gridY', 'maxPowerW']);
        if (Object.keys(changed).length) await this.event(tx, p, id, 'updated', `Changed ${Object.keys(changed).join(', ')}`, changed);
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'rack.update', target: { type: 'rack', id }, outcome: 'success', meta, metadata: { changes: changed } }, tx);
        return r!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async remove(p: Principal, id: string, meta: RequestMeta) {
    const r = await this.get(p, id);
    const [{ n } = { n: 0 }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(devices).where(eq(devices.rackId, id));
    if (n > 0) throw new ConflictException({ error: 'rack_not_empty', message: `Rack still holds ${n} device(s); move them out first` });
    await this.db.transaction(async (tx) => {
      await tx.delete(racks).where(eq(racks.id, id));
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'rack.delete', target: { type: 'rack', id }, outcome: 'success', meta, metadata: { name: r.name } }, tx);
    });
  }

  /** Relocates a whole rack (with its equipment) to another room, row or floor position. */
  async move(p: Principal, id: string, input: MoveInput, meta: RequestMeta) {
    const before = await this.get(p, id);
    await this.checkRefs(p, { roomId: input.roomId, rowId: input.rowId ?? null, customerId: null, gridX: input.gridX ?? null, gridY: input.gridY ?? null });
    const from = await this.locationLabel(before.roomId, before.rowId, before.gridX, before.gridY);
    try {
      return await this.db.transaction(async (tx) => {
        const [r] = await tx
          .update(racks)
          .set({ roomId: input.roomId, rowId: input.rowId ?? null, gridX: input.gridX ?? null, gridY: input.gridY ?? null })
          .where(eq(racks.id, id))
          .returning();
        const to = await this.locationLabel(r!.roomId, r!.rowId, r!.gridX, r!.gridY, tx);
        await this.event(tx, p, id, 'moved', `Moved from ${from} to ${to}${input.reason ? ` (${input.reason})` : ''}`, { from, to });
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'rack.move', target: { type: 'rack', id }, outcome: 'success', meta, metadata: { from, to, reason: input.reason ?? null } }, tx);
        return r!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async events(p: Principal, id: string) {
    await this.get(p, id);
    return this.db.select().from(rackEvents).where(eq(rackEvents.rackId, id)).orderBy(desc(rackEvents.id)).limit(200);
  }

  async addReservation(p: Principal, rackId: string, input: ReservationInput, meta: RequestMeta) {
    await this.get(p, rackId);
    if (input.customerId) await this.checkCustomer(p, input.customerId);
    try {
      return await this.db.transaction(async (tx) => {
        // Lock the rack: placements lock it too, so the check below can't race a placement.
        const [rack] = await tx.select({ customerId: racks.customerId }).from(racks).where(eq(racks.id, rackId)).for('update');
        if (rack?.customerId && input.customerId !== rack.customerId) {
          throw new ConflictException({ error: 'rack_dedicated', message: 'This rack is dedicated to another customer' });
        }
        // Units already holding equipment cannot be reserved for someone else.
        const [{ n } = { n: 0 }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(devices)
          .where(
            and(
              eq(devices.rackId, rackId),
              sql`${devices.uRange} && int4range(${input.startU}, ${input.endU + 1})`,
              input.customerId ? sql`${devices.customerId} is distinct from ${input.customerId}` : sql`${devices.customerId} is not null`,
            ),
          );
        if (n > 0) throw new ConflictException({ error: 'reservation_conflict', message: 'Some of those units hold equipment that belongs to someone else' });
        const [r] = await tx
          .insert(rackReservations)
          .values({ orgId: p.orgId, rackId, startU: input.startU, endU: input.endU, customerId: input.customerId ?? null, reason: input.reason, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: p.userId })
          .returning();
        await this.event(tx, p, rackId, 'reservation', `Reserved U${input.startU}–U${input.endU}: ${input.reason}`);
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: input.customerId ?? null, action: 'rack.reservation.create', target: { type: 'rack', id: rackId }, outcome: 'success', meta, metadata: { startU: input.startU, endU: input.endU } }, tx);
        return r!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async removeReservation(p: Principal, rackId: string, reservationId: string, meta: RequestMeta) {
    await this.get(p, rackId);
    await this.db.transaction(async (tx) => {
      const [r] = await tx.delete(rackReservations).where(and(eq(rackReservations.id, reservationId), eq(rackReservations.rackId, rackId))).returning();
      if (!r) throw new NotFoundException({ error: 'not_found', message: 'Reservation not found' });
      await this.event(tx, p, rackId, 'reservation', `Released reservation U${r.startU}–U${r.endU}`);
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'rack.reservation.delete', target: { type: 'rack', id: rackId }, outcome: 'success', meta, metadata: { startU: r.startU, endU: r.endU } }, tx);
    });
  }

  // ---------------------------------------------------------------------------

  async event(tx: DbOrTx, p: Principal, rackId: string, kind: string, summary: string, data: Record<string, unknown> = {}) {
    await tx.insert(rackEvents).values({ orgId: p.orgId, rackId, kind, summary, data, actorId: p.userId, actorLabel: p.email });
  }

  private async checkRefs(p: Principal, input: { roomId: string; rowId?: string | null; customerId?: string | null; gridX?: number | null; gridY?: number | null }) {
    const [room] = await this.db.select().from(rooms).where(and(eq(rooms.id, input.roomId), eq(rooms.orgId, p.orgId)));
    if (!room) throw new BadRequestException({ error: 'invalid_room', message: 'Room does not exist' });
    if (input.rowId) {
      const [row] = await this.db.select().from(rackRows).where(and(eq(rackRows.id, input.rowId), eq(rackRows.roomId, input.roomId)));
      if (!row) throw new BadRequestException({ error: 'invalid_row', message: 'That row is not in the selected room' });
    }
    if (input.gridX != null && input.gridY != null && (input.gridX >= room.gridCols || input.gridY >= room.gridRows)) {
      throw new BadRequestException({ error: 'invalid_position', message: `Floor position is outside the room (${room.gridCols} × ${room.gridRows})` });
    }
    if (input.customerId) await this.checkCustomer(p, input.customerId);
  }

  private async checkCustomer(p: Principal, customerId: string) {
    const [c] = await this.db.select({ id: customers.id }).from(customers).where(and(eq(customers.id, customerId), eq(customers.orgId, p.orgId)));
    if (!c) throw new BadRequestException({ error: 'invalid_customer', message: 'Customer does not exist' });
  }

  private async locationLabel(roomId: string, rowId: string | null, x: number | null, y: number | null, tx: DbOrTx = this.db) {
    const [loc] = await tx
      .select({ dc: datacenters.code, building: buildings.name, room: rooms.name })
      .from(rooms)
      .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
      .innerJoin(datacenters, eq(datacenters.id, buildings.datacenterId))
      .where(eq(rooms.id, roomId));
    const row = rowId ? (await tx.select({ name: rackRows.name }).from(rackRows).where(eq(rackRows.id, rowId)))[0]?.name : null;
    return [loc?.dc, loc?.building, loc?.room, row ? `row ${row}` : null, x != null ? `(${x},${y})` : null].filter(Boolean).join(' / ');
  }
}

function diff<T extends Record<string, unknown>>(a: T, b: T, keys: (keyof T)[]): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) if (a[k] !== b[k]) out[k as string] = { from: a[k], to: b[k] };
  return out;
}
