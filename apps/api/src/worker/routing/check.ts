import { eq, sql } from 'drizzle-orm';
import { ROUTING_SPECIAL_RANGES } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { bgpAsns, prefixRouting } from '../../db/schema';
import { checkAsn, evaluatePrefix, fetchPrefix, type RipeStat } from './ripestat';

/** How often each prefix and ASN is checked (RIS publishes routing state about every 8 hours). */
export const ROUTING_CHECK_HOURS = 6;

export interface RoutingDeps {
  db: Db;
  client: RipeStat;
  logger: { warn: (o: object, m: string) => void; info?: (o: object, m: string) => void };
}

const SPECIAL = sql.raw(`array[${ROUTING_SPECIAL_RANGES.map((r) => `'${r}'::cidr`).join(', ')}]`);

/**
 * Public prefixes in the global table of organizations that have entered an
 * ASN (or prefixes with an expected origin): /24 or shorter for IPv4, /48 or
 * shorter for IPv6. Longer and private prefixes are never sent anywhere.
 */
export const ROUTING_CANDIDATE = sql`
  x.vrf_id is null and x.routing_check and x.status in ('active', 'container')
  and not (x.prefix && any(${SPECIAL}))
  and ((family(x.prefix) = 4 and masklen(x.prefix) <= 24) or (family(x.prefix) = 6 and masklen(x.prefix) <= 48 and x.prefix <<= '2000::/3'::cidr))
  and (x.origin_asn is not null or exists (select 1 from bgp_asns b where b.org_id = x.org_id))`;

/** Checks due ASNs and prefixes in the global routing table (read-only, through RIPEstat). */
export async function pollDueRouting(deps: RoutingDeps, limit = 3): Promise<{ asns: number; prefixes: number }> {
  const { db } = deps;
  const next = sql`now() + make_interval(hours => ${ROUTING_CHECK_HOURS})`;
  const retry = sql`now() + interval '30 minutes'`;
  // ASNs.
  const asns = await db.execute<{ id: string; asn: string }>(sql`
    update bgp_asns set status = 'running', started_at = now() where id in (
      select id from bgp_asns where (next_at is null or next_at <= now()) and (status <> 'running' or started_at < now() - interval '10 minutes')
       order by next_at nulls first limit 2 for update skip locked)
    returning id, asn`);
  for (const a of asns.rows) {
    try {
      const data = await checkAsn(deps.client, Number(a.asn));
      await db.update(bgpAsns).set({ status: 'idle', data, checkedAt: new Date(), nextAt: next, lastError: null }).where(eq(bgpAsns.id, a.id));
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 500);
      await db.update(bgpAsns).set({ status: 'idle', nextAt: retry, lastError: msg }).where(eq(bgpAsns.id, a.id));
      deps.logger.warn({ asn: a.asn, err: msg }, 'ASN routing check failed');
    }
  }
  // Prefixes.
  const claimed = await db.execute<{ prefix_id: string }>(sql`
    with due as (
      select x.id, x.org_id from prefixes x left join prefix_routing r on r.prefix_id = x.id
       where ${ROUTING_CANDIDATE}
         and (r.prefix_id is null or r.next_at is null or r.next_at <= now())
         and (r.status is distinct from 'running' or r.started_at < now() - interval '10 minutes')
       order by r.next_at nulls first limit ${limit}
       for update of x skip locked)
    insert into prefix_routing (prefix_id, org_id, status, started_at) select id, org_id, 'running', now() from due
    on conflict (prefix_id) do update set status = 'running', started_at = now()
    returning prefix_id`);
  for (const { prefix_id } of claimed.rows) {
    const [row] = (
      await db.execute<{ prefix: string; origin_asn: string | null; asns: string[] | null }>(sql`
        select x.prefix::text as prefix, x.origin_asn, (select array_agg(b.asn::text order by b.asn) from bgp_asns b where b.org_id = x.org_id) as asns
          from prefixes x where x.id = ${prefix_id}`)
    ).rows;
    if (!row) continue;
    const expected = row.origin_asn ? [Number(row.origin_asn)] : (row.asns ?? []).map(Number);
    try {
      const data = evaluatePrefix(row.prefix, expected, await fetchPrefix(deps.client, row.prefix, expected));
      await db.update(prefixRouting).set({ status: 'idle', data, level: data.level, checkedAt: new Date(), lastAttemptAt: new Date(), nextAt: next, lastError: null }).where(eq(prefixRouting.prefixId, prefix_id));
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 500);
      await db.update(prefixRouting).set({ status: 'idle', lastAttemptAt: new Date(), nextAt: retry, lastError: msg }).where(eq(prefixRouting.prefixId, prefix_id));
      deps.logger.warn({ prefix: row.prefix, err: msg }, 'prefix routing check failed');
    }
  }
  return { asns: asns.rows.length, prefixes: claimed.rows.length };
}
