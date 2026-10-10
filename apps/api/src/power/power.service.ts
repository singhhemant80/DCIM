import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { DISTRIBUTION_CATEGORIES, POWERED_STATES, POWER_KINDS, type PowerPeriod, type PowerQuality } from '@crapplet/shared';
import type { z } from 'zod';
import type { outletMappingSchema, powerDeviceListQuerySchema, powerExportQuerySchema, powerPollingSchema, powerProfileSchema, powerSettingsSchema, tariffSchema } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { deviceCredentials, devices, pduOutlets, powerMonitoring, powerProfiles, powerSettings, powerTariffs } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import type { Principal, RequestMeta } from '../auth/principal';
import { notFound, ownDatacenter, ownDevice } from '../network/common';
import { toCsv } from '../dcim/csv';
import { currentPower, estimateFor, type EstimateKind, type PowerSource } from './energy';

const HOUR = 3600_000;
const powered = new Set<string>(POWERED_STATES);
const distribution = new Set<string>(DISTRIBUTION_CATEGORIES);

export interface DevicePowerNow {
  deviceId: string;
  name: string;
  assetTag: string;
  category: string;
  lifecycleState: string;
  customerId: string | null;
  customerName: string | null;
  rackId: string | null;
  rackName: string | null;
  datacenterId: string | null;
  datacenterCode: string | null;
  /** Counted in equipment totals: powered (or measured), included, not a PDU/UPS. */
  counted: boolean;
  watts: number | null;
  quality: PowerQuality;
  /** Measured source, or the kind of estimate ('admin', 'model'). */
  source: PowerSource | EstimateKind | null;
  at: string | null;
  estimateW: number | null;
  estimateKind: EstimateKind | null;
  polling: { credentialKind: string; enabled: boolean; lastOkAt: string | null; lastError: string | null; consecutiveFailures: number } | null;
}

export interface EnergyRow {
  key: string;
  measuredKwh: number;
  estimatedKwh: number;
  unknownHours: number;
  measuredHours: number;
  estimatedHours: number;
  cost: { currency: string; amount: number; estimatedPart: number }[];
  /** Hours with energy but no tariff in force (no cost computed for them). */
  unpricedKwh: number;
}

/**
 * Equipment power: current draw, energy and cost. Everything returned says
 * whether it is measured, estimated (and from what) or unknown; the three are
 * never blended into one unlabelled figure.
 *
 * Customers (power.read) see only devices assigned to them, without cost
 * (pricing is a billing matter, Phase 8) and without racks, PDUs or tariffs.
 */
@Injectable()
export class PowerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private record(p: Principal, meta: RequestMeta, action: string, target: { type: string; id: string }, metadata?: Record<string, unknown>, tx?: Parameters<AuditService['record']>[1]) {
    return this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action, target, outcome: 'success', meta, metadata }, tx);
  }

  private static scope(p: Principal, alias = 'd'): SQL {
    const a = sql.raw(alias);
    if (p.userType === 'staff') return sql`${a}.org_id = ${p.orgId}`;
    if (!p.customerId) return sql`false`;
    return sql`${a}.org_id = ${p.orgId} and ${a}.customer_id = ${p.customerId}`;
  }

  /**
   * Period boundaries. Rolling periods end now; calendar periods follow the
   * organization's time zone. Energy comes from hourly rows, so boundaries are
   * rounded down to whole hours (UTC); for a zone with a half-hour offset such
   * as Asia/Kolkata a month therefore starts at 18:00 UTC instead of 18:30.
   * Consecutive months still add up exactly.
   */
  async period(p: Principal, period: PowerPeriod): Promise<{ from: Date; to: Date; timezone: string; rounded: boolean }> {
    const r = await this.db.execute<{ tz: string; mstart: string; pstart: string }>(sql`
      with o as (select coalesce(nullif(settings->>'timezone', ''), 'Asia/Kolkata') as tz from organizations where id = ${p.orgId})
      select tz,
             (date_trunc('month', now() at time zone tz) at time zone tz) as mstart,
             (date_trunc('month', (now() at time zone tz) - interval '1 month') at time zone tz) as pstart
        from o`);
    const row = r.rows[0]!;
    const now = Date.now();
    const floor = (t: number) => Math.floor(t / HOUR) * HOUR;
    let from: number;
    let to = now;
    switch (period) {
      case '24h':
        from = now - 24 * HOUR;
        break;
      case '7d':
        from = now - 7 * 24 * HOUR;
        break;
      case '30d':
        from = now - 30 * 24 * HOUR;
        break;
      case 'mtd':
        from = new Date(row.mstart).getTime();
        break;
      case 'last_month':
        from = new Date(row.pstart).getTime();
        to = new Date(row.mstart).getTime();
        break;
    }
    const fromR = floor(from);
    const toR = period === 'last_month' ? floor(to) : to;
    return { from: new Date(fromR), to: new Date(toR), timezone: row.tz, rounded: fromR !== from || toR !== to };
  }

  /* ---------------------------------------------------------------- current draw */

  /** Current power of every device the principal may see (optionally narrowed). */
  async current(p: Principal, where: SQL = sql`true`): Promise<DevicePowerNow[]> {
    const devs = await this.db.execute<Record<string, unknown>>(sql`
      select d.id, coalesce(d.hostname, d.asset_tag) as name, d.asset_tag, d.category::text as category, d.lifecycle_state::text as lifecycle_state,
             d.customer_id, c.name as customer_name, d.rack_id, r.name as rack_name, b.datacenter_id, dc.code as datacenter_code,
             m.typical_power_w, pp.estimate_w, pp.include_in_totals,
             pm.credential_kind::text as poll_kind, pm.enabled as poll_enabled, pm.last_ok_at, pm.last_error, pm.consecutive_failures,
             exists (select 1 from pdu_outlets o where o.pdu_device_id = d.id) as feeds_outlets
        from devices d
        join device_models m on m.id = d.model_id
        left join customers c on c.id = d.customer_id
        left join power_profiles pp on pp.device_id = d.id
        left join power_monitoring pm on pm.device_id = d.id
        left join racks r on r.id = d.rack_id left join rooms rm on rm.id = r.room_id
        left join buildings b on b.id = rm.building_id left join datacenters dc on dc.id = b.datacenter_id
       where ${PowerService.scope(p)} and d.lifecycle_state <> 'retired' and ${where}
       order by name`);
    const ids = devs.rows.map((d) => d.id as string);
    const latest = new Map<string, { source: PowerSource; at: number; watts: number }[]>();
    if (ids.length) {
      // Newest reading per device and source, only while it is fresh (3 polling periods).
      const rs = await this.db.execute<{ device_id: string; source: PowerSource; at: string; watts: number }>(sql`
        select distinct on (device_id, source) device_id, source::text as source, at, watts
          from power_readings
         where org_id = ${p.orgId} and at > now() - interval '3 hours' and at > now() - make_interval(secs => 3 * period_seconds)
           and device_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
         order by device_id, source, at desc`);
      for (const r of rs.rows) {
        const list = latest.get(r.device_id) ?? [];
        list.push({ source: r.source, at: new Date(r.at).getTime(), watts: Number(r.watts) });
        latest.set(r.device_id, list);
      }
    }
    const now = Date.now();
    const staff = p.userType === 'staff';
    return devs.rows.map((d) => {
      const isPowered = powered.has(d.lifecycle_state as string);
      const est = isPowered ? estimateFor(d.estimate_w as number | null, d.typical_power_w as number | null) : { estimateW: null, estimateKind: null };
      const cur = currentPower({ latest: latest.get(d.id as string) ?? [], now, staleSeconds: 3 * 3600, estimateW: est.estimateW, estimateKind: est.estimateKind });
      // Equipment that isn't in a powered state and has no measurement is "not powered", not unknown.
      const quality: PowerQuality = !isPowered && cur.quality !== 'measured' ? 'off' : cur.quality;
      return {
        deviceId: d.id as string,
        name: d.name as string,
        assetTag: d.asset_tag as string,
        category: d.category as string,
        lifecycleState: d.lifecycle_state as string,
        customerId: (d.customer_id as string | null) ?? null,
        customerName: (d.customer_name as string | null) ?? null,
        // Infrastructure location and collection details are staff information.
        rackId: staff ? ((d.rack_id as string | null) ?? null) : null,
        rackName: staff ? ((d.rack_name as string | null) ?? null) : null,
        datacenterId: staff ? ((d.datacenter_id as string | null) ?? null) : null,
        datacenterCode: staff ? ((d.datacenter_code as string | null) ?? null) : null,
        // A device that distributes power to outlets (a PDU in any category) is never counted as load.
        counted: (isPowered || cur.quality === 'measured') && d.include_in_totals !== false && !distribution.has(d.category as string) && !d.feeds_outlets,
        watts: quality === 'off' ? null : cur.watts,
        quality,
        source: quality === 'off' ? null : cur.source,
        at: cur.at ? new Date(cur.at).toISOString() : null,
        estimateW: est.estimateW,
        estimateKind: est.estimateKind,
        polling: staff && d.poll_kind
          ? { credentialKind: d.poll_kind as string, enabled: d.poll_enabled as boolean, lastOkAt: (d.last_ok_at as string | null) ?? null, lastError: (d.last_error as string | null) ?? null, consecutiveFailures: d.consecutive_failures as number }
          : null,
      };
    });
  }

  static totalsOf(list: DevicePowerNow[]) {
    const counted = list.filter((d) => d.counted);
    const sum = (q: PowerQuality) => counted.filter((d) => d.quality === q).reduce((a, d) => a + (d.watts ?? 0), 0);
    return {
      measuredW: sum('measured'),
      estimatedW: sum('estimated'),
      devices: counted.length,
      measuredDevices: counted.filter((d) => d.quality === 'measured').length,
      estimatedDevices: counted.filter((d) => d.quality === 'estimated').length,
      unknownDevices: counted.filter((d) => d.quality === 'unknown').length,
    };
  }

  /* ---------------------------------------------------------------- energy */

  /** Energy (and, for staff, cost) per group over [from, to) from the hourly rows. */
  async energy(p: Principal, from: Date, to: Date, groupBy: 'device' | 'rack' | 'datacenter' | 'customer' | 'category' | 'all', where: SQL = sql`true`, countedOnly = true): Promise<Map<string, EnergyRow>> {
    const key = { device: sql`h.device_id::text`, rack: sql`coalesce(h.rack_id::text, '')`, datacenter: sql`coalesce(h.datacenter_id::text, '')`, customer: sql`coalesce(h.customer_id::text, '')`, category: sql`h.category`, all: sql`'all'` }[groupBy];
    const scope = p.userType === 'staff' ? sql`h.org_id = ${p.orgId}` : p.customerId ? sql`h.org_id = ${p.orgId} and h.customer_id = ${p.customerId}` : sql`false`;
    const r = await this.db.execute<{ k: string; currency: string | null; mwh: number; ewh: number; unknown_s: number; measured_s: number; estimated_s: number; cost: number | null; ecost: number | null }>(sql`
      select ${key} as k, t.currency,
             sum(h.measured_wh) as mwh, sum(h.estimated_wh) as ewh, sum(h.unknown_seconds)::bigint as unknown_s,
             sum(h.measured_seconds)::bigint as measured_s, sum(h.estimated_seconds)::bigint as estimated_s,
             sum((h.measured_wh + h.estimated_wh) / 1000 * t.price) as cost, sum(h.estimated_wh / 1000 * t.price) as ecost
        from power_hourly h
        left join lateral (
          select pt.currency, pt.price_per_kwh::float8 as price from power_tariffs pt
           where pt.org_id = h.org_id and (pt.datacenter_id = h.datacenter_id or pt.datacenter_id is null) and pt.valid_from <= h.hour
           order by (pt.datacenter_id is null), pt.valid_from desc limit 1) t on true
       where ${scope} and h.hour >= ${from.toISOString()}::timestamptz and h.hour < ${to.toISOString()}::timestamptz
         and ${countedOnly ? sql`h.counted` : sql`true`} and ${where}
       group by 1, 2`);
    const out = new Map<string, EnergyRow>();
    for (const x of r.rows) {
      const e = out.get(x.k) ?? { key: x.k, measuredKwh: 0, estimatedKwh: 0, unknownHours: 0, measuredHours: 0, estimatedHours: 0, cost: [], unpricedKwh: 0 };
      e.measuredKwh += Number(x.mwh) / 1000;
      e.estimatedKwh += Number(x.ewh) / 1000;
      e.unknownHours += Number(x.unknown_s) / 3600;
      e.measuredHours += Number(x.measured_s) / 3600;
      e.estimatedHours += Number(x.estimated_s) / 3600;
      if (x.currency && p.userType === 'staff') e.cost.push({ currency: x.currency, amount: Number(x.cost ?? 0), estimatedPart: Number(x.ecost ?? 0) });
      else if (!x.currency && p.userType === 'staff') e.unpricedKwh += (Number(x.mwh) + Number(x.ewh)) / 1000;
      out.set(x.k, e);
    }
    return out;
  }

  /* ---------------------------------------------------------------- views */

  async summary(p: Principal, period: PowerPeriod, datacenterId?: string) {
    if (datacenterId) await ownDatacenter(this.db, p, datacenterId);
    const dcFilter = datacenterId ? sql`b.datacenter_id = ${datacenterId}` : sql`true`;
    const list = await this.current(p, dcFilter);
    const per = await this.period(p, period);
    const hFilter = datacenterId ? sql`h.datacenter_id = ${datacenterId}` : sql`true`;
    const [all, byDc, byCat] = await Promise.all([
      this.energy(p, per.from, per.to, 'all', hFilter),
      p.userType === 'staff' ? this.energy(p, per.from, per.to, 'datacenter', hFilter) : Promise.resolve(new Map<string, EnergyRow>()),
      this.energy(p, per.from, per.to, 'category', hFilter),
    ]);
    const group = <K extends string>(keyOf: (d: DevicePowerNow) => K) => {
      const m = new Map<K, DevicePowerNow[]>();
      for (const d of list) m.set(keyOf(d), [...(m.get(keyOf(d)) ?? []), d]);
      return m;
    };
    const dcs = group((d) => d.datacenterId ?? '');
    const cats = group((d) => d.category);
    return {
      period: { name: period, from: per.from, to: per.to, timezone: per.timezone, roundedToHours: per.rounded },
      now: PowerService.totalsOf(list),
      energy: all.get('all') ?? null,
      byDatacenter:
        p.userType === 'staff'
          ? [...dcs.entries()].map(([id, ds]) => ({ datacenterId: id || null, datacenterCode: ds[0]?.datacenterCode ?? null, now: PowerService.totalsOf(ds), energy: byDc.get(id) ?? null }))
          : [],
      byCategory: [...cats.entries()].map(([c, ds]) => ({ category: c, now: PowerService.totalsOf(ds), energy: byCat.get(c) ?? null })).filter((x) => x.now.devices > 0 || x.energy),
      top: list
        .filter((d) => d.counted && d.watts !== null)
        .sort((a, b) => (b.watts ?? 0) - (a.watts ?? 0))
        .slice(0, 8),
    };
  }

  async devices(p: Principal, q: z.infer<typeof powerDeviceListQuerySchema>) {
    const conds: SQL[] = [sql`true`];
    if (q.q) conds.push(sql`(d.hostname ilike ${'%' + q.q + '%'} or d.asset_tag ilike ${'%' + q.q + '%'})`);
    if (q.datacenterId) conds.push(sql`b.datacenter_id = ${q.datacenterId}`);
    if (q.rackId) conds.push(sql`d.rack_id = ${q.rackId}`);
    let list = await this.current(p, sql.join(conds, sql` and `));
    if (q.quality) list = list.filter((d) => d.quality === q.quality);
    const per = await this.period(p, q.period);
    const energy = await this.energy(p, per.from, per.to, 'device', sql`true`, false);
    const kwh = (id: string) => {
      const e = energy.get(id);
      return e ? e.measuredKwh + e.estimatedKwh : 0;
    };
    list.sort((a, b) => (q.sort === 'name' ? a.name.localeCompare(b.name) : q.sort === 'energy' ? kwh(b.deviceId) - kwh(a.deviceId) : (b.watts ?? -1) - (a.watts ?? -1)));
    const total = list.length;
    const page = list.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    return { items: page.map((d) => ({ ...d, energy: energy.get(d.deviceId) ?? null })), page: q.page, pageSize: q.pageSize, total, period: { name: q.period, from: per.from, to: per.to } };
  }

  async device(p: Principal, id: string) {
    const [d] = await this.current(p, sql`d.id = ${id}`);
    if (!d) throw notFound('Device');
    const [spec] = (
      await this.db.execute<{ typical_power_w: number | null; idle_power_w: number | null; max_power_w: number | null; psu_count: number | null; psu_rated_w: number | null }>(
        sql`select m.typical_power_w, m.idle_power_w, m.max_power_w, m.psu_count, m.psu_rated_w from devices d join device_models m on m.id = d.model_id where d.id = ${id}`,
      )
    ).rows;
    const [profile] = await this.db.select().from(powerProfiles).where(eq(powerProfiles.deviceId, id));
    const staff = p.userType === 'staff';
    const sources = await this.db.execute<{ source: string; at: string; watts: number; period_seconds: number }>(sql`
      select distinct on (source) source::text as source, at, watts, period_seconds from power_readings
       where device_id = ${id} ${staff ? sql`` : sql`and at > now() - interval '3 hours'`} order by source, at desc`);
    const outlets = staff
      ? (
          await this.db.execute<Record<string, unknown>>(sql`
            select o.id, o.outlet_number, o.name, o.label, o.last_watts, o.last_at, o.pdu_device_id, coalesce(pd.hostname, pd.asset_tag) as pdu_name
              from pdu_outlets o join devices pd on pd.id = o.pdu_device_id where o.device_id = ${id} order by pdu_name, o.outlet_number`)
        ).rows
      : [];
    const credentialKinds = staff ? (await this.db.select({ kind: deviceCredentials.kind }).from(deviceCredentials).where(eq(deviceCredentials.deviceId, id))).map((c) => c.kind).filter((k) => (POWER_KINDS as readonly string[]).includes(k)) : [];
    return {
      ...d,
      spec: spec ? { typicalW: spec.typical_power_w, idleW: spec.idle_power_w, maxW: spec.max_power_w, psuCount: spec.psu_count, psuRatedW: spec.psu_rated_w } : null,
      profile: profile ? { estimateW: profile.estimateW, includeInTotals: profile.includeInTotals, notes: staff ? profile.notes : null } : null,
      sources: sources.rows.map((s) => ({ source: s.source, at: s.at, watts: Number(s.watts), fresh: Date.now() - new Date(s.at).getTime() <= 3 * s.period_seconds * 1000 })),
      outlets,
      credentialKinds,
    };
  }

  /** History: raw readings per source (24 h) or hourly averages split by quality (7 d, 30 d). */
  async history(p: Principal, id: string, range: '24h' | '7d' | '30d') {
    const [d] = await this.current(p, sql`d.id = ${id}`);
    if (!d) throw notFound('Device');
    const since = new Date(Date.now() - { '24h': 24, '7d': 168, '30d': 720 }[range] * HOUR);
    // Customers only see hours in which the device was theirs (it may have had another customer before).
    const mine = p.userType === 'staff' ? sql`true` : sql`customer_id = ${p.customerId}`;
    const hourly = await this.db.execute<Record<string, unknown>>(sql`
      select hour, source::text as source, measured_wh, measured_seconds, estimated_wh, estimated_seconds, estimate_kind, unknown_seconds, avg_measured_w, max_measured_w
        from power_hourly where device_id = ${id} and hour >= ${since.toISOString()}::timestamptz and ${mine} order by hour`);
    const raw =
      range === '24h'
        ? (
            await this.db.execute<{ source: string; at: string; watts: number }>(sql`
              select r.source::text as source, r.at, r.watts from power_readings r
               where r.device_id = ${id} and r.at >= ${since.toISOString()}::timestamptz
                 and ${p.userType === 'staff' ? sql`true` : sql`exists (select 1 from power_hourly h where h.device_id = r.device_id and h.hour = date_trunc('hour', r.at) and h.customer_id = ${p.customerId})`}
               order by r.at`)
          ).rows.map((r) => ({ source: r.source, at: r.at, watts: Number(r.watts) }))
        : [];
    return {
      range,
      device: d,
      raw,
      hourly: hourly.rows.map((h) => ({
        hour: h.hour,
        source: h.source ?? null,
        avgMeasuredW: h.avg_measured_w === null ? null : Number(h.avg_measured_w),
        maxMeasuredW: h.max_measured_w === null ? null : Number(h.max_measured_w),
        measuredKwh: Number(h.measured_wh) / 1000,
        measuredSeconds: Number(h.measured_seconds),
        estimatedKwh: Number(h.estimated_wh) / 1000,
        estimatedSeconds: Number(h.estimated_seconds),
        estimateKind: h.estimate_kind ?? null,
        unknownSeconds: Number(h.unknown_seconds),
      })),
    };
  }

  /** Racks: current draw against the rack's power budget, and the measured input of PDUs installed in it. */
  async racks(p: Principal, datacenterId?: string) {
    if (datacenterId) await ownDatacenter(this.db, p, datacenterId);
    const racks = await this.db.execute<{ id: string; name: string; max_power_w: number | null; datacenter_id: string; datacenter_code: string; room_name: string }>(sql`
      select r.id, r.name, r.max_power_w, b.datacenter_id, dc.code as datacenter_code, rm.name as room_name
        from racks r join rooms rm on rm.id = r.room_id join buildings b on b.id = rm.building_id join datacenters dc on dc.id = b.datacenter_id
       where r.org_id = ${p.orgId} ${datacenterId ? sql`and b.datacenter_id = ${datacenterId}` : sql``}
       order by dc.code, rm.name, r.name`);
    const list = await this.current(p, sql`d.rack_id is not null`);
    return racks.rows.map((r) => {
      const ds = list.filter((d) => d.rackId === r.id);
      const t = PowerService.totalsOf(ds);
      // A PDU's own reading is the power entering the rack through it: shown separately, never added to equipment.
      const pdus = ds.filter((d) => distribution.has(d.category) && d.quality === 'measured');
      const pduInputW = pdus.length ? pdus.reduce((a, d) => a + (d.watts ?? 0), 0) : null;
      const load = t.measuredW + t.estimatedW;
      return {
        rackId: r.id,
        name: r.name,
        roomName: r.room_name,
        datacenterId: r.datacenter_id,
        datacenterCode: r.datacenter_code,
        maxPowerW: r.max_power_w,
        now: t,
        pduInputW,
        pduCount: pdus.length,
        budgetUsedPct: r.max_power_w ? Math.round((load / r.max_power_w) * 1000) / 10 : null,
      };
    });
  }

  /* ---------------------------------------------------------------- configuration */

  async setProfile(p: Principal, deviceId: string, input: z.infer<typeof powerProfileSchema>, meta: RequestMeta) {
    await ownDevice(this.db, p, deviceId);
    return this.db.transaction(async (tx) => {
      const values = { estimateW: input.estimateW, includeInTotals: input.includeInTotals, notes: input.notes ?? null };
      const [row] = await tx.insert(powerProfiles).values({ deviceId, orgId: p.orgId, ...values }).onConflictDoUpdate({ target: powerProfiles.deviceId, set: values }).returning();
      await this.record(p, meta, 'power.profile', { type: 'device', id: deviceId }, { estimateW: input.estimateW, includeInTotals: input.includeInTotals }, tx);
      return row;
    });
  }

  async polling(p: Principal) {
    const r = await this.db.execute<Record<string, unknown>>(sql`
      select d.id as device_id, coalesce(d.hostname, d.asset_tag) as device_name, d.category::text as category,
             pm.enabled, pm.credential_kind::text as credential_kind, pm.interval_seconds, pm.last_poll_at, pm.last_ok_at, pm.last_error,
             pm.consecutive_failures, pm.last_duration_ms, pm.last_watts,
             (select array_agg(c.kind::text order by c.kind) from device_credentials c where c.device_id = d.id and c.kind::text in (${sql.join(
               POWER_KINDS.map((k) => sql`${k}`),
               sql`, `,
             )})) as kinds,
             (select count(*)::int from pdu_outlets o where o.pdu_device_id = d.id) as outlets
        from devices d left join power_monitoring pm on pm.device_id = d.id
       where d.org_id = ${p.orgId} and (pm.device_id is not null or exists (select 1 from device_credentials c where c.device_id = d.id and c.kind::text in (${sql.join(
         POWER_KINDS.map((k) => sql`${k}`),
         sql`, `,
       )})))
       order by device_name`);
    return r.rows.map((x) => ({
      deviceId: x.device_id,
      deviceName: x.device_name,
      category: x.category,
      configured: x.credential_kind !== null,
      enabled: x.enabled ?? false,
      credentialKind: x.credential_kind ?? null,
      intervalSeconds: x.interval_seconds ?? null,
      lastPollAt: x.last_poll_at ?? null,
      lastOkAt: x.last_ok_at ?? null,
      lastError: x.last_error ?? null,
      consecutiveFailures: x.consecutive_failures ?? 0,
      lastDurationMs: x.last_duration_ms ?? null,
      lastWatts: x.last_watts === null || x.last_watts === undefined ? null : Number(x.last_watts),
      credentialKinds: (x.kinds as string[] | null) ?? [],
      outlets: x.outlets,
    }));
  }

  async configurePolling(p: Principal, deviceId: string, input: z.infer<typeof powerPollingSchema>, meta: RequestMeta) {
    await ownDevice(this.db, p, deviceId);
    const [cred] = await this.db
      .select({ id: deviceCredentials.id })
      .from(deviceCredentials)
      .where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, input.credentialKind), eq(deviceCredentials.orgId, p.orgId)));
    if (!cred) throw new BadRequestException({ error: 'no_credential', message: `Store a ${input.credentialKind} credential for this device first` });
    return this.db.transaction(async (tx) => {
      const values = { enabled: input.enabled, credentialKind: input.credentialKind, intervalSeconds: input.intervalSeconds, nextPollAt: input.enabled ? new Date() : null };
      const [row] = await tx
        .insert(powerMonitoring)
        .values({ deviceId, orgId: p.orgId, ...values })
        .onConflictDoUpdate({ target: powerMonitoring.deviceId, set: { ...values, consecutiveFailures: 0, lastError: null } })
        .returning();
      await this.record(p, meta, 'power.polling', { type: 'device', id: deviceId }, { ...input }, tx);
      return row;
    });
  }

  async removePolling(p: Principal, deviceId: string, meta: RequestMeta) {
    await ownDevice(this.db, p, deviceId);
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(powerMonitoring).where(and(eq(powerMonitoring.deviceId, deviceId), eq(powerMonitoring.orgId, p.orgId))).returning();
      if (!rows.length) throw notFound('Power collection');
      await this.record(p, meta, 'power.polling_remove', { type: 'device', id: deviceId }, undefined, tx);
      return { ok: true };
    });
  }

  /* ---------------------------------------------------------------- PDUs */

  async pdus(p: Principal) {
    const pdus = await this.db.execute<Record<string, unknown>>(sql`
      select d.id, coalesce(d.hostname, d.asset_tag) as name, d.category::text as category, r.name as rack_name, pm.last_ok_at, pm.last_watts, pm.interval_seconds
        from devices d left join racks r on r.id = d.rack_id left join power_monitoring pm on pm.device_id = d.id
       where d.org_id = ${p.orgId} and (d.category = 'pdu' or exists (select 1 from pdu_outlets o where o.pdu_device_id = d.id))
       order by name`);
    const outlets = await this.db.execute<Record<string, unknown>>(sql`
      select o.id, o.pdu_device_id, o.outlet_number, o.name, o.label, o.device_id, coalesce(t.hostname, t.asset_tag) as device_name, o.last_watts, o.last_at
        from pdu_outlets o left join devices t on t.id = o.device_id where o.org_id = ${p.orgId} order by o.pdu_device_id, o.outlet_number`);
    return pdus.rows.map((d) => {
      const interval = Number(d.interval_seconds ?? 300);
      return {
        deviceId: d.id,
        name: d.name,
        rackName: d.rack_name ?? null,
        lastOkAt: d.last_ok_at ?? null,
        inputW: d.last_watts === null || d.last_watts === undefined ? null : Number(d.last_watts),
        outlets: outlets.rows
          .filter((o) => o.pdu_device_id === d.id)
          .map((o) => ({
            id: o.id,
            number: o.outlet_number,
            name: o.name ?? null,
            label: o.label ?? null,
            deviceId: o.device_id ?? null,
            deviceName: o.device_name ?? null,
            watts: o.last_watts === null ? null : Number(o.last_watts),
            at: o.last_at ?? null,
            fresh: !!o.last_at && Date.now() - new Date(o.last_at as string).getTime() <= 3 * interval * 1000,
          })),
      };
    });
  }

  async mapOutlet(p: Principal, outletId: string, input: z.infer<typeof outletMappingSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [o] = await tx.select().from(pduOutlets).where(and(eq(pduOutlets.id, outletId), eq(pduOutlets.orgId, p.orgId))).for('update');
      if (!o) throw notFound('Outlet');
      if (input.deviceId) {
        const d = await ownDevice(tx, p, input.deviceId);
        if (d.id === o.pduDeviceId) throw new BadRequestException({ error: 'invalid_device', message: 'A PDU cannot feed itself' });
        if ((DISTRIBUTION_CATEGORIES as readonly string[]).includes(d.category)) throw new BadRequestException({ error: 'invalid_device', message: 'Map outlets to the equipment they feed, not to another PDU or UPS' });
      }
      const [row] = await tx
        .update(pduOutlets)
        .set({ deviceId: input.deviceId, label: input.label ?? o.label })
        .where(eq(pduOutlets.id, outletId))
        .returning();
      await this.record(p, meta, 'power.outlet_map', { type: 'pdu_outlet', id: outletId }, { pduDeviceId: o.pduDeviceId, outlet: o.outletNumber, deviceId: input.deviceId, previousDeviceId: o.deviceId }, tx);
      return row;
    });
  }

  /* ---------------------------------------------------------------- tariffs and settings */

  async tariffs(p: Principal) {
    const rows = await this.db.execute<Record<string, unknown>>(sql`
      select t.*, dc.code as datacenter_code from power_tariffs t left join datacenters dc on dc.id = t.datacenter_id where t.org_id = ${p.orgId} order by dc.code nulls first, t.valid_from desc`);
    return rows.rows.map((t) => ({ id: t.id, name: t.name, datacenterId: t.datacenter_id ?? null, datacenterCode: t.datacenter_code ?? null, currency: t.currency, pricePerKwh: Number(t.price_per_kwh), validFrom: t.valid_from, notes: t.notes ?? null }));
  }

  private async tariffValues(p: Principal, t: z.infer<typeof tariffSchema>) {
    if (t.datacenterId) await ownDatacenter(this.db, p, t.datacenterId);
    return { name: t.name, datacenterId: t.datacenterId ?? null, currency: t.currency, pricePerKwh: String(t.pricePerKwh), validFrom: new Date(t.validFrom), notes: t.notes ?? null };
  }

  async createTariff(p: Principal, t: z.infer<typeof tariffSchema>, meta: RequestMeta) {
    const values = await this.tariffValues(p, t);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(powerTariffs).values({ ...values, orgId: p.orgId }).returning();
      await this.record(p, meta, 'power.tariff_create', { type: 'power_tariff', id: row!.id }, { name: t.name, currency: t.currency, pricePerKwh: t.pricePerKwh, validFrom: t.validFrom, datacenterId: t.datacenterId ?? null }, tx);
      return row;
    });
  }

  async updateTariff(p: Principal, id: string, t: z.infer<typeof tariffSchema>, meta: RequestMeta) {
    const values = await this.tariffValues(p, t);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(powerTariffs).set(values).where(and(eq(powerTariffs.id, id), eq(powerTariffs.orgId, p.orgId))).returning();
      if (!row) throw notFound('Tariff');
      await this.record(p, meta, 'power.tariff_update', { type: 'power_tariff', id }, { name: t.name, currency: t.currency, pricePerKwh: t.pricePerKwh, validFrom: t.validFrom }, tx);
      return row;
    });
  }

  async deleteTariff(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(powerTariffs).where(and(eq(powerTariffs.id, id), eq(powerTariffs.orgId, p.orgId))).returning();
      if (!rows.length) throw notFound('Tariff');
      await this.record(p, meta, 'power.tariff_delete', { type: 'power_tariff', id }, { name: rows[0]!.name }, tx);
      return { ok: true };
    });
  }

  async settings(p: Principal) {
    const [s] = await this.db.select().from(powerSettings).where(eq(powerSettings.orgId, p.orgId));
    return { rawDays: s?.rawDays ?? 35, hourlyDays: s?.hourlyDays ?? 1095 };
  }

  async updateSettings(p: Principal, input: z.infer<typeof powerSettingsSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      await tx.insert(powerSettings).values({ orgId: p.orgId, ...input }).onConflictDoUpdate({ target: powerSettings.orgId, set: input });
      await this.record(p, meta, 'power.settings', { type: 'organization', id: p.orgId }, { ...input }, tx);
      return input;
    });
  }

  /* ---------------------------------------------------------------- export */

  /** Energy grouped by device, rack, datacenter, customer or category, with names, largest first. */
  async energyReport(p: Principal, q: z.infer<typeof powerExportQuerySchema>) {
    if (p.userType !== 'staff' && q.groupBy !== 'device' && q.groupBy !== 'category') throw new BadRequestException({ error: 'not_applicable', message: 'Group your energy by device or category' });
    const per = await this.period(p, q.period);
    const energy = await this.energy(p, per.from, per.to, q.groupBy, sql`true`, q.groupBy !== 'device');
    const names = new Map<string, string>();
    const table = {
      device: sql`select id::text as id, coalesce(hostname, asset_tag) as n from devices where org_id = ${p.orgId}`,
      rack: sql`select id::text as id, name as n from racks where org_id = ${p.orgId}`,
      datacenter: sql`select id::text as id, code as n from datacenters where org_id = ${p.orgId}`,
      customer: sql`select id::text as id, name as n from customers where org_id = ${p.orgId}`,
      category: null,
    }[q.groupBy];
    if (table) for (const r of (await this.db.execute<{ id: string; n: string }>(table)).rows) names.set(r.id, r.n);
    const rows = [...energy.values()]
      .map((e) => ({ ...e, name: names.get(e.key) ?? (e.key || null), totalKwh: e.measuredKwh + e.estimatedKwh }))
      .sort((a, b) => b.totalKwh - a.totalKwh);
    return { period: { name: q.period, from: per.from, to: per.to, timezone: per.timezone, roundedToHours: per.rounded }, groupBy: q.groupBy, rows };
  }

  async exportCsv(p: Principal, q: z.infer<typeof powerExportQuerySchema>): Promise<string> {
    const r = await this.energyReport(p, q);
    const staff = p.userType === 'staff';
    const headers = [q.groupBy, 'from', 'to', 'measured_kwh', 'estimated_kwh', 'total_kwh', 'measured_hours', 'estimated_hours', 'unknown_hours', ...(staff ? ['cost', 'currency', 'cost_from_estimates', 'unpriced_kwh'] : [])];
    const rows: unknown[][] = [];
    for (const e of r.rows) {
      const base = [e.name ?? '(none)', r.period.from.toISOString(), r.period.to.toISOString(), e.measuredKwh.toFixed(3), e.estimatedKwh.toFixed(3), e.totalKwh.toFixed(3), e.measuredHours.toFixed(2), e.estimatedHours.toFixed(2), e.unknownHours.toFixed(2)];
      if (!staff) rows.push(base);
      else if (!e.cost.length) rows.push([...base, '', '', '', e.unpricedKwh.toFixed(3)]);
      else for (const c of e.cost) rows.push([...base, c.amount.toFixed(2), c.currency, c.estimatedPart.toFixed(2), e.unpricedKwh.toFixed(3)]);
    }
    return toCsv(headers, rows);
  }

  /** Assert a device exists in the caller's scope (customers: their own). */
  async visibleDevice(p: Principal, id: string) {
    const [d] = await this.db.select({ id: devices.id, customerId: devices.customerId }).from(devices).where(and(eq(devices.id, id), eq(devices.orgId, p.orgId)));
    if (!d || (p.userType !== 'staff' && d.customerId !== p.customerId)) throw notFound('Device');
  }
}
