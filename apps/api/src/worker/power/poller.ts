import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { CredentialKind } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { deviceCredentials, pduOutlets, powerMonitoring, powerReadings, type PowerMonitoring } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { credentialContext, type Adapter, type AdapterTarget, type PowerSnapshot } from '../../network/discovery/types';
import { MAX_DEVICE_WATTS } from '../../power/energy';
import { defaultAdapters, redact } from '../processor';

/**
 * Power collection. Same model as interface polling: due devices are claimed
 * from PostgreSQL with FOR UPDATE SKIP LOCKED, read with the stored read-only
 * credential, and every reading is stored as measured with its source.
 *
 * A PDU poll stores the PDU's own total (source `snmp`, never counted in
 * equipment totals) and its outlets. A device fed by mapped outlets gets a
 * `pdu_outlet` reading equal to the sum of all its outlets, written only when
 * every one of them has a recent value (an A+B fed server on two PDUs is
 * summed across both, never half-counted).
 */
export interface PowerPollerDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  adapters?: Partial<Record<CredentialKind, Adapter>>;
  now?: () => Date;
}

export interface PowerPollOutcome {
  deviceId: string;
  ok: boolean;
  at: Date;
  error?: string;
  watts: number | null;
  outlets: number;
  /** Devices that received a pdu_outlet reading from this poll. */
  fed: string[];
}

export async function claimDuePower(db: Db, limit: number, now: Date): Promise<PowerMonitoring[]> {
  const res = await db.execute<{ device_id: string }>(sql`
    update power_monitoring m
       set next_poll_at = ${now.toISOString()}::timestamptz + make_interval(secs => m.interval_seconds)
     where m.device_id in (
       select device_id from power_monitoring
        where enabled and (next_poll_at is null or next_poll_at <= ${now.toISOString()}::timestamptz)
        order by next_poll_at nulls first
        limit ${limit}
        for update skip locked)
    returning m.device_id`);
  const ids = res.rows.map((r) => r.device_id);
  if (!ids.length) return [];
  return db.select().from(powerMonitoring).where(inArray(powerMonitoring.deviceId, ids));
}

const valid = (w: number | null | undefined): w is number => typeof w === 'number' && Number.isFinite(w) && w >= 0 && w <= MAX_DEVICE_WATTS;

export async function pollPowerDevice(deps: PowerPollerDeps, m: PowerMonitoring): Promise<PowerPollOutcome> {
  const { db } = deps;
  const started = Date.now();
  let secret: Record<string, unknown> = {};
  const fail = async (error: string): Promise<PowerPollOutcome> => {
    const at = deps.now?.() ?? new Date();
    try {
      await db
        .update(powerMonitoring)
        .set({ lastPollAt: at, lastError: error.slice(0, 500), consecutiveFailures: sql`${powerMonitoring.consecutiveFailures} + 1`, lastDurationMs: Date.now() - started })
        .where(eq(powerMonitoring.deviceId, m.deviceId));
    } catch (e) {
      deps.logger.error({ deviceId: m.deviceId, err: (e as Error).message }, 'could not record power poll failure');
    }
    deps.logger.warn({ deviceId: m.deviceId, kind: m.credentialKind, err: error }, 'power poll failed');
    return { deviceId: m.deviceId, ok: false, at, error, watts: null, outlets: 0, fed: [] };
  };
  try {
    const [cred] = await db.select().from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, m.deviceId), eq(deviceCredentials.kind, m.credentialKind)));
    if (!cred?.host) return await fail(`No ${m.credentialKind} credential with a host is stored for this device`);
    try {
      secret = JSON.parse(deps.secrets.decrypt(cred.secretEnc, credentialContext(cred.orgId, cred.deviceId, cred.kind, cred.host, cred.port))) as Record<string, unknown>;
    } catch {
      return await fail('The stored credential could not be decrypted; enter it again');
    }
    const adapter = (deps.adapters ?? defaultAdapters())[m.credentialKind];
    if (!adapter?.power) return await fail(`${m.credentialKind} cannot read power`);
    const target: AdapterTarget = { host: cred.host, port: cred.port, username: cred.username, params: cred.params, secret: secret as AdapterTarget['secret'] };
    const limit = Math.min(45_000, Math.max(5_000, m.intervalSeconds * 800));
    let timer: NodeJS.Timeout | undefined;
    let snap: PowerSnapshot;
    try {
      snap = await Promise.race([adapter.power(target), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(limit / 1000)} s`)), limit)))]);
    } catch (e) {
      return await fail(redact((e as Error)?.message || 'Unknown error', secret));
    } finally {
      clearTimeout(timer);
    }
    const at = deps.now?.() ?? new Date();
    return await store(deps, m, snap, at, Date.now() - started);
  } catch (e) {
    return await fail(redact((e as Error)?.message || 'Unknown error', secret));
  } finally {
    secret = {};
  }
}

async function store(deps: PowerPollerDeps, m: PowerMonitoring, snap: PowerSnapshot, at: Date, durationMs: number): Promise<PowerPollOutcome> {
  return deps.db.transaction(async (tx) => {
    const own = valid(snap.watts) ? snap.watts : null;
    if (own !== null) {
      await tx.insert(powerReadings).values({ deviceId: m.deviceId, source: snap.source, at, orgId: m.orgId, watts: own, periodSeconds: m.intervalSeconds }).onConflictDoNothing();
    }
    const fed: string[] = [];
    const outlets = (snap.outlets ?? []).slice(0, 512);
    if (outlets.length) {
      for (const o of outlets) {
        const w = valid(o.watts) ? o.watts : null;
        await tx
          .insert(pduOutlets)
          .values({ orgId: m.orgId, pduDeviceId: m.deviceId, outletNumber: o.number, name: o.name?.slice(0, 120) ?? null, lastWatts: w, lastAt: w === null ? null : at })
          .onConflictDoUpdate({ target: [pduOutlets.pduDeviceId, pduOutlets.outletNumber], set: { name: o.name?.slice(0, 120) ?? null, lastWatts: w, lastAt: w === null ? null : at } });
      }
      // Devices fed by this PDU: sum all their outlets (on any PDU) when every one is fresh.
      // A server with more power supplies than mapped outlets would be under-counted: no PDU figure then.
      const rows = await tx.execute<{ device_id: string; n: number; fresh: number; watts: number | null; period: number; psus: number | null }>(sql`
        select o.device_id, count(*)::int as n,
               (select m.psu_count from devices d join device_models m on m.id = d.model_id where d.id = o.device_id) as psus,
               count(*) filter (where o.last_watts is not null and o.last_at > ${at.toISOString()}::timestamptz - make_interval(secs => 3 * coalesce(pm.interval_seconds, 300)))::int as fresh,
               sum(o.last_watts) as watts, max(coalesce(pm.interval_seconds, 300))::int as period
          from pdu_outlets o left join power_monitoring pm on pm.device_id = o.pdu_device_id
         where o.device_id in (select device_id from pdu_outlets where pdu_device_id = ${m.deviceId} and device_id is not null)
         group by o.device_id`);
      for (const r of rows.rows) {
        const w = r.watts === null ? null : Number(r.watts);
        if (r.n !== r.fresh || !valid(w) || (r.psus !== null && r.n < r.psus)) continue;
        await tx.insert(powerReadings).values({ deviceId: r.device_id, source: 'pdu_outlet', at, orgId: m.orgId, watts: w, periodSeconds: r.period }).onConflictDoNothing();
        fed.push(r.device_id);
      }
    }
    await tx
      .update(powerMonitoring)
      .set({ lastPollAt: at, lastOkAt: at, lastError: null, consecutiveFailures: 0, lastDurationMs: durationMs, lastWatts: own })
      .where(eq(powerMonitoring.deviceId, m.deviceId));
    return { deviceId: m.deviceId, ok: true, at, watts: own, outlets: outlets.length, fed };
  });
}

/** Polls every due device and waits (tests and one-shot runs). */
export async function pollDuePower(deps: PowerPollerDeps, opts: { limit?: number; concurrency?: number } = {}): Promise<PowerPollOutcome[]> {
  const queue = await claimDuePower(deps.db, opts.limit ?? 200, deps.now?.() ?? new Date());
  const out: PowerPollOutcome[] = [];
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 8, queue.length) }, async () => {
      for (let m = queue.shift(); m; m = queue.shift()) out.push(await pollPowerDevice(deps, m));
    }),
  );
  return out;
}

/** The worker's continuous loop: claims as many due devices as it has free slots and doesn't wait for them. */
export function createPowerPollLoop(deps: PowerPollerDeps, concurrency: number): () => Promise<void> {
  let inflight = 0;
  return async () => {
    const free = concurrency - inflight;
    if (free <= 0) return;
    for (const m of await claimDuePower(deps.db, free, deps.now?.() ?? new Date())) {
      inflight++;
      void pollPowerDevice(deps, m)
        .catch((e: Error) => deps.logger.error({ deviceId: m.deviceId, err: e.message }, 'power poll crashed'))
        .finally(() => inflight--);
    }
  };
}
