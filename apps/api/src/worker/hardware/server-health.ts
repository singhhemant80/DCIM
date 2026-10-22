import { and, eq, sql } from 'drizzle-orm';
import { deviceCredentials, serverHealth } from '../../db/schema';
import { CHECKED_STATES } from '../../dcim/reachability';
import { credentialContext, type AdapterTarget } from '../../network/discovery/types';
import { defaultAdapters, redact } from '../processor';
import type { HardwareDeps } from './collect';

/** How often a server's current health is read from its BMC. */
export const SERVER_HEALTH_MINUTES = 5;

/**
 * Claims servers in service with a Redfish credential whose health is due
 * (every 5 minutes) and reads it from the BMC: component rollups,
 * temperatures and, where the BMC has them, usage. Read-only; at most a few
 * requests per server. A read stuck for 5 minutes is picked up again.
 */
export async function pollDueServerHealth(deps: HardwareDeps, limit = 8, concurrency = 4): Promise<number> {
  const states = sql.join(
    CHECKED_STATES.map((s) => sql`${s}`),
    sql`, `,
  );
  const claimed = await deps.db.execute<{ device_id: string }>(sql`
    with due as (
      select d.id, d.org_id from devices d
        join device_credentials c on c.device_id = d.id and c.kind = 'redfish' and nullif(trim(c.host), '') is not null
        left join server_health h on h.device_id = d.id
       where d.lifecycle_state in (${states})
         and (h.device_id is null or h.next_at is null or h.next_at <= now())
         and (h.status is distinct from 'running' or h.started_at < now() - interval '5 minutes')
       order by h.next_at nulls first
       limit ${limit}
       for update of d skip locked)
    insert into server_health (device_id, org_id, status, started_at)
    select id, org_id, 'running', now() from due
    on conflict (device_id) do update set status = 'running', started_at = now()
    returning device_id`);
  const queue = claimed.rows.map((r) => r.device_id);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) await readOne(deps, id);
    }),
  );
  return claimed.rows.length;
}

async function readOne(deps: HardwareDeps, deviceId: string) {
  const { db } = deps;
  let secret: Record<string, unknown> = {};
  const next = sql`now() + make_interval(mins => ${SERVER_HEALTH_MINUTES})`;
  try {
    const [cred] = await db
      .select()
      .from(deviceCredentials)
      .where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, 'redfish')));
    if (!cred?.host) throw new Error('No Redfish credential with a host');
    secret = JSON.parse(deps.secrets.decrypt(cred.secretEnc, credentialContext(cred.orgId, cred.deviceId, cred.kind, cred.host, cred.port))) as Record<string, unknown>;
    const adapter = (deps.adapters ?? defaultAdapters()).redfish;
    if (!adapter?.serverHealth) throw new Error('Server health reading is not available');
    const target: AdapterTarget = { host: cred.host, port: cred.port, username: cred.username, params: { ...cred.params, timeoutMs: Math.max(cred.params.timeoutMs ?? 20_000, 20_000) }, secret: secret as AdapterTarget['secret'] };
    let timer: NodeJS.Timeout | undefined;
    const data = await Promise.race([adapter.serverHealth(target), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('No answer within 90 s')), 90_000)))]).finally(() => clearTimeout(timer));
    await db.update(serverHealth).set({ status: 'idle', at: new Date(), lastAttemptAt: new Date(), nextAt: next, data, lastError: null }).where(eq(serverHealth.deviceId, deviceId));
  } catch (e) {
    const msg = redact((e as Error)?.message || 'Unknown error', secret).slice(0, 500);
    await db.update(serverHealth).set({ status: 'idle', lastAttemptAt: new Date(), nextAt: next, lastError: msg }).where(eq(serverHealth.deviceId, deviceId));
    deps.logger.warn({ deviceId, err: msg }, 'server health read failed');
  }
}
