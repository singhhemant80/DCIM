import { and, eq } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { deviceCredentials, deviceMonitoring, interfaces } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { credentialContext, type Adapter, type AdapterTarget } from '../../network/discovery/types';
import { counterDelta, type CounterSample } from '../../monitoring/rate-engine';
import { LIVE_WATCH_KEY, type LiveEvent } from '../../monitoring/events';
import { defaultAdapters, redact } from '../processor';
import type { CredentialKind } from '@crapplet/shared';

/**
 * Rate between two one-second reads. Unlike the stored poll, reads land about
 * a second apart with some jitter, so anything from 0.5 s is accepted; a gap
 * over 5 s (missed reads), a counter reset or a device restart gives no rate.
 */
export function liveRate(prev: CounterSample | undefined, cur: CounterSample): { inBps: number; outBps: number } | null {
  if (!prev) return null;
  const seconds = (cur.at - prev.at) / 1000;
  if (seconds < 0.5 || seconds > 5) return null;
  if (cur.uptimeSeconds !== null && prev.uptimeSeconds !== null && cur.uptimeSeconds < prev.uptimeSeconds) return null;
  const din = counterDelta(prev.inOctets, cur.inOctets, cur.bits);
  const dout = counterDelta(prev.outOctets, cur.outOctets, cur.bits);
  if (!din || !dout) return null;
  const inBps = (Number(din.delta) * 8) / seconds;
  const outBps = (Number(dout.delta) * 8) / seconds;
  const ceiling = cur.speedBps ? cur.speedBps * 1.1 : 4e12;
  if (inBps > ceiling || outBps > ceiling) return null;
  return { inBps, outBps };
}

export interface LiveDeps {
  db: Db;
  secrets: SecretBox;
  redis: Pick<Redis, 'zremrangebyscore' | 'zrange'>;
  publish: (orgId: string, ev: LiveEvent) => Promise<unknown> | unknown;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  adapters?: Partial<Record<CredentialKind, Adapter>>;
  /** At most this many devices are sampled live at once. */
  maxDevices?: number;
}

interface DeviceState {
  orgId: string;
  loadedAt: number;
  adapter: Adapter | null;
  target: AdapterTarget | null;
  ports: Map<string, { id: string; speedBps: number | null }>;
  ifIndex: Map<number, { id: string; speedBps: number | null }>;
  prev: Map<string, CounterSample>;
  busy: boolean;
  error: string | null;
}

/**
 * Live view. Once a second, for each device someone is watching (see the
 * `ports/:id/watch` heartbeat), reads the interface counters with the device's
 * stored read-only credential and publishes the per-second rates. Nothing is
 * written to the database and nothing is sent to the device except reads; the
 * regular poll keeps recording history. Baselines live in memory only.
 */
export function createLiveLoop(deps: LiveDeps) {
  const state = new Map<string, DeviceState>();
  const max = deps.maxDevices ?? 20;

  async function load(orgId: string, deviceId: string): Promise<DeviceState> {
    const s: DeviceState = { orgId, loadedAt: Date.now(), adapter: null, target: null, ports: new Map(), ifIndex: new Map(), prev: state.get(deviceId)?.prev ?? new Map(), busy: false, error: null };
    const [m] = await deps.db.select().from(deviceMonitoring).where(and(eq(deviceMonitoring.deviceId, deviceId), eq(deviceMonitoring.orgId, orgId)));
    if (!m?.enabled) return { ...s, error: 'Polling is not enabled for this device' };
    const [cred] = await deps.db.select().from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, m.credentialKind)));
    if (!cred?.host) return { ...s, error: 'No credential with a host' };
    const secret = JSON.parse(deps.secrets.decrypt(cred.secretEnc, credentialContext(cred.orgId, cred.deviceId, cred.kind, cred.host, cred.port))) as AdapterTarget['secret'];
    const adapter = (deps.adapters ?? defaultAdapters())[m.credentialKind] ?? null;
    const ports = await deps.db.select({ id: interfaces.id, name: interfaces.name, ifIndex: interfaces.ifIndex, speedBps: interfaces.speedBps }).from(interfaces).where(and(eq(interfaces.deviceId, deviceId), eq(interfaces.monitored, true)));
    for (const p of ports) {
      s.ports.set(p.name.toLowerCase(), { id: p.id, speedBps: p.speedBps });
      if (p.ifIndex !== null) s.ifIndex.set(p.ifIndex, { id: p.id, speedBps: p.speedBps });
    }
    return { ...s, adapter, target: { host: cred.host, port: cred.port, username: cred.username, params: { ...cred.params, timeoutMs: 2500 }, secret } };
  }

  async function sample(orgId: string, deviceId: string) {
    let s = state.get(deviceId);
    if (s?.busy) return;
    // Credentials and the port list are re-read every 30 s, so edits apply quickly.
    if (!s || Date.now() - s.loadedAt > 30_000) {
      s = await load(orgId, deviceId);
      state.set(deviceId, s);
    }
    if (!s.adapter?.counters || !s.target) return;
    s.busy = true;
    try {
      const snap = await s.adapter.counters(s.target);
      const at = Date.now();
      const ports: LiveEvent['ports'] = [];
      const seen = new Set<string>();
      for (const r of snap.interfaces) {
        const port = s.ports.get(r.name.toLowerCase()) ?? (r.ifIndex !== undefined && r.ifIndex !== null ? s.ifIndex.get(r.ifIndex) : undefined);
        if (!port || seen.has(port.id)) continue;
        seen.add(port.id);
        const cur: CounterSample = {
          at,
          uptimeSeconds: snap.uptimeSeconds,
          inOctets: r.inOctets,
          outOctets: r.outOctets,
          inPkts: null,
          outPkts: null,
          inErrors: null,
          outErrors: null,
          inDiscards: null,
          outDiscards: null,
          bits: r.bits,
          errorBits: r.errorBits,
          speedBps: r.speedBps ?? port.speedBps ?? null,
          operUp: r.operUp ?? null,
        };
        const rate = liveRate(s.prev.get(port.id), cur);
        s.prev.set(port.id, cur);
        ports.push({ interfaceId: port.id, inBps: rate?.inBps ?? null, outBps: rate?.outBps ?? null, operUp: cur.operUp });
      }
      s.error = null;
      if (ports.some((p) => p.inBps !== null)) await deps.publish(orgId, { type: 'live', deviceId, at: new Date(at).toISOString(), ports });
    } catch (e) {
      const msg = redact((e as Error)?.message || 'Unknown error', s.target?.secret as Record<string, unknown>);
      if (msg !== s.error) deps.logger.warn({ deviceId, err: msg }, 'live sample failed');
      s.error = msg;
      // A failed read breaks the series: the next rate starts from a fresh baseline.
      s.prev.clear();
    } finally {
      s.busy = false;
    }
  }

  return async function tick(): Promise<number> {
    const now = Date.now();
    await deps.redis.zremrangebyscore(LIVE_WATCH_KEY, '-inf', String(now));
    const members = await deps.redis.zrange(LIVE_WATCH_KEY, '0', String(max - 1));
    const watched = new Set<string>();
    for (const m of members) {
      const i = m.indexOf(':');
      if (i < 0) continue;
      const orgId = m.slice(0, i);
      const deviceId = m.slice(i + 1);
      watched.add(deviceId);
      // Not awaited: one slow device must not delay the others' second.
      void sample(orgId, deviceId).catch((e) => deps.logger.error({ deviceId, err: (e as Error).message }, 'live sample crashed'));
    }
    for (const id of [...state.keys()]) if (!watched.has(id) && !state.get(id)!.busy) state.delete(id);
    return watched.size;
  };
}
