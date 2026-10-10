import { sql } from 'drizzle-orm';
import { DISTRIBUTION_CATEGORIES, POWERED_STATES } from '@crapplet/shared';
import type { Db, DbOrTx } from '../../db/db';
import { estimateFor, windowEnergy, type EstimateKind, type PowerReading, type PowerSource } from '../../power/energy';

const HOUR = 3600_000;
const floorHour = (t: number) => Math.floor(t / HOUR) * HOUR;

type DeviceRow = {
  id: string;
  category: string;
  lifecycle_state: string;
  customer_id: string | null;
  rack_id: string | null;
  datacenter_id: string | null;
  typical_power_w: number | null;
  estimate_w: number | null;
  include_in_totals: boolean | null;
  created_at: string;
  feeds_outlets: boolean;
};

type ExistingRow = {
  device_id: string;
  hour: string;
  datacenter_id: string | null;
  rack_id: string | null;
  customer_id: string | null;
  category: string;
  counted: boolean;
  estimate_w: number | null;
  estimate_kind: string | null;
};

interface Series {
  rs: PowerReading[];
  period: number;
}

/** Readings of a sorted series that can touch [from, to) (one join length either side). */
function slice(s: Series, from: number, to: number): PowerReading[] {
  const pad = 3 * s.period * 1000;
  let lo = 0;
  let hi = s.rs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s.rs[mid]!.at < from - pad) lo = mid + 1;
    else hi = mid;
  }
  const out: PowerReading[] = [];
  for (let i = lo; i < s.rs.length && s.rs[i]!.at <= to + pad; i++) out.push(s.rs[i]!);
  return out;
}

/**
 * Builds hourly energy rows (measured / estimated / unknown kept apart).
 *
 *  - Runs over the last `lookbackHours` (default 2, so the current and the
 *    previous hour) or, after downtime, from the stored progress mark, at most
 *    `maxHoursPerRun` hours per run (default 24) so catch-up is bounded.
 *  - Each source joins readings at most 3 of its own polling periods apart.
 *  - An hour is first computed while it is current. When it is recomputed later
 *    (late readings), it keeps the device attributes and the estimate it had
 *    then: changing a device's customer, rack, state or estimate never rewrites
 *    closed hours. Estimates never start before the device existed.
 *  - One organization at a time, upserted (no delete-and-reinsert of the whole
 *    window). Only one worker runs it at a time (try-lock); others skip.
 */
export async function rollupPower(db: Db, now: Date = new Date(), opts: { lookbackHours?: number; maxCatchUpHours?: number; maxHoursPerRun?: number } = {}): Promise<{ hours: number; rows: number; skipped?: boolean }> {
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended('cdcim:power-rollup', 0)) as ok`);
    if (!lock.rows[0]?.ok) return { hours: 0, rows: 0, skipped: true };
    const nowMs = now.getTime();
    const st = await tx.execute<{ rolled_to: string }>(sql`select rolled_to from power_rollup_state where id = 1`);
    const normalFrom = floorHour(nowMs) - (opts.lookbackHours ?? 2) * HOUR;
    const floorFrom = floorHour(nowMs) - (opts.maxCatchUpHours ?? 35 * 24) * HOUR;
    const mark = st.rows[0] ? new Date(st.rows[0].rolled_to).getTime() : null;
    const from = Math.max(floorFrom, mark === null ? normalFrom : Math.min(normalFrom, mark));
    const to = Math.min(nowMs, floorHour(from) + (opts.maxHoursPerRun ?? 24) * HOUR);
    if (from >= to) return { hours: 0, rows: 0 };
    const orgs = (await tx.execute<{ id: string }>(sql`select id from organizations`)).rows;
    let rows = 0;
    for (const o of orgs) rows += await rollupOrg(tx, o.id, floorHour(from), to, nowMs);
    // Progress: everything before the start of the last (possibly partial) hour is done.
    const done = new Date(floorHour(to)).toISOString();
    await tx.execute(sql`insert into power_rollup_state (id, rolled_to) values (1, ${done}::timestamptz) on conflict (id) do update set rolled_to = excluded.rolled_to`);
    return { hours: Math.ceil((to - floorHour(from)) / HOUR), rows };
  });
}

async function rollupOrg(tx: DbOrTx, orgId: string, from: number, to: number, nowMs: number): Promise<number> {
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(to).toISOString();
  const devices = (
    await tx.execute<DeviceRow>(sql`
      select d.id, d.category::text, d.lifecycle_state::text, d.customer_id, d.rack_id, b.datacenter_id, d.created_at,
             m.typical_power_w, p.estimate_w, p.include_in_totals,
             exists (select 1 from pdu_outlets o where o.pdu_device_id = d.id) as feeds_outlets
        from devices d
        join device_models m on m.id = d.model_id
        left join power_profiles p on p.device_id = d.id
        left join racks r on r.id = d.rack_id left join rooms rm on rm.id = r.room_id left join buildings b on b.id = rm.building_id
       where d.org_id = ${orgId}`)
  ).rows;
  if (!devices.length) return 0;
  const byId = new Map(devices.map((d) => [d.id, d]));
  const readings = (
    await tx.execute<{ device_id: string; source: PowerSource; at: string; watts: number; period_seconds: number }>(sql`
      select device_id, source::text as source, at, watts, period_seconds from power_readings
       where org_id = ${orgId} and at >= ${new Date(from - 3 * HOUR).toISOString()}::timestamptz and at <= ${new Date(to + 3 * HOUR).toISOString()}::timestamptz
       order by device_id, source, at`)
  ).rows;
  const series = new Map<string, Map<PowerSource, Series>>();
  for (const r of readings) {
    let dev = series.get(r.device_id);
    if (!dev) series.set(r.device_id, (dev = new Map()));
    let s = dev.get(r.source);
    if (!s) dev.set(r.source, (s = { rs: [], period: 60 }));
    s.rs.push({ at: new Date(r.at).getTime(), watts: Number(r.watts) });
    s.period = Math.max(s.period, r.period_seconds);
  }
  const existing = new Map<string, ExistingRow>();
  for (const e of (
    await tx.execute<ExistingRow>(sql`
      select device_id, hour, datacenter_id, rack_id, customer_id, category, counted, estimate_w, estimate_kind
        from power_hourly where org_id = ${orgId} and hour >= ${fromIso}::timestamptz and hour < ${toIso}::timestamptz`)
  ).rows)
    existing.set(`${e.device_id}|${new Date(e.hour).getTime()}`, e);

  const powered = new Set<string>(POWERED_STATES);
  const distribution = new Set<string>(DISTRIBUTION_CATEGORIES);
  const out: Record<string, unknown>[] = [];
  for (let h = from; h < to; h += HOUR) {
    const end = Math.min(h + HOUR, to);
    const closed = h + HOUR <= nowMs;
    const candidates = new Set<string>();
    for (const d of devices) if (powered.has(d.lifecycle_state)) candidates.add(d.id);
    for (const [id, srcs] of series) for (const s of srcs.values()) if (slice(s, h, end).length) candidates.add(id);
    for (const k of existing.keys()) if (k.endsWith(`|${h}`)) candidates.add(k.slice(0, k.indexOf('|')));
    for (const id of candidates) {
      const d = byId.get(id);
      if (!d) continue;
      const created = new Date(d.created_at).getTime();
      if (created >= end) continue;
      const start = Math.max(h, floorHour(created) === h ? created : h);
      const prev = closed ? existing.get(`${id}|${h}`) : undefined;
      // A closed hour keeps the estimate and attributes it was first computed with.
      const est: { estimateW: number | null; estimateKind: EstimateKind | null } = prev
        ? { estimateW: prev.estimate_w, estimateKind: (prev.estimate_kind as EstimateKind | null) ?? (prev.estimate_w !== null ? 'admin' : null) }
        : powered.has(d.lifecycle_state)
          ? estimateFor(d.estimate_w, d.typical_power_w)
          : { estimateW: null, estimateKind: null };
      const srcs = series.get(id);
      const sources: Partial<Record<PowerSource, PowerReading[]>> = {};
      const gaps: Partial<Record<PowerSource, number>> = {};
      for (const [k, s] of srcs ?? []) {
        sources[k] = slice(s, start, end);
        gaps[k] = 3 * s.period;
      }
      const { bySource: _b, ...w } = windowEnergy({ from: start, to: end, sources, maxGapSeconds: gaps, estimateW: est.estimateW, estimateKind: est.estimateKind });
      if (!prev && !powered.has(d.lifecycle_state) && w.measuredSeconds === 0) continue;
      const counted = prev ? prev.counted : d.include_in_totals !== false && !distribution.has(d.category) && !d.feeds_outlets;
      out.push({
        device_id: id,
        hour: new Date(h).toISOString(),
        org_id: orgId,
        datacenter_id: prev ? prev.datacenter_id : d.datacenter_id,
        rack_id: prev ? prev.rack_id : d.rack_id,
        customer_id: prev ? prev.customer_id : d.customer_id,
        category: prev ? prev.category : d.category,
        counted,
        source: w.source,
        measured_wh: w.measuredWh,
        measured_seconds: Math.round(w.measuredSeconds),
        estimated_wh: w.estimatedWh,
        estimated_seconds: Math.round(w.estimatedSeconds),
        estimate_kind: w.estimateKind ?? est.estimateKind,
        estimate_w: est.estimateW,
        unknown_seconds: Math.round(w.unknownSeconds),
        avg_measured_w: w.avgMeasuredW,
        max_measured_w: w.maxMeasuredW,
        samples: w.samples,
      });
    }
  }
  for (let i = 0; i < out.length; i += 500) {
    await tx.execute(sql`
      insert into power_hourly (device_id, hour, org_id, datacenter_id, rack_id, customer_id, category, counted, source, measured_wh, measured_seconds,
                                estimated_wh, estimated_seconds, estimate_kind, estimate_w, unknown_seconds, avg_measured_w, max_measured_w, samples)
      select x.device_id, x.hour, x.org_id, x.datacenter_id, x.rack_id, x.customer_id, x.category, x.counted, x.source::power_source, x.measured_wh, x.measured_seconds,
             x.estimated_wh, x.estimated_seconds, x.estimate_kind, x.estimate_w, x.unknown_seconds, x.avg_measured_w, x.max_measured_w, x.samples
        from jsonb_to_recordset(${JSON.stringify(out.slice(i, i + 500))}::jsonb) as x(device_id uuid, hour timestamptz, org_id uuid, datacenter_id uuid, rack_id uuid, customer_id uuid,
             category text, counted boolean, source text, measured_wh float8, measured_seconds int, estimated_wh float8, estimated_seconds int, estimate_kind text,
             estimate_w real, unknown_seconds int, avg_measured_w real, max_measured_w real, samples int)
      on conflict (device_id, hour) do update set
        datacenter_id = excluded.datacenter_id, rack_id = excluded.rack_id, customer_id = excluded.customer_id, category = excluded.category,
        counted = excluded.counted, source = excluded.source, measured_wh = excluded.measured_wh, measured_seconds = excluded.measured_seconds,
        estimated_wh = excluded.estimated_wh, estimated_seconds = excluded.estimated_seconds, estimate_kind = excluded.estimate_kind,
        estimate_w = excluded.estimate_w, unknown_seconds = excluded.unknown_seconds, avg_measured_w = excluded.avg_measured_w,
        max_measured_w = excluded.max_measured_w, samples = excluded.samples`);
  }
  // Rows in the window that no longer qualify (only open hours can lose their row).
  const keys = JSON.stringify(out.map((r) => ({ device_id: r.device_id, hour: r.hour })));
  await tx.execute(sql`
    delete from power_hourly h
     where h.org_id = ${orgId} and h.hour >= ${fromIso}::timestamptz and h.hour < ${toIso}::timestamptz
       and not exists (select 1 from jsonb_to_recordset(${keys}::jsonb) as k(device_id uuid, hour timestamptz) where k.device_id = h.device_id and k.hour = h.hour)`);
  return out.length;
}

/** Deletes readings and hourly rows past each organization's retention (defaults 35 days raw, 1095 days hourly). */
export async function applyPowerRetention(db: Db, now: Date = new Date()): Promise<{ raw: number; hourly: number }> {
  const n = now.toISOString();
  const raw = await db.execute(sql`
    delete from power_readings t using organizations o left join power_settings s on s.org_id = o.id
     where t.org_id = o.id and t.at < ${n}::timestamptz - make_interval(days => coalesce(s.raw_days, 35))`);
  const hourly = await db.execute(sql`
    delete from power_hourly t using organizations o left join power_settings s on s.org_id = o.id
     where t.org_id = o.id and t.hour < ${n}::timestamptz - make_interval(days => coalesce(s.hourly_days, 1095))`);
  return { raw: raw.rowCount ?? 0, hourly: hourly.rowCount ?? 0 };
}
