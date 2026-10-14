import { BadRequestException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/db';

/** The organization's time zone (Settings → time zone; Asia/Kolkata when unset), as SQL. */
export const orgTz = (orgId: string) => sql`(select coalesce(nullif(settings->>'timezone', ''), 'Asia/Kolkata') from organizations where id = ${orgId})`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string) => DAY.test(v);

function check(from?: string, to?: string) {
  const real = (v: string) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  };
  for (const v of [from, to]) if (v && isDay(v) && !real(v)) throw new BadRequestException({ error: 'invalid_date', message: `${v} is not a valid date` });
  if (from && to && isDay(from) && isDay(to) && from > to) throw new BadRequestException({ error: 'invalid_range', message: 'The start date is after the end date' });
}

/**
 * List filter: rows whose `col` falls on or after `from` and on or before
 * `to`. A day (YYYY-MM-DD) is a whole day in the organization's time zone, so
 * `to` includes that entire day; an exact ISO time is used as it is.
 */
export function dateFilter(col: SQL | unknown, orgId: string, range: { from?: string; to?: string }): SQL[] {
  check(range.from, range.to);
  const c = col as SQL;
  const out: SQL[] = [];
  if (range.from) out.push(isDay(range.from) ? sql`${c} >= (${range.from}::date::timestamp at time zone ${orgTz(orgId)})` : sql`${c} >= ${range.from}::timestamptz`);
  if (range.to) out.push(isDay(range.to) ? sql`${c} < ((${range.to}::date + 1)::timestamp at time zone ${orgTz(orgId)})` : sql`${c} <= ${range.to}::timestamptz`);
  return out;
}

/**
 * A custom period of whole days [from 00:00, to + 1 day 00:00) in the
 * organization's time zone. Both days are required; the end never lies in the
 * future (it stops at now). At most `maxDays` long.
 */
export async function dayRange(db: DbOrTx, orgId: string, from: string | undefined, to: string | undefined, maxDays = 3660): Promise<{ from: Date; to: Date; timezone: string }> {
  if (!from || !to || !isDay(from) || !isDay(to)) throw new BadRequestException({ error: 'dates_required', message: 'Choose a start and an end date for a custom period' });
  check(from, to);
  const r = await db.execute<{ tz: string; s: string; e: string }>(sql`
    select o.tz, (${from}::date::timestamp at time zone o.tz) as s, ((${to}::date + 1)::timestamp at time zone o.tz) as e
      from (select ${orgTz(orgId)} as tz) o`);
  const row = r.rows[0]!;
  const s = new Date(row.s);
  const e = new Date(Math.min(new Date(row.e).getTime(), Date.now()));
  if ((new Date(row.e).getTime() - s.getTime()) / 86_400_000 > maxDays) throw new BadRequestException({ error: 'range_too_long', message: `Choose at most ${maxDays} days` });
  if (e <= s) throw new BadRequestException({ error: 'range_in_future', message: 'The period starts in the future' });
  return { from: s, to: e, timezone: row.tz };
}
