import { and, eq, inArray } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { virtHosts, virtIntegrations } from '../../db/schema';
import { VIRT_WATCH_KEY, virtLiveKey } from '../../health/worker-heartbeat';
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
