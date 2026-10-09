import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import QRCode from 'qrcode';
import type { z } from 'zod';
import {
  LIFECYCLE_LABELS,
  LIFECYCLE_STATES,
  RACKED_STATES,
  type DeviceCreateInput,
  type DeviceInput,
  type LifecycleState,
  type Paginated,
  deviceCreateSchema,
  placementSchema as placementSchemaValue,
  type bulkDeviceSchema,
  type deviceEventSchema,
  type deviceListQuerySchema,
  type placementSchema,
} from '@crapplet/shared';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db, type DbOrTx } from '../db/db';
import {
  buildings,
  customers,
  datacenters,
  deviceEvents,
  deviceModels,
  devices,
  lifecycleTransitions,
  manufacturers,
  rackReservations,
  racks,
  rooms,
  type Device,
} from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import { tenantFilter } from '../tenancy/tenant-scope';
import type { Principal, RequestMeta } from '../auth/principal';
import { parseCsvObjects, toCsv } from './csv';

type ListQuery = z.infer<typeof deviceListQuerySchema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const scopeCols = { orgId: devices.orgId, customerId: devices.customerId };
const NOT_FOUND = () => new NotFoundException({ error: 'not_found', message: 'Device not found' });

/** Columns exposed in list views and exports, joined with model, location and customer. */
const listColumns = {
  device: devices,
  modelName: deviceModels.name,
  manufacturerName: manufacturers.name,
  rackName: racks.name,
  roomName: rooms.name,
  datacenterId: datacenters.id,
  datacenterCode: datacenters.code,
  customerName: customers.name,
  customerCode: customers.code,
};

type ListRow = {
  device: Device;
  modelName: string;
  manufacturerName: string;
  rackName: string | null;
  roomName: string | null;
  datacenterId: string | null;
  datacenterCode: string | null;
  customerName: string | null;
  customerCode: string | null;
};

class DryRunRollback extends Error {}

@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  private baseQuery(where: SQL | undefined) {
    return this.db
      .select(listColumns)
      .from(devices)
      .innerJoin(deviceModels, eq(deviceModels.id, devices.modelId))
      .innerJoin(manufacturers, eq(manufacturers.id, deviceModels.manufacturerId))
      .leftJoin(racks, eq(racks.id, devices.rackId))
      .leftJoin(rooms, eq(rooms.id, racks.roomId))
      .leftJoin(buildings, eq(buildings.id, rooms.buildingId))
      .leftJoin(datacenters, eq(datacenters.id, buildings.datacenterId))
      .leftJoin(customers, eq(customers.id, devices.customerId))
      .where(where);
  }

  private conditions(p: Principal, q: Partial<ListQuery>): SQL {
    const conds: SQL[] = [tenantFilter(p, scopeCols)];
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      // Management addresses are staff-only data, so customers can't search by them either.
      const fields = [ilike(devices.assetTag, like), ilike(devices.hostname, like), ilike(devices.serial, like), ilike(deviceModels.name, like)];
      if (p.userType === 'staff') fields.push(ilike(devices.mgmtAddress, like));
      conds.push(or(...fields)!);
    }
    if (q.state) conds.push(eq(devices.lifecycleState, q.state));
    if (q.category) conds.push(eq(devices.category, q.category));
    if (q.rackId) conds.push(eq(devices.rackId, q.rackId));
    if (q.datacenterId) conds.push(eq(datacenters.id, q.datacenterId));
    if (q.customerId && p.userType === 'staff') conds.push(eq(devices.customerId, q.customerId));
    if (q.unracked === 'true') conds.push(isNull(devices.rackId));
    if (q.unracked === 'false') conds.push(sql`${devices.rackId} is not null`);
    if (q.warrantyWithinDays !== undefined) {
      conds.push(lte(devices.warrantyExpires, sql`(current_date + ${q.warrantyWithinDays}::int)`));
      conds.push(sql`${devices.lifecycleState} <> 'retired'`);
    }
    return and(...conds)!;
  }

  async list(p: Principal, q: ListQuery): Promise<Paginated<ReturnType<DevicesService['view']>>> {
    const where = this.conditions(p, q);
    const order =
      q.sort === 'hostname'
        ? [asc(devices.hostname), asc(devices.assetTag)]
        : q.sort === 'state'
          ? [asc(devices.lifecycleState), asc(devices.assetTag)]
          : q.sort === 'warranty'
            ? [sql`${devices.warrantyExpires} asc nulls last`, asc(devices.assetTag)]
            : q.sort === 'updated'
              ? [desc(devices.updatedAt)]
              : [asc(devices.assetTag)];
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      this.baseQuery(where)
        .orderBy(...order)
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.db
        .select({ total: count() })
        .from(devices)
        .innerJoin(deviceModels, eq(deviceModels.id, devices.modelId))
        .leftJoin(racks, eq(racks.id, devices.rackId))
        .leftJoin(rooms, eq(rooms.id, racks.roomId))
        .leftJoin(buildings, eq(buildings.id, rooms.buildingId))
        .leftJoin(datacenters, eq(datacenters.id, buildings.datacenterId))
        .where(where),
    ]);
    return { items: rows.map((r) => this.view(p, r)), page: q.page, pageSize: q.pageSize, total };
  }

  async get(p: Principal, id: string) {
    const [row] = await this.baseQuery(and(eq(devices.id, id), tenantFilter(p, scopeCols)));
    if (!row) throw NOT_FOUND();
    return this.view(p, row);
  }

  private async row(p: Principal, id: string, tx: DbOrTx = this.db, lock = false): Promise<Device> {
    const q = tx.select().from(devices).where(and(eq(devices.id, id), eq(devices.orgId, p.orgId)));
    const [d] = lock ? await q.for('update') : await q;
    if (!d) throw NOT_FOUND();
    return d;
  }

  /** Customers see their own equipment without purchasing data or internal notes. */
  view(p: Principal, r: ListRow) {
    const d = r.device;
    const base = {
      id: d.id,
      assetTag: d.assetTag,
      hostname: d.hostname,
      serial: d.serial,
      category: d.category,
      lifecycleState: d.lifecycleState,
      ownership: d.ownership,
      customerId: d.customerId,
      customerName: r.customerName,
      model: { id: d.modelId, name: r.modelName, manufacturer: r.manufacturerName, uHeight: d.uHeight, fullDepth: d.fullDepth },
      location: d.rackId
        ? { rackId: d.rackId, rackName: r.rackName, roomName: r.roomName, datacenterId: r.datacenterId, datacenterCode: r.datacenterCode, positionU: d.positionU, face: d.face }
        : null,
      cpu: d.cpu,
      cpuCount: d.cpuCount,
      ramGb: d.ramGb,
      dimmLayout: d.dimmLayout,
      disks: d.disks,
      raid: d.raid,
      nics: d.nics,
      os: d.os,
      warrantyExpires: d.warrantyExpires,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
    if (p.userType !== 'staff') return base;
    return {
      ...base,
      mgmtType: d.mgmtType,
      mgmtAddress: d.mgmtAddress,
      biosVersion: d.biosVersion,
      bmcFirmware: d.bmcFirmware,
      purchaseDate: d.purchaseDate,
      supplier: d.supplier,
      purchaseCost: d.purchaseCost === null ? null : Number(d.purchaseCost),
      currency: d.currency,
      eolDate: d.eolDate,
      notes: d.notes,
      custom: d.custom,
      customerCode: r.customerCode,
    };
  }

  // ---------------------------------------------------------------------------
  // Create and update
  // ---------------------------------------------------------------------------

  async create(p: Principal, input: DeviceCreateInput, meta: RequestMeta, tx?: Tx) {
    const run = async (t: Tx) => {
      const model = await this.model(p, input.modelId, t);
      if (input.customerId) await this.checkCustomer(p, input.customerId, t);
      const [d] = await t
        .insert(devices)
        .values({ ...this.cols(input), orgId: p.orgId, category: model.category, uHeight: model.uHeight, fullDepth: model.fullDepth, lifecycleState: input.initialState })
        .returning();
      await this.event(t, p, d!.id, 'created', `Added as ${LIFECYCLE_LABELS[d!.lifecycleState]}`);
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: d!.customerId, action: 'device.create', target: { type: 'device', id: d!.id }, outcome: 'success', meta, metadata: { assetTag: d!.assetTag, state: d!.lifecycleState } }, t);
      return d!;
    };
    try {
      const d = tx ? await run(tx) : await this.db.transaction(run);
      return tx ? d : this.get(p, d.id);
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async update(p: Principal, id: string, input: DeviceInput, meta: RequestMeta) {
    try {
      await this.db.transaction(async (tx) => {
        const before = await this.row(p, id, tx, true);
        let modelCols = {};
        if (input.modelId !== before.modelId) {
          const model = await this.model(p, input.modelId, tx);
          if (before.rackId !== null && (model.uHeight !== before.uHeight || model.fullDepth !== before.fullDepth)) {
            throw new BadRequestException({ error: 'unrack_first', message: 'The new model has a different size; take the device out of the rack before changing its model' });
          }
          modelCols = { category: model.category, uHeight: model.uHeight, fullDepth: model.fullDepth };
        }
        if (input.customerId) await this.checkCustomer(p, input.customerId, tx);
        if ((input.customerId ?? null) !== before.customerId && before.rackId) {
          await this.assertRackAccepts(tx, before.rackId, input.customerId ?? null, before.positionU, before.uHeight);
        }
        const [after] = await tx
          .update(devices)
          .set({ ...this.cols(input), ...modelCols })
          .where(eq(devices.id, id))
          .returning();
        const changed = changedFields(before, after!);
        if (changed.length) await this.event(tx, p, id, 'updated', `Updated ${changed.join(', ')}`, { fields: changed });
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: after!.customerId, action: 'device.update', target: { type: 'device', id }, outcome: 'success', meta, metadata: { fields: changed } }, tx);
      });
    } catch (err) {
      rethrowDbError(err);
    }
    return this.get(p, id);
  }

  // ---------------------------------------------------------------------------
  // Placement
  // ---------------------------------------------------------------------------

  /**
   * Places a device in a rack (or takes it out). The database rejects overlaps,
   * positions beyond the rack and devices deeper than the rack; this method adds
   * the business rules: retired equipment can't be racked, dedicated racks and
   * reserved units only take the right customer's equipment, and devices in a
   * racked state must change state before leaving the rack.
   */
  async place(p: Principal, id: string, input: z.infer<typeof placementSchema>, meta: RequestMeta, tx?: Tx) {
    const run = async (t: Tx) => {
      const d = await this.row(p, id, t, true);
      if (d.lifecycleState === 'retired') throw new BadRequestException({ error: 'device_retired', message: 'Retired equipment can’t be placed in a rack' });
      const from = await this.placementLabel(t, d.rackId, d.positionU, d.face);

      let next: { rackId: string | null; positionU: number | null; face: 'front' | 'rear' | null };
      if (input.rackId === null) {
        if (RACKED_STATES.includes(d.lifecycleState)) {
          throw new BadRequestException({ error: 'change_state_first', message: `This device is ${LIFECYCLE_LABELS[d.lifecycleState].toLowerCase()}. Change its state to “In inventory” to take it out of the rack.` });
        }
        next = { rackId: null, positionU: null, face: null };
      } else {
        const [rack] = await t.select().from(racks).where(and(eq(racks.id, input.rackId), eq(racks.orgId, p.orgId))).for('update');
        if (!rack) throw new BadRequestException({ error: 'invalid_rack', message: 'Rack does not exist' });
        if (rack.status === 'decommissioned') throw new BadRequestException({ error: 'rack_decommissioned', message: 'That rack is decommissioned' });
        if (d.uHeight === 0) {
          next = { rackId: rack.id, positionU: null, face: null };
        } else {
          if (!input.positionU) throw new BadRequestException({ error: 'position_required', message: 'Choose the lowest rack unit for this device' });
          next = { rackId: rack.id, positionU: input.positionU, face: input.face ?? 'front' };
        }
        await this.assertRackAccepts(t, rack.id, d.customerId, next.positionU, d.uHeight);
      }

      if (next.rackId === d.rackId && next.positionU === d.positionU && next.face === d.face) return d;
      const [after] = await t.update(devices).set(next).where(eq(devices.id, id)).returning();
      const to = await this.placementLabel(t, next.rackId, next.positionU, next.face);
      const summary = next.rackId ? `Moved from ${from} to ${to}` : `Removed from ${from}`;
      await this.event(t, p, id, 'moved', input.reason ? `${summary} (${input.reason})` : summary, { from, to });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: d.customerId, action: 'device.place', target: { type: 'device', id }, outcome: 'success', meta, metadata: { from, to, reason: input.reason ?? null } }, t);
      return after!;
    };
    try {
      if (tx) return await run(tx);
      await this.db.transaction(run);
    } catch (err) {
      rethrowDbError(err);
    }
    return this.get(p, id);
  }

  /**
   * The rack accepts equipment of `customerId` at these units: it is not
   * dedicated to someone else and no live reservation for someone else covers
   * them. Locks the rack row so a concurrent reservation or rededication can't
   * slip in between the check and the write.
   */
  private async assertRackAccepts(t: DbOrTx, rackId: string, customerId: string | null, positionU: number | null, uHeight: number) {
    const [rack] = await t.select({ customerId: racks.customerId }).from(racks).where(eq(racks.id, rackId)).for('update');
    if (rack?.customerId && rack.customerId !== customerId) {
      throw new ConflictException({ error: 'rack_dedicated', message: 'This rack is dedicated to another customer' });
    }
    await this.assertRackAllows(t, rackId, customerId, positionU, uHeight);
  }

  /** Reserved units only take equipment of the customer they are reserved for. */
  private async assertRackAllows(t: DbOrTx, rackId: string, customerId: string | null, positionU: number | null, uHeight: number) {
    if (positionU === null || uHeight === 0) return;
    const blocking = await t
      .select({ startU: rackReservations.startU, endU: rackReservations.endU, customerId: rackReservations.customerId, reason: rackReservations.reason })
      .from(rackReservations)
      .where(
        and(
          eq(rackReservations.rackId, rackId),
          sql`${rackReservations.uRange} && int4range(${positionU}, ${positionU + uHeight})`,
          sql`(${rackReservations.expiresAt} is null or ${rackReservations.expiresAt} > now())`,
          sql`${rackReservations.customerId} is distinct from ${customerId}`,
        ),
      )
      .limit(1);
    if (blocking[0]) {
      const b = blocking[0];
      throw new ConflictException({ error: 'units_reserved', message: `U${b.startU}–U${b.endU} are reserved (${b.reason})` });
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async allowedTransitions(p: Principal, from: LifecycleState): Promise<LifecycleState[]> {
    const rows = await this.db
      .select({ to: lifecycleTransitions.toState })
      .from(lifecycleTransitions)
      .where(and(eq(lifecycleTransitions.orgId, p.orgId), eq(lifecycleTransitions.fromState, from)));
    return LIFECYCLE_STATES.filter((s) => rows.some((r) => r.to === s));
  }

  async transition(p: Principal, id: string, to: LifecycleState, note: string | undefined, meta: RequestMeta, tx?: Tx) {
    const run = async (t: Tx) => {
      const d = await this.row(p, id, t, true);
      if (d.lifecycleState === to) throw new BadRequestException({ error: 'same_state', message: `Already ${LIFECYCLE_LABELS[to].toLowerCase()}` });
      const [rule] = await t
        .select()
        .from(lifecycleTransitions)
        .where(and(eq(lifecycleTransitions.orgId, p.orgId), eq(lifecycleTransitions.fromState, d.lifecycleState), eq(lifecycleTransitions.toState, to)));
      if (!rule) {
        throw new BadRequestException({ error: 'transition_not_allowed', message: `A device can’t go from ${LIFECYCLE_LABELS[d.lifecycleState]} to ${LIFECYCLE_LABELS[to]}` });
      }
      // Rack-mounted equipment needs a unit; 0U equipment (PDUs) still needs a rack.
      const unplaced = d.uHeight > 0 ? d.positionU === null : d.rackId === null;
      if (RACKED_STATES.includes(to) && unplaced) {
        throw new BadRequestException({ error: 'place_first', message: `Place the device in a rack before marking it ${LIFECYCLE_LABELS[to].toLowerCase()}` });
      }
      // Leaving the racked states takes the device out of its rack in the same step.
      const unrack = !RACKED_STATES.includes(to) && d.rackId !== null;
      const from = unrack ? await this.placementLabel(t, d.rackId, d.positionU, d.face) : null;
      await t
        .update(devices)
        .set({ lifecycleState: to, ...(unrack ? { rackId: null, positionU: null, face: null } : {}) })
        .where(eq(devices.id, id));
      const summary = `${LIFECYCLE_LABELS[d.lifecycleState]} → ${LIFECYCLE_LABELS[to]}${unrack ? `, removed from ${from}` : ''}${note ? `: ${note}` : ''}`;
      await this.event(t, p, id, 'lifecycle', summary, { from: d.lifecycleState, to, unracked: unrack });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: d.customerId, action: 'device.transition', target: { type: 'device', id }, outcome: 'success', meta, metadata: { from: d.lifecycleState, to, note: note ?? null } }, t);
    };
    try {
      if (tx) return await run(tx);
      await this.db.transaction(run);
    } catch (err) {
      rethrowDbError(err);
    }
    return this.get(p, id);
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  async events(p: Principal, id: string) {
    await this.row(p, id);
    return this.db.select().from(deviceEvents).where(eq(deviceEvents.deviceId, id)).orderBy(desc(deviceEvents.id)).limit(500);
  }

  async addEvent(p: Principal, id: string, input: z.infer<typeof deviceEventSchema>, meta: RequestMeta) {
    const d = await this.row(p, id);
    return this.db.transaction(async (tx) => {
      const ev = await this.event(tx, p, id, input.kind, input.summary);
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: d.customerId, action: `device.${input.kind}`, target: { type: 'device', id }, outcome: 'success', meta }, tx);
      return ev;
    });
  }

  private async event(tx: DbOrTx, p: Principal, deviceId: string, kind: string, summary: string, data: Record<string, unknown> = {}) {
    const [ev] = await tx.insert(deviceEvents).values({ orgId: p.orgId, deviceId, kind, summary, data, actorId: p.userId, actorLabel: p.email }).returning();
    return ev!;
  }

  // ---------------------------------------------------------------------------
  // Bulk
  // ---------------------------------------------------------------------------

  async bulk(p: Principal, input: z.infer<typeof bulkDeviceSchema>, meta: RequestMeta) {
    const ids = [...new Set(input.ids)];
    const owned = await this.db.select({ id: devices.id, assetTag: devices.assetTag }).from(devices).where(and(eq(devices.orgId, p.orgId), inArray(devices.id, ids)));
    if (owned.length !== ids.length) throw new BadRequestException({ error: 'invalid_devices', message: 'Some devices do not exist' });
    const tagOf = new Map(owned.map((d) => [d.id, d.assetTag]));
    const failed: { id: string; assetTag: string; message: string }[] = [];
    let updated = 0;
    for (const id of ids) {
      try {
        await this.db.transaction(async (tx) => {
          if (input.set && Object.keys(input.set).length) {
            const d = await this.row(p, id, tx, true);
            const set = input.set;
            if (set.customerId) await this.checkCustomer(p, set.customerId, tx);
            const nextCustomer = set.customerId !== undefined ? set.customerId : d.customerId;
            if (nextCustomer !== d.customerId && d.rackId) await this.assertRackAccepts(tx, d.rackId, nextCustomer, d.positionU, d.uHeight);
            const before = { customerId: d.customerId, ownership: d.ownership, supplier: d.supplier, warrantyExpires: d.warrantyExpires };
            await tx
              .update(devices)
              .set({
                ...(set.customerId !== undefined && { customerId: set.customerId }),
                ...(set.ownership !== undefined && { ownership: set.ownership }),
                ...(set.supplier !== undefined && { supplier: set.supplier }),
                ...(set.warrantyExpires !== undefined && { warrantyExpires: set.warrantyExpires }),
              })
              .where(eq(devices.id, id));
            await this.event(tx, p, id, 'updated', `Bulk update: ${Object.keys(set).join(', ')}`, { fields: Object.keys(set) });
            const after = Object.fromEntries(Object.keys(set).map((k) => [k, set[k as keyof typeof set] ?? null]));
            const was = Object.fromEntries(Object.keys(set).map((k) => [k, before[k as keyof typeof before] ?? null]));
            await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: nextCustomer ?? d.customerId, action: 'device.bulk_update', target: { type: 'device', id }, outcome: 'success', meta, metadata: { before: was, after } }, tx);
          }
          if (input.transitionTo) await this.transition(p, id, input.transitionTo, 'bulk change', meta, tx);
        });
        updated++;
      } catch (err) {
        failed.push({ id, assetTag: tagOf.get(id)!, message: safeMessage(err, 'Update failed') });
      }
    }
    return { updated, failed };
  }

  // ---------------------------------------------------------------------------
  // CSV export / import
  // ---------------------------------------------------------------------------

  static readonly CSV_HEADERS = [
    'asset_tag', 'hostname', 'serial', 'manufacturer', 'model', 'category', 'state', 'ownership', 'customer_code',
    'datacenter', 'room', 'rack', 'position_u', 'face', 'cpu', 'cpu_count', 'ram_gb', 'os', 'mgmt_type', 'mgmt_address',
    'supplier', 'purchase_date', 'purchase_cost', 'currency', 'warranty_expires', 'eol_date', 'notes',
  ];

  async exportCsv(p: Principal, q: Partial<ListQuery>): Promise<string> {
    const rows = await this.baseQuery(this.conditions(p, q)).orderBy(asc(devices.assetTag)).limit(50_000);
    return toCsv(
      DevicesService.CSV_HEADERS,
      rows.map((r) => {
        const d = r.device;
        return [
          d.assetTag, d.hostname, d.serial, r.manufacturerName, r.modelName, d.category, d.lifecycleState, d.ownership, r.customerCode,
          r.datacenterCode, r.roomName, r.rackName, d.positionU, d.face, d.cpu, d.cpuCount, d.ramGb, d.os, d.mgmtType, d.mgmtAddress,
          d.supplier, d.purchaseDate, d.purchaseCost, d.currency, d.warrantyExpires, d.eolDate, d.notes,
        ];
      }),
    );
  }

  /**
   * Imports devices from CSV (same columns as the export). Each row runs in
   * its own savepoint, so one bad row doesn't stop the others. With
   * `dryRun`, everything is validated against the real database (including
   * placement constraints) and then rolled back.
   */
  async importCsv(p: Principal, csv: string, dryRun: boolean, meta: RequestMeta) {
    let parsed: ReturnType<typeof parseCsvObjects>;
    try {
      parsed = parseCsvObjects(csv);
    } catch (e) {
      throw new BadRequestException({ error: 'invalid_csv', message: (e as Error).message });
    }
    const required = ['asset_tag', 'manufacturer', 'model'];
    const missing = required.filter((h) => !parsed.headers.includes(h));
    if (missing.length) throw new BadRequestException({ error: 'invalid_csv', message: `Missing column(s): ${missing.join(', ')}` });
    if (parsed.rows.length > 5000) throw new BadRequestException({ error: 'too_many_rows', message: 'Import at most 5,000 rows at a time' });

    const results: { line: number; assetTag: string; ok: boolean; message: string }[] = [];
    try {
      await this.db.transaction(async (tx) => {
        for (const [idx, row] of parsed.rows.entries()) {
          const line = idx + 2;
          try {
            await tx.transaction(async (sp) => {
              const message = await this.importRow(p, row, sp, meta);
              results.push({ line, assetTag: row.asset_tag ?? '', ok: true, message });
            });
          } catch (err) {
            results.push({ line, assetTag: row.asset_tag ?? '', ok: false, message: safeMessage(err, 'This row could not be saved') });
          }
        }
        if (!dryRun) {
          await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'device.import', target: { type: 'device', id: null }, outcome: 'success', meta, metadata: { rows: parsed.rows.length, created: results.filter((r) => r.ok).length } }, tx);
        }
        if (dryRun) throw new DryRunRollback();
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
    return { dryRun, total: results.length, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }

  private async importRow(p: Principal, row: Record<string, string>, tx: Tx, meta: RequestMeta): Promise<string> {
    const fail = (message: string) => {
      throw new BadRequestException({ error: 'invalid_row', message });
    };
    // Values exported by us may carry a leading apostrophe that neutralized a spreadsheet formula; strip it on the way back in.
    const v = (k: string) => (row[k] ?? '').trim().replace(/^'(?=[=+\-@])/, '') || null;
    if (!v('asset_tag')) fail('asset_tag is required');
    const [model] = await tx
      .select({ id: deviceModels.id })
      .from(deviceModels)
      .innerJoin(manufacturers, eq(manufacturers.id, deviceModels.manufacturerId))
      .where(and(eq(deviceModels.orgId, p.orgId), sql`lower(${manufacturers.name}) = lower(${v('manufacturer') ?? ''})`, sql`lower(${deviceModels.name}) = lower(${v('model') ?? ''})`));
    if (!model) fail(`Unknown model “${v('manufacturer')} ${v('model')}”. Add it under Models first.`);

    let customerId: string | null = null;
    if (v('customer_code')) {
      const [c] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.orgId, p.orgId), eq(customers.code, v('customer_code')!.toUpperCase())));
      if (!c) fail(`Unknown customer code ${v('customer_code')}`);
      customerId = c!.id;
    }
    const ownership = (v('ownership') ?? (customerId ? 'customer' : 'company')) as 'company' | 'customer';
    if (!['company', 'customer'].includes(ownership)) fail('ownership must be company or customer');
    const state = (v('state') ?? 'inventory') as LifecycleState;
    const allowedStates: LifecycleState[] = ['planned', 'received', 'inventory', 'racked', 'active', 'maintenance'];
    if (!allowedStates.includes(state)) fail(`state must be one of ${allowedStates.join(', ')}`);
    const num = (k: string) => {
      const s = v(k);
      if (s === null) return null;
      const n = Number(s);
      if (!Number.isFinite(n)) fail(`${k} must be a number`);
      return n;
    };
    const date = (k: string) => {
      const s = v(k);
      if (s !== null && !/^\d{4}-\d{2}-\d{2}$/.test(s)) fail(`${k} must be YYYY-MM-DD`);
      return s;
    };
    const mgmtType = v('mgmt_type');
    if (mgmtType && !['idrac', 'ilo', 'ipmi', 'redfish', 'other'].includes(mgmtType)) fail('mgmt_type must be idrac, ilo, ipmi, redfish or other');

    const input: DeviceCreateInput = {
      modelId: model!.id,
      assetTag: v('asset_tag')!,
      hostname: v('hostname'),
      serial: v('serial'),
      ownership,
      customerId,
      cpu: v('cpu'),
      cpuCount: num('cpu_count'),
      ramGb: num('ram_gb'),
      disks: [],
      nics: [],
      os: v('os'),
      mgmtType: mgmtType as DeviceCreateInput['mgmtType'],
      mgmtAddress: v('mgmt_address'),
      supplier: v('supplier'),
      purchaseDate: date('purchase_date'),
      purchaseCost: num('purchase_cost'),
      currency: v('currency')?.toUpperCase() ?? null,
      warrantyExpires: date('warranty_expires'),
      eolDate: date('eol_date'),
      notes: v('notes'),
      custom: {},
      initialState: 'inventory',
    };
    if (ownership === 'customer' && !customerId) fail('customer_code is required for customer-owned equipment');
    // Same validation as the API form (lengths, ranges, formats), with a readable message.
    const checked = deviceCreateSchema.safeParse({ ...input, initialState: state === 'planned' || state === 'received' ? state : 'inventory' });
    if (!checked.success) {
      const issue = checked.error.issues[0]!;
      fail(`${toCsvColumn(issue.path.join('.'))}: ${issue.message}`);
    }
    const d = await this.create(p, checked.data!, meta, tx);

    let where = '';
    if (v('rack')) {
      const [rack] = await tx
        .select({ id: racks.id })
        .from(racks)
        .innerJoin(rooms, eq(rooms.id, racks.roomId))
        .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
        .innerJoin(datacenters, eq(datacenters.id, buildings.datacenterId))
        .where(
          and(
            eq(racks.orgId, p.orgId),
            eq(racks.name, v('rack')!),
            ...(v('datacenter') ? [eq(datacenters.code, v('datacenter')!.toUpperCase())] : []),
            ...(v('room') ? [eq(rooms.name, v('room')!)] : []),
          ),
        )
        .limit(2)
        .then((r) => (r.length > 1 ? fail(`Rack ${v('rack')} is ambiguous; add datacenter and room columns`) : r));
      if (!rack) fail(`Rack ${v('rack')} not found`);
      const face = v('face') as 'front' | 'rear' | null;
      if (face && face !== 'front' && face !== 'rear') fail('face must be front or rear');
      const position = placementSchemaValue.safeParse({ rackId: rack!.id, positionU: num('position_u'), face: face ?? 'front', reason: 'import' });
      if (!position.success) fail(`position_u: ${position.error.issues[0]!.message}`);
      await this.place(p, d.id, position.data!, meta, tx);
      where = ` in rack ${v('rack')}${v('position_u') ? ` at U${v('position_u')}` : ''}`;
    } else if (RACKED_STATES.includes(state)) {
      fail(`state ${state} needs a rack and position`);
    }
    if (RACKED_STATES.includes(state)) {
      // Imported equipment already in service: record its state directly, with history.
      await tx.update(devices).set({ lifecycleState: state }).where(eq(devices.id, d.id));
      await this.event(tx, p, d.id, 'lifecycle', `Imported as ${LIFECYCLE_LABELS[state]}`, { to: state, imported: true });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: d.customerId, action: 'device.transition', target: { type: 'device', id: d.id }, outcome: 'success', meta, metadata: { from: d.lifecycleState, to: state, imported: true } }, tx);
    }
    return `Created${where}`;
  }

  // ---------------------------------------------------------------------------
  // Labels
  // ---------------------------------------------------------------------------

  /** Printable label: asset tag, hostname, serial and a QR code linking to the device page. */
  async label(p: Principal, id: string) {
    const d = await this.get(p, id);
    const origin = this.config.WEB_ORIGIN.split(',')[0]!.trim().replace(/\/$/, '');
    const url = `${origin}/hardware/${d.id}`;
    const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0 });
    return { id: d.id, assetTag: d.assetTag, hostname: d.hostname, serial: d.serial, model: `${d.model.manufacturer} ${d.model.name}`, location: d.location, url, qrSvg };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private cols(i: DeviceInput) {
    return {
      modelId: i.modelId,
      assetTag: i.assetTag,
      hostname: i.hostname ?? null,
      serial: i.serial ?? null,
      ownership: i.ownership,
      customerId: i.customerId ?? null,
      cpu: i.cpu ?? null,
      cpuCount: i.cpuCount ?? null,
      ramGb: i.ramGb ?? null,
      dimmLayout: i.dimmLayout ?? null,
      disks: i.disks,
      raid: i.raid ?? null,
      nics: i.nics,
      mgmtType: i.mgmtType ?? null,
      mgmtAddress: i.mgmtAddress ?? null,
      biosVersion: i.biosVersion ?? null,
      bmcFirmware: i.bmcFirmware ?? null,
      os: i.os ?? null,
      purchaseDate: i.purchaseDate ?? null,
      supplier: i.supplier ?? null,
      purchaseCost: i.purchaseCost == null ? null : String(i.purchaseCost),
      currency: i.currency ?? null,
      warrantyExpires: i.warrantyExpires ?? null,
      eolDate: i.eolDate ?? null,
      notes: i.notes ?? null,
      custom: i.custom,
    };
  }

  private async model(p: Principal, id: string, tx: DbOrTx) {
    // FOR SHARE: a concurrent change to the model's size waits for this device write (and vice versa).
    const [m] = await tx.select().from(deviceModels).where(and(eq(deviceModels.id, id), eq(deviceModels.orgId, p.orgId))).for('share');
    if (!m) throw new BadRequestException({ error: 'invalid_model', message: 'Device model does not exist' });
    return m;
  }

  private async checkCustomer(p: Principal, id: string, tx: DbOrTx) {
    const [c] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.id, id), eq(customers.orgId, p.orgId)));
    if (!c) throw new BadRequestException({ error: 'invalid_customer', message: 'Customer does not exist' });
  }

  private async placementLabel(tx: DbOrTx, rackId: string | null, positionU: number | null, face: string | null): Promise<string> {
    if (!rackId) return 'unracked';
    const [r] = await tx
      .select({ rack: racks.name, room: rooms.name, dc: datacenters.code })
      .from(racks)
      .innerJoin(rooms, eq(rooms.id, racks.roomId))
      .innerJoin(buildings, eq(buildings.id, rooms.buildingId))
      .innerJoin(datacenters, eq(datacenters.id, buildings.datacenterId))
      .where(eq(racks.id, rackId));
    return `${r?.dc}/${r?.room}/${r?.rack}${positionU ? ` U${positionU}${face === 'rear' ? ' rear' : ''}` : ' (0U)'}`;
  }
}

function changedFields(a: Device, b: Device): string[] {
  const skip = new Set(['updatedAt', 'createdAt', 'uRange', 'occupiesFront', 'occupiesRear']);
  return Object.keys(b).filter((k) => !skip.has(k) && JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify((b as Record<string, unknown>)[k]));
}

/** Client-safe message: HTTP errors keep their message, known DB constraint errors are translated, anything else is generic. */
function safeMessage(err: unknown, fallback: string): string {
  const http = (err as { response?: { message?: unknown } }).response;
  if (http && typeof http.message === 'string') return http.message;
  try {
    rethrowDbError(err);
  } catch (mapped) {
    const m = (mapped as { response?: { message?: unknown } }).response?.message;
    if (typeof m === 'string') return m;
  }
  return fallback;
}

const CSV_NAMES: Record<string, string> = {
  assetTag: 'asset_tag', hostname: 'hostname', serial: 'serial', cpuCount: 'cpu_count', ramGb: 'ram_gb', purchaseCost: 'purchase_cost',
  currency: 'currency', purchaseDate: 'purchase_date', warrantyExpires: 'warranty_expires', eolDate: 'eol_date', mgmtAddress: 'mgmt_address', os: 'os', cpu: 'cpu', supplier: 'supplier', notes: 'notes',
};
function toCsvColumn(path: string): string {
  return CSV_NAMES[path] ?? path;
}
