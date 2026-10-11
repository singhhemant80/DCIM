import { execFile } from 'node:child_process';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { cidrSize, formatIp, parseCidr, usableRange } from '@crapplet/shared';

/** Largest IPv4 prefix whose every address is pinged (/22 = 1024 addresses). Bigger ones ping recorded addresses only. */
export const MAX_SWEEP = 1024;
/** How often a prefix is swept. */
export const SWEEP_EVERY_MINUTES = 5;

export interface PingResult {
  reachable: boolean;
  rttMs: number | null;
}
export type Pinger = (address: string, family: 4 | 6) => Promise<PingResult>;

/**
 * One ICMP echo with the system `ping` (iputils), 1 s timeout. Read-only:
 * nothing is sent but an echo request. Throws when ping itself can't run
 * (not installed, or not permitted), so that is reported instead of "down".
 */
export const systemPing: Pinger = (address, family) =>
  new Promise((resolve, reject) => {
    execFile('ping', [family === 6 ? '-6' : '-4', '-n', '-c', '1', '-W', '1', address], { timeout: 4000 }, (err, stdout, stderr) => {
      const out = String(stdout);
      const m = /time[=<]([\d.]+)\s*ms/.exec(out);
      if (m) return resolve({ reachable: true, rttMs: Number(m[1]) });
      const code = (err as unknown as { code?: number | string } | null)?.code;
      // Exit 1 = no reply. Anything else (ENOENT, permission, exit 2) is a problem with ping itself.
      if (code === 1) return resolve({ reachable: false, rttMs: null });
      reject(new Error(code === 'ENOENT' ? 'The ping command is not installed on the worker host (apt install iputils-ping)' : (String(stderr).trim() || (err as Error)?.message || 'ping failed').slice(0, 200)));
    });
  });

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

/** The addresses to ping for a prefix: all usable ones for small IPv4 prefixes, otherwise the recorded ones. */
export async function sweepTargets(db: Db, orgId: string, prefix: string, isPool: boolean, vrfId: string | null): Promise<string[]> {
  const c = parseCidr(prefix)!;
  if (c.family === 4 && cidrSize(c) <= BigInt(MAX_SWEEP)) {
    const r = usableRange(c, isPool);
    const out: string[] = [];
    for (let v = r.first; v <= r.last; v++) out.push(formatIp(4, v));
    return out;
  }
  const rows = await db.execute<{ ip: string }>(sql`
    select host(address) as ip from ip_addresses
     where org_id = ${orgId} and coalesce(vrf_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${vrfId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
       and address <<= ${prefix}::cidr and status <> 'released' limit ${MAX_SWEEP}`);
  return rows.rows.map((x) => x.ip);
}

/**
 * Claims one prefix that is due (reachability on, not checked for 5 minutes)
 * and pings its addresses, 64 at a time. Results replace the previous ones.
 */
export async function sweepDuePrefix(deps: { db: Db; logger: Pick<Logger, 'warn' | 'info'>; ping?: Pinger; concurrency?: number }): Promise<{ prefixId: string; checked: number; up: number } | null> {
  const { db } = deps;
  const claimed = await db.execute<{ id: string; org_id: string; prefix: string; is_pool: boolean; vrf_id: string | null }>(sql`
    update prefixes set ping_checked_at = now()
     where id = (select id from prefixes where ping_sweep and status <> 'deprecated'
                   and (ping_checked_at is null or ping_checked_at < now() - make_interval(mins => ${SWEEP_EVERY_MINUTES}))
                 order by ping_checked_at nulls first limit 1 for update skip locked)
    returning id, org_id, prefix::text as prefix, is_pool, vrf_id`);
  const pre = claimed.rows[0];
  if (!pre) return null;
  const ping = deps.ping ?? systemPing;
  const family = parseCidr(pre.prefix)!.family;
  const targets = await sweepTargets(db, pre.org_id, pre.prefix, pre.is_pool, pre.vrf_id);
  const results: { ip: string; r: PingResult }[] = [];
  let failure: string | null = null;
  await pool(targets, deps.concurrency ?? 64, async (ip) => {
    if (failure) return;
    try {
      results.push({ ip, r: await ping(ip, family) });
    } catch (e) {
      failure = (e as Error).message;
    }
  });
  if (failure) {
    await db.execute(sql`update prefixes set ping_error = ${failure} where id = ${pre.id}`);
    deps.logger.warn({ prefix: pre.prefix, err: failure }, 'reachability check failed');
    return { prefixId: pre.id, checked: 0, up: 0 };
  }
  const now = new Date().toISOString();
  for (let i = 0; i < results.length; i += 500) {
    const chunk = results.slice(i, i + 500);
    await db.execute(sql`
      insert into ip_reachability (org_id, address, reachable, rtt_ms, last_seen_at, checked_at)
      values ${sql.join(chunk.map(({ ip, r }) => sql`(${pre.org_id}, ${ip}::inet, ${r.reachable}, ${r.rttMs}, ${r.reachable ? now : null}::timestamptz, ${now}::timestamptz)`), sql`, `)}
      on conflict (org_id, address) do update set reachable = excluded.reachable, rtt_ms = excluded.rtt_ms,
        last_seen_at = coalesce(excluded.last_seen_at, ip_reachability.last_seen_at), checked_at = excluded.checked_at`);
  }
  await db.execute(sql`update prefixes set ping_error = null where id = ${pre.id}`);
  return { prefixId: pre.id, checked: results.length, up: results.filter((x) => x.r.reachable).length };
}
