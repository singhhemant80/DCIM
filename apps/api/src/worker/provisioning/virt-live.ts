import net from 'node:net';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { virtGuests, virtHosts, virtIntegrations } from '../../db/schema';
import { VIRT_WATCH_KEY, virtAccessKey, virtLiveKey } from '../../health/worker-heartbeat';
import type { ProvisioningDeps } from './kinds';
import { virtClientFor } from './kinds';

export interface VirtLiveSnapshot {
  at: string;
  /** Per node (external id): CPU in percent of all its cores, memory in bytes. */
  hosts: Record<string, { cpuPct: number | null; memUsed: number | null; memTotal: number | null }>;
  error?: string;
}

/**
 * Node CPU and memory, read live every 5 seconds for organizations that have
 * a hypervisor page open (a heartbeat that lapses after 20 s). Read-only;
 * kept in Redis for 30 s and not stored. Each integration is read by one
 * pass at a time, so a slow panel can't pile up requests.
 */
export function createVirtLiveLoop(deps: { provisioning: ProvisioningDeps; redis: Redis; logger: Pick<Logger, 'warn'> }) {
  const running = new Set<string>();
  return async () => {
    if (deps.redis.status !== 'ready') return;
    const now = Date.now();
    await deps.redis.zremrangebyscore(VIRT_WATCH_KEY, '-inf', String(now));
    const orgs = await deps.redis.zrange(VIRT_WATCH_KEY, '0', '-1');
    if (!orgs.length) return;
    const db = deps.provisioning.db;
    const list = await db
      .select()
      .from(virtIntegrations)
      .where(and(inArray(virtIntegrations.orgId, orgs), eq(virtIntegrations.enabled, true)));
    await Promise.all(
      list
        .filter((i) => !running.has(i.id))
        .map(async (i) => {
          running.add(i.id);
          try {
            const client = virtClientFor(deps.provisioning, i);
            if (!client.hostLoads) return;
            const hosts = await db.select({ externalId: virtHosts.externalId }).from(virtHosts).where(eq(virtHosts.integrationId, i.id));
            const loads = await client.hostLoads(hosts.map((h) => h.externalId));
            const snap: VirtLiveSnapshot = { at: new Date().toISOString(), hosts: Object.fromEntries(loads) };
            await deps.redis.set(virtLiveKey(i.id), JSON.stringify(snap), 'EX', 30);
          } catch (e) {
            const snap: VirtLiveSnapshot = { at: new Date().toISOString(), hosts: {}, error: ((e as { cause?: Error })?.cause?.message || (e as Error).message || 'Read failed').slice(0, 300) };
            await deps.redis.set(virtLiveKey(i.id), JSON.stringify(snap), 'EX', 30).catch(() => undefined);
          } finally {
            running.delete(i.id);
          }
        }),
    );
  };
}

export interface AccessResult {
  /** 3389 (RDP, Windows) or 22 (SSH, everything else). */
  port: number;
  ip: string;
  ok: boolean;
  /** Time to complete the TCP handshake. */
  ms: number | null;
  error: string | null;
  at: string;
}
export interface AccessSnapshot {
  at: string;
  results: Record<string, AccessResult>;
}

/** RDP for Windows guests (by OS or name), SSH otherwise. */
export const accessPort = (g: { osName: string | null; name: string }) => (/win/i.test(g.osName ?? '') || (!g.osName && /win/i.test(g.name)) ? 3389 : 22);

/** A TCP handshake only: nothing is sent, no login is attempted. */
export function tcpProbe(ip: string, port: number, timeoutMs: number): Promise<{ ok: boolean; ms: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.connect({ host: ip, port });
    const done = (ok: boolean, error: string | null) => {
      sock.destroy();
      resolve({ ok, ms: ok ? Date.now() - started : null, error });
    };
    sock.setTimeout(timeoutMs, () => done(false, 'No answer'));
    sock.once('connect', () => done(true, null));
    sock.once('error', (e: NodeJS.ErrnoException) => done(false, e.code === 'ECONNREFUSED' ? 'Refused' : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? 'Unreachable' : (e.code ?? e.message)));
  });
}

/**
 * Is each running VM reachable for remote access? A TCP handshake to its first
 * IPv4 address on 3389 (Windows) or 22 (others), every 5 s while someone has
 * a hypervisor page open; at most `concurrency` at once, `timeoutMs` each.
 * Read-only (no data, no login); results kept in Redis for 30 s, not stored.
 */
export function createVirtAccessLoop(deps: { db: ProvisioningDeps['db']; redis: Redis; probe?: typeof tcpProbe; concurrency?: number; timeoutMs?: number }) {
  const running = new Set<string>();
  const probe = deps.probe ?? tcpProbe;
  return async () => {
    if (deps.redis.status !== 'ready') return;
    await deps.redis.zremrangebyscore(VIRT_WATCH_KEY, '-inf', String(Date.now()));
    const orgs = (await deps.redis.zrange(VIRT_WATCH_KEY, '0', '-1')).filter((o) => !running.has(o));
    await Promise.all(
      orgs.map(async (orgId) => {
        running.add(orgId);
        try {
          const guests = await deps.db
            .select({ id: virtGuests.id, name: virtGuests.name, osName: virtGuests.osName, ips: virtGuests.ipAddresses })
            .from(virtGuests)
            .where(and(eq(virtGuests.orgId, orgId), eq(virtGuests.status, 'running'), isNull(virtGuests.missingSince)));
          const targets = guests.map((g) => ({ id: g.id, ip: g.ips.find((x) => net.isIPv4(x)) ?? g.ips.find((x) => net.isIPv6(x)), port: accessPort(g) })).filter((t): t is { id: string; ip: string; port: number } => !!t.ip);
          const prev = await deps.redis.get(virtAccessKey(orgId)).catch(() => null);
          const results: Record<string, AccessResult> = {};
          if (prev) {
            // Keep the last result of VMs still being checked; drop VMs no longer running.
            const old = (JSON.parse(prev) as AccessSnapshot).results;
            for (const t of targets) if (old[t.id]) results[t.id] = old[t.id]!;
          }
          const queue = [...targets];
          const work = async () => {
            for (let t = queue.shift(); t; t = queue.shift()) {
              const r = await probe(t.ip, t.port, deps.timeoutMs ?? 1500);
              results[t.id] = { port: t.port, ip: t.ip, ...r, at: new Date().toISOString() };
            }
          };
          await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 128, queue.length) }, work));
          const snap: AccessSnapshot = { at: new Date().toISOString(), results };
          await deps.redis.set(virtAccessKey(orgId), JSON.stringify(snap), 'EX', 30);
        } finally {
          running.delete(orgId);
        }
      }),
    );
  };
}
