import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { CredentialKind, HardwareInventory } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { deviceCredentials, deviceHardware } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { credentialContext, type Adapter, type AdapterTarget } from '../../network/discovery/types';
import { defaultAdapters, redact } from '../processor';

/** How often a server's BMC is read again on its own. */
export const HARDWARE_REFRESH_HOURS = 24;

export interface HardwareDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  adapters?: Partial<Record<CredentialKind, Adapter>>;
}

/** Worst health among the system and its components. */
export function overallHealth(inv: HardwareInventory): 'OK' | 'Warning' | 'Critical' | null {
  const all = [inv.system.health, ...inv.processors, ...inv.memory, ...inv.controllers, ...inv.drives, ...inv.volumes, ...inv.psus, ...inv.fans, ...inv.temperatures].map((x) => (typeof x === 'string' || x === null ? x : x.health));
  if (all.includes('Critical')) return 'Critical';
  if (all.includes('Warning') || inv.drives.some((d) => d.failurePredicted)) return 'Warning';
  return all.some((h) => h === 'OK') ? 'OK' : null;
}

/**
 * Claims servers whose BMC is due to be read: asked for by someone, never
 * read, or last read a day ago. Only devices with a stored Redfish credential
 * are read, and only with GET requests. A fetch stuck for 10 minutes (worker
 * restarted) is picked up again.
 */
export async function fetchDueHardware(deps: HardwareDeps, limit = 2): Promise<number> {
  const { db } = deps;
  const claimed = await db.execute<{ device_id: string }>(sql`
    with due as (
      select d.id, d.org_id from devices d
        join device_credentials c on c.device_id = d.id and c.kind = 'redfish' and nullif(trim(c.host), '') is not null
        left join device_hardware h on h.device_id = d.id
       where d.lifecycle_state <> 'retired'
         and (h.device_id is null or h.requested_at is not null or h.next_at is null or h.next_at <= now())
         and (h.status is distinct from 'running' or h.started_at < now() - interval '10 minutes')
       order by h.requested_at nulls last, h.next_at nulls first
       limit ${limit}
       for update of d skip locked)
    insert into device_hardware (device_id, org_id, status, started_at, requested_at)
    select id, org_id, 'running', now(), null from due
    on conflict (device_id) do update set status = 'running', started_at = now(), requested_at = null
    returning device_id`);
  for (const { device_id } of claimed.rows) await fetchOne(deps, device_id);
  return claimed.rows.length;
}

async function fetchOne(deps: HardwareDeps, deviceId: string) {
  const { db } = deps;
  let secret: Record<string, unknown> = {};
  const next = sql`now() + make_interval(hours => ${HARDWARE_REFRESH_HOURS})`;
  try {
    const [cred] = await db.select().from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, 'redfish')));
    if (!cred?.host) throw new Error('No Redfish credential with a host');
    secret = JSON.parse(deps.secrets.decrypt(cred.secretEnc, credentialContext(cred.orgId, cred.deviceId, cred.kind, cred.host, cred.port))) as Record<string, unknown>;
    const adapter = (deps.adapters ?? defaultAdapters()).redfish;
    if (!adapter?.hardware) throw new Error('Redfish hardware reading is not available');
    const target: AdapterTarget = { host: cred.host, port: cred.port, username: cred.username, params: { ...cred.params, timeoutMs: Math.max(cred.params.timeoutMs ?? 10_000, 10_000) }, secret: secret as AdapterTarget['secret'] };
    const inv = await adapter.hardware(target);
    await db
      .update(deviceHardware)
      .set({ status: 'idle', fetchedAt: new Date(), nextAt: next, lastError: inv.warnings.length ? `${inv.warnings.length} part(s) could not be read` : null, inventory: inv, health: overallHealth(inv) })
      .where(eq(deviceHardware.deviceId, deviceId));
    deps.logger.info({ deviceId, drives: inv.drives.length, dimms: inv.memory.length, logs: inv.logs.length }, 'hardware read from BMC');
  } catch (e) {
    const msg = redact((e as Error)?.message || 'Unknown error', secret).slice(0, 500);
    await db.update(deviceHardware).set({ status: 'failed', lastError: msg, nextAt: sql`now() + interval '1 hour'` }).where(eq(deviceHardware.deviceId, deviceId));
    deps.logger.warn({ deviceId, err: msg }, 'hardware read failed');
  }
}
