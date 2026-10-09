import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { LIFECYCLE_STATES, type LifecycleState } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { datacenters, deviceModels, devices, lifecycleTransitions, manufacturers, racks, rooms, spareParts } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import type { Principal, RequestMeta } from '../auth/principal';

@Injectable()
export class DcimSummaryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Physical-inventory figures for the overview dashboard. Every number is a live count. */
  async summary(p: Principal) {
    const org = p.orgId;
    const one = <T>(rows: T[]) => rows[0]!;
    const [counts, capacity, byState, byCategory, warranty, expiring, lowStock] = await Promise.all([
      this.db
        .execute(
          sql`select
                (select count(*)::int from datacenters where org_id = ${org}) as datacenters,
                (select count(*)::int from rooms where org_id = ${org}) as rooms,
                (select count(*)::int from racks where org_id = ${org} and status <> 'decommissioned') as racks,
                (select count(*)::int from devices where org_id = ${org} and lifecycle_state <> 'retired') as devices,
                (select count(*)::int from devices where org_id = ${org} and rack_id is null and lifecycle_state not in ('retired')) as unracked`,
        )
        .then((r) => one(r.rows as { datacenters: number; rooms: number; racks: number; devices: number; unracked: number }[])),
      this.db
        .execute(
          sql`select coalesce(sum(k.u_height), 0)::int as total_u,
                     coalesce(sum((select count(distinct u) from devices d, generate_series(lower(d.u_range), upper(d.u_range) - 1) u where d.rack_id = k.id and d.u_range is not null)), 0)::int as used_u,
                     coalesce(sum((select coalesce(sum(r.end_u - r.start_u + 1), 0) from rack_reservations r where r.rack_id = k.id and (r.expires_at is null or r.expires_at > now()))), 0)::int as reserved_u
              from racks k where k.org_id = ${org} and k.status <> 'decommissioned'`,
        )
        .then((r) => one(r.rows as { total_u: number; used_u: number; reserved_u: number }[])),
      this.db
        .select({ state: devices.lifecycleState, n: sql<number>`count(*)::int` })
        .from(devices)
        .where(eq(devices.orgId, org))
        .groupBy(devices.lifecycleState),
      this.db
        .select({ category: devices.category, n: sql<number>`count(*)::int` })
        .from(devices)
        .where(and(eq(devices.orgId, org), sql`${devices.lifecycleState} <> 'retired'`))
        .groupBy(devices.category),
      this.db
        .execute(
          sql`select count(*) filter (where warranty_expires < current_date)::int as expired,
                     count(*) filter (where warranty_expires >= current_date and warranty_expires < current_date + 90)::int as within90
              from devices where org_id = ${org} and lifecycle_state <> 'retired'`,
        )
        .then((r) => one(r.rows as { expired: number; within90: number }[])),
      this.db
        .select({ id: devices.id, assetTag: devices.assetTag, hostname: devices.hostname, warrantyExpires: devices.warrantyExpires, model: deviceModels.name, manufacturer: manufacturers.name })
        .from(devices)
        .innerJoin(deviceModels, eq(deviceModels.id, devices.modelId))
        .innerJoin(manufacturers, eq(manufacturers.id, deviceModels.manufacturerId))
        .where(and(eq(devices.orgId, org), sql`${devices.lifecycleState} <> 'retired'`, sql`${devices.warrantyExpires} < current_date + 90`))
        .orderBy(asc(devices.warrantyExpires))
        .limit(8),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(spareParts)
        .where(and(eq(spareParts.orgId, org), sql`${spareParts.quantity} <= ${spareParts.minQuantity}`))
        .then(one),
    ]);
    const states = Object.fromEntries(LIFECYCLE_STATES.map((s) => [s, byState.find((r) => r.state === s)?.n ?? 0])) as Record<LifecycleState, number>;
    return {
      counts,
      capacity: { totalU: capacity.total_u, usedU: capacity.used_u, reservedU: capacity.reserved_u, freeU: Math.max(0, capacity.total_u - capacity.used_u) },
      devicesByState: states,
      devicesByCategory: Object.fromEntries(byCategory.map((r) => [r.category, r.n])),
      warranty: { expired: warranty.expired, within90Days: warranty.within90, soonest: expiring },
      sparePartsLow: lowStock.n,
    };
  }

  /** Datacenter list for filters (cheap). */
  datacenterOptions(p: Principal) {
    return this.db.select({ id: datacenters.id, code: datacenters.code, name: datacenters.name }).from(datacenters).where(eq(datacenters.orgId, p.orgId)).orderBy(asc(datacenters.code));
  }

  /** Room list for filters and pickers. */
  roomOptions(p: Principal) {
    return this.db.select({ id: rooms.id, name: rooms.name, buildingId: rooms.buildingId }).from(rooms).where(eq(rooms.orgId, p.orgId)).orderBy(asc(rooms.name));
  }

  async lifecycleRules(p: Principal) {
    const rows = await this.db.select().from(lifecycleTransitions).where(eq(lifecycleTransitions.orgId, p.orgId));
    return { states: LIFECYCLE_STATES, transitions: rows.map((r) => [r.fromState, r.toState] as [LifecycleState, LifecycleState]) };
  }

  async setLifecycleRules(p: Principal, transitions: [LifecycleState, LifecycleState][], meta: RequestMeta) {
    const unique = [...new Map(transitions.filter(([a, b]) => a !== b).map((t) => [t.join('>'), t])).values()];
    const before = await this.lifecycleRules(p);
    await this.db.transaction(async (tx) => {
      await tx.delete(lifecycleTransitions).where(eq(lifecycleTransitions.orgId, p.orgId));
      if (unique.length) await tx.insert(lifecycleTransitions).values(unique.map(([fromState, toState]) => ({ orgId: p.orgId, fromState, toState })));
      await this.audit.record(
        { orgId: p.orgId, actor: actorFrom(p), action: 'lifecycle_rules.update', target: { type: 'organization', id: p.orgId }, outcome: 'success', meta, metadata: { before: before.transitions.length, after: unique.length } },
        tx,
      );
    });
    return this.lifecycleRules(p);
  }

  /** Rack count per room, used by the floor plan picker. */
  rackCounts(p: Principal) {
    return this.db.select({ roomId: racks.roomId, n: sql<number>`count(*)::int` }).from(racks).where(eq(racks.orgId, p.orgId)).groupBy(racks.roomId);
  }
}
