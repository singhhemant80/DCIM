import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { buildingSchema, datacenterSchema, roomSchema, rowSchema } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { buildings, datacenters, devices, rackRows, racks, rooms } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';

type DcInput = z.infer<typeof datacenterSchema>;
type BuildingInput = z.infer<typeof buildingSchema>;
type RoomInput = z.infer<typeof roomSchema>;
type RowInput = z.infer<typeof rowSchema>;

const notFound = (what: string) => new NotFoundException({ error: 'not_found', message: `${what} not found` });

/**
 * Datacenters, buildings, rooms and rows. Staff-only (customers never see the
 * physical layout). Deletes are refused while anything still references the
 * record (FK RESTRICT), so the hierarchy can't be orphaned.
 */
@Injectable()
export class SitesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** The whole hierarchy with rack and device counts, for tree views and pickers. */
  async tree(p: Principal) {
    const [dcs, bs, rs, rows, rackCounts] = await Promise.all([
      this.db.select().from(datacenters).where(eq(datacenters.orgId, p.orgId)).orderBy(asc(datacenters.code)),
      this.db.select().from(buildings).where(eq(buildings.orgId, p.orgId)).orderBy(asc(buildings.name)),
      this.db.select().from(rooms).where(eq(rooms.orgId, p.orgId)).orderBy(asc(rooms.name)),
      this.db.select().from(rackRows).where(eq(rackRows.orgId, p.orgId)).orderBy(asc(rackRows.position), asc(rackRows.name)),
      this.db
        .select({ roomId: racks.roomId, racks: sql<number>`count(*)::int` })
        .from(racks)
        .where(eq(racks.orgId, p.orgId))
        .groupBy(racks.roomId),
    ]);
    const countByRoom = new Map(rackCounts.map((r) => [r.roomId, r.racks]));
    return dcs.map((dc) => ({
      ...dc,
      buildings: bs
        .filter((b) => b.datacenterId === dc.id)
        .map((b) => ({
          ...b,
          rooms: rs
            .filter((r) => r.buildingId === b.id)
            .map((r) => ({ ...r, rackCount: countByRoom.get(r.id) ?? 0, rows: rows.filter((row) => row.roomId === r.id) })),
        })),
    }));
  }

  async listDatacenters(p: Principal) {
    const rows = await this.db
      .select({
        dc: datacenters,
        buildings: sql<number>`(select count(*)::int from buildings b where b.datacenter_id = "datacenters"."id")`,
        rooms: sql<number>`(select count(*)::int from rooms r join buildings b on b.id = r.building_id where b.datacenter_id = "datacenters"."id")`,
        racks: sql<number>`(select count(*)::int from racks k join rooms r on r.id = k.room_id join buildings b on b.id = r.building_id where b.datacenter_id = "datacenters"."id")`,
        devices: sql<number>`(select count(*)::int from devices d join racks k on k.id = d.rack_id join rooms r on r.id = k.room_id join buildings b on b.id = r.building_id where b.datacenter_id = "datacenters"."id")`,
      })
      .from(datacenters)
      .where(eq(datacenters.orgId, p.orgId))
      .orderBy(asc(datacenters.code));
    return rows.map((r) => ({ ...r.dc, counts: { buildings: r.buildings, rooms: r.rooms, racks: r.racks, devices: r.devices } }));
  }

  async getDatacenter(p: Principal, id: string) {
    const [dc] = await this.db.select().from(datacenters).where(and(eq(datacenters.id, id), eq(datacenters.orgId, p.orgId)));
    if (!dc) throw notFound('Datacenter');
    return dc;
  }

  async createDatacenter(p: Principal, input: DcInput, meta: RequestMeta) {
    return this.write(p, meta, 'datacenter.create', 'datacenter', async (tx) => {
      const [dc] = await tx.insert(datacenters).values({ ...input, orgId: p.orgId }).returning();
      return dc!;
    });
  }

  async updateDatacenter(p: Principal, id: string, input: DcInput, meta: RequestMeta) {
    await this.getDatacenter(p, id);
    return this.write(p, meta, 'datacenter.update', 'datacenter', async (tx) => {
      const [dc] = await tx.update(datacenters).set(input).where(and(eq(datacenters.id, id), eq(datacenters.orgId, p.orgId))).returning();
      return dc!;
    });
  }

  async deleteDatacenter(p: Principal, id: string, meta: RequestMeta) {
    const dc = await this.getDatacenter(p, id);
    await this.write(p, meta, 'datacenter.delete', 'datacenter', async (tx) => {
      await tx.delete(datacenters).where(eq(datacenters.id, id));
      return dc;
    }, 'Remove its buildings and spare-parts stock first');
  }

  async createBuilding(p: Principal, input: BuildingInput, meta: RequestMeta) {
    await this.getDatacenter(p, input.datacenterId);
    return this.write(p, meta, 'building.create', 'building', async (tx) => {
      const [b] = await tx.insert(buildings).values({ ...input, orgId: p.orgId }).returning();
      return b!;
    });
  }

  async updateBuilding(p: Principal, id: string, input: BuildingInput, meta: RequestMeta) {
    await this.own(buildings, p, id, 'Building');
    await this.getDatacenter(p, input.datacenterId);
    return this.write(p, meta, 'building.update', 'building', async (tx) => {
      const [b] = await tx.update(buildings).set(input).where(eq(buildings.id, id)).returning();
      return b!;
    });
  }

  async deleteBuilding(p: Principal, id: string, meta: RequestMeta) {
    const b = await this.own(buildings, p, id, 'Building');
    await this.write(p, meta, 'building.delete', 'building', async (tx) => {
      await tx.delete(buildings).where(eq(buildings.id, id));
      return b;
    }, 'Remove its rooms first');
  }

  async createRoom(p: Principal, input: RoomInput, meta: RequestMeta) {
    await this.own(buildings, p, input.buildingId, 'Building');
    return this.write(p, meta, 'room.create', 'room', async (tx) => {
      const [r] = await tx.insert(rooms).values({ ...input, orgId: p.orgId }).returning();
      return r!;
    });
  }

  async updateRoom(p: Principal, id: string, input: RoomInput, meta: RequestMeta) {
    await this.own(rooms, p, id, 'Room');
    await this.own(buildings, p, input.buildingId, 'Building');
    // Shrinking the floor grid must not strand racks outside it.
    const [outside] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(racks)
      .where(and(eq(racks.roomId, id), sql`(${racks.gridX} >= ${input.gridCols} or ${racks.gridY} >= ${input.gridRows})`));
    if ((outside?.n ?? 0) > 0) {
      throw new ConflictException({ error: 'grid_too_small', message: `${outside!.n} rack(s) stand outside the new floor size; move them first` });
    }
    return this.write(p, meta, 'room.update', 'room', async (tx) => {
      const [r] = await tx.update(rooms).set(input).where(eq(rooms.id, id)).returning();
      return r!;
    });
  }

  async deleteRoom(p: Principal, id: string, meta: RequestMeta) {
    const r = await this.own(rooms, p, id, 'Room');
    await this.write(p, meta, 'room.delete', 'room', async (tx) => {
      await tx.delete(rackRows).where(eq(rackRows.roomId, id));
      await tx.delete(rooms).where(eq(rooms.id, id));
      return r;
    }, 'Move or remove its racks first');
  }

  async createRow(p: Principal, input: RowInput, meta: RequestMeta) {
    await this.own(rooms, p, input.roomId, 'Room');
    return this.write(p, meta, 'row.create', 'rack_row', async (tx) => {
      const [r] = await tx.insert(rackRows).values({ ...input, orgId: p.orgId }).returning();
      return r!;
    });
  }

  async updateRow(p: Principal, id: string, input: RowInput, meta: RequestMeta) {
    const existing = await this.own(rackRows, p, id, 'Row');
    if (existing.roomId !== input.roomId) {
      throw new BadRequestException({ error: 'row_room_fixed', message: 'A row cannot move to another room; create a new row instead' });
    }
    return this.write(p, meta, 'row.update', 'rack_row', async (tx) => {
      const [r] = await tx.update(rackRows).set({ name: input.name, position: input.position }).where(eq(rackRows.id, id)).returning();
      return r!;
    });
  }

  async deleteRow(p: Principal, id: string, meta: RequestMeta) {
    const r = await this.own(rackRows, p, id, 'Row');
    // Racks in the row stay in the room; their row is cleared (ON DELETE SET NULL).
    await this.write(p, meta, 'row.delete', 'rack_row', async (tx) => {
      await tx.delete(rackRows).where(eq(rackRows.id, id));
      return r;
    });
  }

  /** Counts devices placed under a datacenter (used by summary pages). */
  async deviceCountForDatacenter(dcId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(devices)
      .innerJoin(racks, eq(racks.id, devices.rackId))
      .innerJoin(rooms, eq(rooms.id, racks.roomId))
      .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
      .where(eq(buildings.datacenterId, dcId));
    return row?.n ?? 0;
  }

  // ---------------------------------------------------------------------------

  private async own<T extends typeof buildings | typeof rooms | typeof rackRows>(table: T, p: Principal, id: string, what: string) {
    const rows = await this.db
      .select()
      .from(table as typeof buildings)
      .where(and(eq((table as typeof buildings).id, id), eq((table as typeof buildings).orgId, p.orgId)));
    if (!rows[0]) throw notFound(what);
    return rows[0] as unknown as T['$inferSelect'];
  }

  /** Runs a change and its audit record in one transaction, translating DB constraint errors. */
  private async write<R extends { id: string; name?: string; code?: string }>(
    p: Principal,
    meta: RequestMeta,
    action: string,
    targetType: string,
    fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<R>,
    fkMessage?: string,
  ): Promise<R> {
    try {
      return await this.db.transaction(async (tx) => {
        const row = await fn(tx);
        await this.audit.record(
          { orgId: p.orgId, actor: actorFrom(p), action, target: { type: targetType, id: row.id }, outcome: 'success', meta, metadata: { name: row.name ?? null, code: row.code ?? null } },
          tx,
        );
        return row;
      });
    } catch (err) {
      rethrowDbError(err, { fk: fkMessage });
    }
  }
}
