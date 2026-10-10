import { sql } from 'drizzle-orm';
import type { Db } from '../../db/db';

/**
 * Downsampling and retention for interface rates (plain PostgreSQL tables; see
 * docs/database.md for why this is not TimescaleDB).
 *
 * Averages are time-weighted: each raw rate is weighted by the seconds it
 * covers, so a 30 s sample counts half as much as a 60 s one. Buckets with
 * missing polls are not padded: covered_seconds says how much of the bucket
 * has data. A sample is placed in the bucket of its own timestamp (the end of
 * the interval it covers), so an interval straddling a bucket boundary counts
 * in the later bucket. Recent buckets are recomputed on every run (idempotent upsert),
 * which also picks up the current, still-filling bucket.
 */
export async function rollup(db: Db, now: Date = new Date(), opts: { fiveMinuteLookbackSeconds?: number; hourlyLookbackSeconds?: number } = {}): Promise<{ fiveMinute: number; hourly: number }> {
  // Catch up after the worker was down: start from the newest bucket already
  // built (the watermark) when that is older than the normal look-back,
  // bounded by the longest raw retention (90 days).
  const wm = await db.execute<{ five: string | null; hour: string | null }>(sql`select (select max(bucket) from interface_rates_5m) as five, (select max(bucket) from interface_rates_1h) as hour`);
  const floorAt = now.getTime() - 90 * 86400_000;
  const lookback = (seconds: number, watermark: string | null | undefined) => {
    const normal = now.getTime() - seconds * 1000;
    if (!watermark) return Math.max(floorAt, normal);
    return Math.max(floorAt, Math.min(normal, new Date(watermark).getTime()));
  };
  const from5 = new Date(lookback(opts.fiveMinuteLookbackSeconds ?? 1800, wm.rows[0]?.five));
  // Align to a bucket start so a bucket is never computed from only part of its samples.
  const from5Aligned = new Date(Math.floor(from5.getTime() / 300_000) * 300_000).toISOString();
  const five = await db.execute(sql`
    insert into interface_rates_5m (interface_id, bucket, org_id, device_id, in_bps, out_bps, in_max, out_max, util_in_max, util_out_max, errors_ps, discards_ps, samples, covered_seconds)
    select interface_id,
           to_timestamp(floor(extract(epoch from at) / 300) * 300) as bucket,
           (array_agg(org_id))[1], (array_agg(device_id))[1],
           sum(in_bps * seconds) / sum(seconds),
           sum(out_bps * seconds) / sum(seconds),
           max(in_bps), max(out_bps), max(util_in), max(util_out),
           sum(errors_ps * seconds) / nullif(sum(seconds) filter (where errors_ps is not null), 0),
           sum(discards_ps * seconds) / nullif(sum(seconds) filter (where discards_ps is not null), 0),
           count(*), round(sum(seconds))::int
      from interface_rates
     where at >= ${from5Aligned}::timestamptz and at <= ${now.toISOString()}::timestamptz
     group by 1, 2
    on conflict (interface_id, bucket) do update set
      in_bps = excluded.in_bps, out_bps = excluded.out_bps, in_max = excluded.in_max, out_max = excluded.out_max,
      util_in_max = excluded.util_in_max, util_out_max = excluded.util_out_max, errors_ps = excluded.errors_ps,
      discards_ps = excluded.discards_ps, samples = excluded.samples, covered_seconds = excluded.covered_seconds`);
  const fromH = new Date(lookback(opts.hourlyLookbackSeconds ?? 3 * 3600, wm.rows[0]?.hour));
  const fromHAligned = new Date(Math.floor(fromH.getTime() / 3_600_000) * 3_600_000).toISOString();
  const hourly = await db.execute(sql`
    insert into interface_rates_1h (interface_id, bucket, org_id, device_id, in_bps, out_bps, in_max, out_max, util_in_max, util_out_max, errors_ps, discards_ps, samples, covered_seconds)
    select interface_id,
           to_timestamp(floor(extract(epoch from bucket) / 3600) * 3600) as hb,
           (array_agg(org_id))[1], (array_agg(device_id))[1],
           sum(in_bps * covered_seconds) / nullif(sum(covered_seconds), 0),
           sum(out_bps * covered_seconds) / nullif(sum(covered_seconds), 0),
           max(in_max), max(out_max), max(util_in_max), max(util_out_max),
           sum(errors_ps * covered_seconds) / nullif(sum(covered_seconds) filter (where errors_ps is not null), 0),
           sum(discards_ps * covered_seconds) / nullif(sum(covered_seconds) filter (where discards_ps is not null), 0),
           sum(samples), sum(covered_seconds)
      from interface_rates_5m
     where bucket >= ${fromHAligned}::timestamptz and bucket <= ${now.toISOString()}::timestamptz and covered_seconds > 0
     group by 1, 2
    on conflict (interface_id, bucket) do update set
      in_bps = excluded.in_bps, out_bps = excluded.out_bps, in_max = excluded.in_max, out_max = excluded.out_max,
      util_in_max = excluded.util_in_max, util_out_max = excluded.util_out_max, errors_ps = excluded.errors_ps,
      discards_ps = excluded.discards_ps, samples = excluded.samples, covered_seconds = excluded.covered_seconds`);
  return { fiveMinute: five.rowCount ?? 0, hourly: hourly.rowCount ?? 0 };
}

/** Deletes data older than each organization's retention settings (defaults 7 d raw, 90 d 5-min, 730 d hourly). */
export async function applyRetention(db: Db, now: Date = new Date()): Promise<{ raw: number; fiveMinute: number; hourly: number; notifications: number }> {
  const n = now.toISOString();
  const del = async (table: string, col: string, settingCol: string, def: number) => {
    const r = await db.execute(
      sql.raw(`delete from ${table} t using organizations o left join monitoring_settings s on s.org_id = o.id
                where t.org_id = o.id and t.${col} < '${n}'::timestamptz - make_interval(days => coalesce(s.${settingCol}, ${def}))`),
    );
    return r.rowCount ?? 0;
  };
  const raw = await del('interface_rates', 'at', 'raw_days', 7);
  const fiveMinute = await del('interface_rates_5m', 'bucket', 'five_minute_days', 90);
  const hourly = await del('interface_rates_1h', 'bucket', 'hourly_days', 730);
  const notes = await db.execute(sql`delete from notifications where status <> 'pending' and created_at < ${n}::timestamptz - interval '30 days'`);
  return { raw, fiveMinute, hourly, notifications: notes.rowCount ?? 0 };
}
