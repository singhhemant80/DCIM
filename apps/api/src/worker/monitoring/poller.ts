import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { deviceCredentials, deviceMonitoring, interfaceCounters, interfaceRates, interfaces, type DeviceMonitoring, type InterfaceCounter } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { credentialContext, type Adapter, type AdapterTarget, type CounterReading } from '../../network/discovery/types';
import { computeRate, type CounterSample, type RateResult } from '../../monitoring/rate-engine';
import { defaultAdapters, redact } from '../processor';
import type { CredentialKind } from '@crapplet/shared';

/**
 * Interface polling. Runs in the worker on a timer, independent of whether
 * anyone has a browser open. Each poll is read-only: it reads counters with
 * the device's stored (read-only) credential and never changes the device.
 *
 * Due devices are claimed with FOR UPDATE SKIP LOCKED and their next_poll_at
 * is pushed forward in the same statement, so two worker instances never
 * poll the same device twice for one interval.
 */

export interface PortUpdate {
  interfaceId: string;
  name: string;
  inBps: number | null;
  outBps: number | null;
  utilIn: number | null;
  utilOut: number | null;
  errorsPs: number | null;
  discardsPs: number | null;
  operUp: boolean | null;
  /** Why there is no rate this time (first sample, reset, gap…); null when there is one. */
  skip: string | null;
}

export interface PollOutcome {
  orgId: string;
  deviceId: string;
  ok: boolean;
  at: Date;
  error?: string;
  consecutiveFailures: number;
  ports: PortUpdate[];
  /** Interfaces reported by the device that match no inventory port. */
  unmatched: number;
  intervalSeconds: number;
}

export interface PollerDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  adapters?: Partial<Record<CredentialKind, Adapter>>;
  /** Called after every poll (success or failure): alert evaluation and live updates. */
  onPolled?: (outcome: PollOutcome) => Promise<void>;
  now?: () => Date;
}

const num = (v: string | null): bigint | null => (v === null || v === undefined ? null : BigInt(v.split('.')[0]!));
const str = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

/** The stored baseline as a rate-engine sample. */
function sampleFromRow(r: InterfaceCounter): CounterSample {
  return {
    at: r.sampledAt.getTime(),
    uptimeSeconds: r.uptimeSeconds,
    inOctets: num(r.inOctets),
    outOctets: num(r.outOctets),
    inPkts: num(r.inPkts),
    outPkts: num(r.outPkts),
    inErrors: num(r.inErrors),
    outErrors: num(r.outErrors),
    inDiscards: num(r.inDiscards),
    outDiscards: num(r.outDiscards),
    bits: r.counterBits === 32 ? 32 : 64,
    errorBits: r.errorBits === 32 ? 32 : 64,
    speedBps: r.speedBps,
    operUp: r.operUp,
  };
}

/** Claims up to `limit` devices that are due and pushes their next poll forward. */
export async function claimDue(db: Db, limit: number, now: Date): Promise<DeviceMonitoring[]> {
  const res = await db.execute<{ device_id: string }>(sql`
    update device_monitoring m
       set next_poll_at = ${now.toISOString()}::timestamptz + make_interval(secs => m.interval_seconds)
     where m.device_id in (
       select device_id from device_monitoring
        where enabled and (next_poll_at is null or next_poll_at <= ${now.toISOString()}::timestamptz)
        order by next_poll_at nulls first
        limit ${limit}
        for update skip locked)
    returning m.device_id`);
  const ids = res.rows.map((r) => r.device_id);
  if (!ids.length) return [];
  return db.select().from(deviceMonitoring).where(inArray(deviceMonitoring.deviceId, ids));
}

/** Polls one device, then runs the post-poll hook. Never throws. */
export async function runPoll(deps: PollerDeps, m: DeviceMonitoring): Promise<PollOutcome> {
  const o = await pollDevice(deps, m);
  if (deps.onPolled) {
    try {
      await deps.onPolled(o);
    } catch (e) {
      deps.logger.error({ deviceId: o.deviceId, err: (e as Error).message }, 'post-poll processing failed');
    }
  }
  return o;
}

/** Polls every due device, `concurrency` at a time, and waits for all (used by tests and one-shot runs). */
export async function pollDue(deps: PollerDeps, opts: { limit?: number; concurrency?: number } = {}): Promise<PollOutcome[]> {
  const now = deps.now?.() ?? new Date();
  const queue = await claimDue(deps.db, opts.limit ?? 200, now);
  const out: PollOutcome[] = [];
  const workers = Array.from({ length: Math.min(opts.concurrency ?? 8, queue.length) }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) out.push(await runPoll(deps, m));
  });
  await Promise.all(workers);
  return out;
}

/**
 * The worker's continuous poller: every tick it claims as many due devices as
 * it has free slots and starts them without waiting, so one slow device never
 * delays the others.
 */
export function createPollLoop(deps: PollerDeps, concurrency: number): () => Promise<void> {
  let inflight = 0;
  return async () => {
    const free = concurrency - inflight;
    if (free <= 0) return;
    const due = await claimDue(deps.db, free, deps.now?.() ?? new Date());
    for (const m of due) {
      inflight++;
      void runPoll(deps, m)
        .catch((e: Error) => deps.logger.error({ deviceId: m.deviceId, err: e.message }, 'poll crashed'))
        .finally(() => inflight--);
    }
  };
}

/** Polls one device and stores counters and rates. Never throws. */
export async function pollDevice(deps: PollerDeps, m: DeviceMonitoring): Promise<PollOutcome> {
  const { db } = deps;
  const started = Date.now();
  let secret: Record<string, unknown> = {};
  const fail = async (error: string): Promise<PollOutcome> => {
    const at = deps.now?.() ?? new Date();
    let n = m.consecutiveFailures + 1;
    try {
      const [row] = await db
        .update(deviceMonitoring)
        .set({ lastPollAt: at, lastError: error.slice(0, 500), consecutiveFailures: sql`${deviceMonitoring.consecutiveFailures} + 1`, lastDurationMs: Date.now() - started })
        .where(eq(deviceMonitoring.deviceId, m.deviceId))
        .returning({ n: deviceMonitoring.consecutiveFailures });
      n = row?.n ?? n;
    } catch (e) {
      // The database itself is unavailable; report and carry on (the poll is retried next interval).
      deps.logger.error({ deviceId: m.deviceId, err: (e as Error).message }, 'could not record poll failure');
    }
    deps.logger.warn({ deviceId: m.deviceId, kind: m.credentialKind, err: error }, 'poll failed');
    return { orgId: m.orgId, deviceId: m.deviceId, ok: false, at, error, consecutiveFailures: n, ports: [], unmatched: 0, intervalSeconds: m.intervalSeconds };
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
    if (!adapter?.counters) return await fail(`${m.credentialKind} cannot read interface counters`);
    const target: AdapterTarget = { host: cred.host, port: cred.port, username: cred.username, params: cred.params, secret: secret as AdapterTarget['secret'] };
    // Never let one slow device hold a slot past its own interval.
    const limit = Math.min(30_000, Math.max(5_000, m.intervalSeconds * 800));
    let timer: NodeJS.Timeout | undefined;
    let snapshot;
    try {
      snapshot = await Promise.race([adapter.counters(target), new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(limit / 1000)} s`)), limit)))]);
    } catch (e) {
      return await fail(redact((e as Error)?.message || 'Unknown error', secret));
    } finally {
      clearTimeout(timer);
    }
    // The poll time is when the answer arrived (our clock, not the device's).
    const at = deps.now?.() ?? new Date();
    return await store(deps, m, snapshot.uptimeSeconds, snapshot.interfaces, at, Date.now() - started);
  } catch (e) {
    return await fail(redact((e as Error)?.message || 'Unknown error', secret));
  } finally {
    secret = {};
  }
}

async function store(deps: PollerDeps, m: DeviceMonitoring, uptimeSeconds: number | null, readings: CounterReading[], at: Date, durationMs: number): Promise<PollOutcome> {
  const { db } = deps;
  return db.transaction(async (tx) => {
    const ports = await tx
      .select({ id: interfaces.id, name: interfaces.name, ifIndex: interfaces.ifIndex, speedBps: interfaces.speedBps })
      .from(interfaces)
      .where(and(eq(interfaces.deviceId, m.deviceId), eq(interfaces.monitored, true)));
    const byName = new Map(ports.map((p) => [p.name.toLowerCase(), p]));
    const byIndex = new Map(ports.filter((p) => p.ifIndex !== null).map((p) => [p.ifIndex!, p]));
    const prevRows = ports.length ? await tx.select().from(interfaceCounters).where(inArray(interfaceCounters.interfaceId, ports.map((p) => p.id))) : [];
    const prev = new Map(prevRows.map((r) => [r.interfaceId, r]));
    const updates: PortUpdate[] = [];
    const seen = new Set<string>();
    let unmatched = 0;
    for (const r of readings) {
      // Name is the stable key; ifIndex is only a fallback (it can change on reboot).
      const port = byName.get(r.name.toLowerCase()) ?? (r.ifIndex !== undefined && r.ifIndex !== null ? byIndex.get(r.ifIndex) : undefined);
      if (!port || seen.has(port.id)) {
        if (!port) unmatched++;
        continue;
      }
      seen.add(port.id);
      const cur: CounterSample = {
        at: at.getTime(),
        uptimeSeconds,
        inOctets: r.inOctets,
        outOctets: r.outOctets,
        inPkts: r.inPkts ?? null,
        outPkts: r.outPkts ?? null,
        inErrors: r.inErrors ?? null,
        outErrors: r.outErrors ?? null,
        inDiscards: r.inDiscards ?? null,
        outDiscards: r.outDiscards ?? null,
        bits: r.bits,
        errorBits: r.errorBits,
        // The device's reported speed wins; otherwise the inventory speed.
        speedBps: r.speedBps ?? port.speedBps ?? null,
        operUp: r.operUp ?? null,
      };
      const p = prev.get(port.id);
      const rate: RateResult = computeRate(p ? sampleFromRow(p) : null, cur, m.intervalSeconds);
      const isRate = rate.kind === 'rate';
      const values = {
        orgId: m.orgId,
        sampledAt: at,
        uptimeSeconds,
        inOctets: str(cur.inOctets),
        outOctets: str(cur.outOctets),
        inPkts: str(cur.inPkts),
        outPkts: str(cur.outPkts),
        inErrors: str(cur.inErrors),
        outErrors: str(cur.outErrors),
        inDiscards: str(cur.inDiscards),
        outDiscards: str(cur.outDiscards),
        counterBits: cur.bits,
        errorBits: cur.errorBits ?? 32,
        speedBps: cur.speedBps,
        operUp: cur.operUp,
        lastRateAt: isRate ? at : null,
        inBps: isRate ? rate.inBps : null,
        outBps: isRate ? rate.outBps : null,
        utilIn: isRate ? rate.utilIn : null,
        utilOut: isRate ? rate.utilOut : null,
        errorsPs: isRate ? rate.errorsPs : null,
        discardsPs: isRate ? rate.discardsPs : null,
        lastSkip: isRate ? null : rate.reason,
      };
      await tx
        .insert(interfaceCounters)
        .values({ interfaceId: port.id, ...values })
        .onConflictDoUpdate({ target: interfaceCounters.interfaceId, set: values });
      if (isRate) {
        await tx
          .insert(interfaceRates)
          .values({
            interfaceId: port.id,
            at,
            seconds: rate.seconds,
            orgId: m.orgId,
            deviceId: m.deviceId,
            inBps: rate.inBps,
            outBps: rate.outBps,
            inPps: rate.inPps,
            outPps: rate.outPps,
            errorsPs: rate.errorsPs,
            discardsPs: rate.discardsPs,
            utilIn: rate.utilIn,
            utilOut: rate.utilOut,
            speedBps: rate.speedBps,
            flags: rate.flags,
          })
          .onConflictDoNothing();
      }
      updates.push({
        interfaceId: port.id,
        name: port.name,
        inBps: values.inBps,
        outBps: values.outBps,
        utilIn: values.utilIn,
        utilOut: values.utilOut,
        errorsPs: values.errorsPs,
        discardsPs: values.discardsPs,
        operUp: cur.operUp,
        skip: values.lastSkip,
      });
    }
    await tx
      .update(deviceMonitoring)
      .set({ lastPollAt: at, lastOkAt: at, lastError: null, consecutiveFailures: 0, lastDurationMs: durationMs, lastMatched: updates.length, lastReported: readings.length })
      .where(eq(deviceMonitoring.deviceId, m.deviceId));
    return { orgId: m.orgId, deviceId: m.deviceId, ok: true, at, consecutiveFailures: 0, ports: updates, unmatched, intervalSeconds: m.intervalSeconds };
  });
}
