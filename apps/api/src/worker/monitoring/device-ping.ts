import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { formatIp, parseIp } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { systemPing, type Pinger } from './ping';
import { CHECKED_STATES, DEVICE_CHECK_SECONDS } from '../../dcim/reachability';


const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * The host to ping from a stored management address: an IP literal or a DNS
 * name. A URL or host:port is reduced to its host. Anything else is refused,
 * which also keeps a value like "-f" from ever reaching ping as an option.
 */
export function pingTarget(raw: string | null | undefined): string | null {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  s = s.replace(/^\[(.*)\]$/, '$1');
  const ip = parseIp(s);
  if (ip) return formatIp(ip.family, ip.value);
  const hp = /^([^:]+):\d{1,5}$/.exec(s);
  if (hp) s = hp[1]!;
  const ip4 = parseIp(s);
  if (ip4) return formatIp(ip4.family, ip4.value);
  return HOSTNAME.test(s) ? s.toLowerCase() : null;
}

/**
 * Pings the management address of every in-service device that is due
 * (checked longer than a minute ago). The address is the device's
 * management address, or else the host of its first stored credential. A
 * failed echo is retried once before the device counts as unreachable, so a
 * single lost packet doesn't flip it to red. ICMP echo only; nothing else is
 * sent to the device.
 */
export async function checkDueDevices(deps: { db: Db; logger: Pick<Logger, 'warn'>; ping?: Pinger; limit?: number; concurrency?: number }): Promise<{ checked: number; up: number }> {
  const { db } = deps;
  const ping = deps.ping ?? systemPing;
  const due = await db.execute<{ id: string; org_id: string; address: string | null }>(sql`
    select d.id, d.org_id,
           coalesce(nullif(trim(d.mgmt_address), ''),
                    (select c.host from device_credentials c
                      where c.device_id = d.id and nullif(trim(c.host), '') is not null
                      order by c.created_at limit 1)) as address
      from devices d
      left join device_reachability r on r.device_id = d.id
     where d.lifecycle_state in (${sql.join(CHECKED_STATES.map((s) => sql`${s}`), sql`, `)})
       and (r.checked_at is null or r.checked_at < now() - make_interval(secs => ${DEVICE_CHECK_SECONDS - 5}))
       and coalesce(nullif(trim(d.mgmt_address), ''),
                    (select c.host from device_credentials c where c.device_id = d.id and nullif(trim(c.host), '') is not null limit 1)) is not null
     order by r.checked_at nulls first
     limit ${deps.limit ?? 256}`);
  let up = 0;
  let i = 0;
  const rows = due.rows;
  const work = async () => {
    while (i < rows.length) {
      const d = rows[i++]!;
      const target = pingTarget(d.address);
      let reachable = false;
      let rtt: number | null = null;
      let error: string | null = null;
      if (!target) {
        error = `"${String(d.address).slice(0, 80)}" is not an IP address or host name`;
      } else {
        const family = target.includes(':') ? 6 : 4;
        try {
          for (let attempt = 0; attempt < 2 && !reachable; attempt++) {
            const r = await ping(target, family);
            reachable = r.reachable;
            rtt = r.rttMs;
          }
        } catch (e) {
          error = (e as Error).message.slice(0, 300);
        }
      }
      if (reachable) up++;
      const now = new Date().toISOString();
      await db.execute(sql`
        insert into device_reachability (device_id, org_id, target, reachable, rtt_ms, last_seen_at, changed_at, checked_at, error)
        values (${d.id}, ${d.org_id}, ${target ?? String(d.address).slice(0, 255)}, ${reachable}, ${rtt},
                ${reachable ? now : null}::timestamptz, ${now}::timestamptz, ${now}::timestamptz, ${error})
        on conflict (device_id) do update set
          reachable = excluded.reachable,
          rtt_ms = excluded.rtt_ms,
          last_seen_at = case when device_reachability.target = excluded.target
                              then coalesce(excluded.last_seen_at, device_reachability.last_seen_at)
                              else excluded.last_seen_at end,
          changed_at = case when device_reachability.reachable is distinct from excluded.reachable
                              or (device_reachability.error is null) <> (excluded.error is null)
                              or device_reachability.target <> excluded.target
                            then excluded.changed_at else device_reachability.changed_at end,
          target = excluded.target,
          checked_at = excluded.checked_at,
          error = excluded.error`);
      if (error) deps.logger.warn({ deviceId: d.id, err: error }, 'device reachability check failed');
    }
  };
  await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 32, rows.length) }, work));
  return { checked: rows.length, up };
}
