import { Queue, Worker } from 'bullmq';
import { loadConfig } from '../config/config';
import { createLogger } from '../common/logger';
import { createDb, createPool } from '../db/db';
import { SecretBox } from '../common/secret-box';
import { AuditService } from '../audit/audit.service';
import { DISCOVERY_QUEUE, redisOptionsFromUrl, type WorkerJob } from '../network/discovery/queue';
import { DiscoveryService } from '../network/discovery/discovery.service';
import type { DiscoveryQueue } from '../network/discovery/queue';
import type { IpamService } from '../network/ipam.service';
import { failOrphanedRuns, processRun } from './processor';
import { runDueSchedules } from './scheduler';
import { sweepDns, testDnsServer } from './dns/sync';
import Redis from 'ioredis';
import { createPollLoop, type PollOutcome } from './monitoring/poller';
import { applyRetention, rollup } from './monitoring/rollup';
import { closeUnmonitoredAlerts, evaluateAlerts } from './monitoring/alerts';
import { deliverDue } from './monitoring/notify';
import { monitoringChannel, type MonitoringEvent } from '../monitoring/events';
import { createPowerPollLoop } from './power/poller';
import { applyPowerRetention, rollupPower } from './power/rollup';

/**
 * Background worker, a separate process from the API so that device and DNS
 * credentials are only ever decrypted here and slow devices can't tie up API
 * requests. It
 *  - runs queued discovery runs (read-only collection) and DNS server checks,
 *  - starts scheduled discoveries that are due (every minute),
 *  - pushes pending IPAM DNS changes to the configured DNS servers,
 *  - polls interface counters of monitored devices (read-only), stores rates,
 *    downsamples and expires them, evaluates alert rules and delivers
 *    notifications. Polling runs whether or not anyone has the UI open,
 *  - reads equipment power (Redfish, IPMI DCMI, PDUs, switch supplies),
 *    builds hourly energy and expires old readings.
 * Run one instance (systemd unit crapplet-dcim-worker); schedules and DNS rows
 * are claimed with row locks, so a second instance would not duplicate work.
 */
async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development', 'crapplet-dcim-worker');
  const pool = createPool(config.DATABASE_URL, 12);
  const db = createDb(pool);
  const secrets = new SecretBox(config.CDCIM_ENCRYPTION_KEYS);
  const concurrency = Math.max(1, Math.min(16, Number(process.env.DISCOVERY_CONCURRENCY ?? 4) || 4));
  const connection = redisOptionsFromUrl(config.REDIS_URL);

  // Only the read-only preview helpers are used here (no queue, no IPAM writes).
  const discovery = new DiscoveryService(db, new AuditService(db), null as unknown as DiscoveryQueue, null as unknown as IpamService);
  const deps = { db, secrets, logger, changes: (orgId: string, deviceId: string, r: Parameters<DiscoveryService['changeSummary']>[3]) => discovery.changeSummary(db, orgId, deviceId, r) };

  const orphaned = await failOrphanedRuns(db);
  if (orphaned) logger.warn({ orphaned }, 'marked runs interrupted by a previous worker as failed');

  const producer = new Queue<WorkerJob>(DISCOVERY_QUEUE, { connection });
  const worker = new Worker<WorkerJob>(
    DISCOVERY_QUEUE,
    async (job) => {
      if (job.name === 'dns-test' && 'serverId' in job.data) {
        const r = await testDnsServer({ db, secrets }, job.data.serverId);
        logger.info({ serverId: job.data.serverId, ok: r.ok }, 'dns server checked');
      } else if ('runId' in job.data) {
        await processRun(deps, job.data.runId);
      }
    },
    { connection, concurrency },
  );
  worker.on('error', (err) => logger.error({ err: err.message }, 'queue error'));
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'job failed'));

  // Periodic tasks; each skips a tick while its previous run is still going.
  const every = (name: string, ms: number, fn: () => Promise<unknown>) => {
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        await fn();
      } catch (e) {
        logger.error({ task: name, err: (e as Error).message }, 'periodic task failed');
      } finally {
        busy = false;
      }
    };
    void tick();
    return setInterval(() => void tick(), ms);
  };
  // Live updates for browsers (best effort: the data is already in PostgreSQL).
  const pub = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: (n) => Math.min(n * 1000, 10_000) });
  pub.on('error', () => undefined);
  const publish = (orgId: string, ev: MonitoringEvent) => pub.publish(monitoringChannel(orgId), JSON.stringify(ev)).catch(() => undefined);
  const onPolled = async (o: PollOutcome) => {
    void publish(o.orgId, { type: 'rates', deviceId: o.deviceId, at: o.at.toISOString(), ok: o.ok, error: o.error, ports: o.ports.map(({ name: _n, ...p }) => p) });
    for (const ev of await evaluateAlerts(db, o)) {
      const { orgId, type: _t, ...rest } = ev;
      void publish(orgId, { type: 'alert', ...rest });
    }
  };
  const pollConcurrency = Math.max(1, Math.min(64, Number(process.env.POLL_CONCURRENCY ?? 16) || 16));

  const timers = [
    every('schedules', 60_000, async () => {
      const ids = await runDueSchedules(db, async (runId) => {
        await producer.add('run', { runId }, { jobId: runId, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 });
      });
      if (ids.length) logger.info({ runs: ids.length }, 'scheduled discoveries started');
    }),
    every('dns', 15_000, async () => {
      const n = await sweepDns({ db, secrets });
      if (n) logger.info({ addresses: n }, 'dns changes pushed');
    }),
    every('poll', 2_000, createPollLoop({ db, secrets, logger, onPolled }, pollConcurrency)),
    every('rollup', 60_000, async () => {
      await rollup(db);
      const closed = await closeUnmonitoredAlerts(db);
      if (closed) logger.info({ closed }, 'closed alerts of targets that are no longer polled');
    }),
    every('retention', 3_600_000, async () => {
      const r = await applyRetention(db);
      if (r.raw + r.fiveMinute + r.hourly) logger.info(r, 'old monitoring data removed');
    }),
    every('power-poll', 2_000, createPowerPollLoop({ db, secrets, logger }, pollConcurrency)),
    every('power-rollup', 60_000, () => rollupPower(db)),
    every('power-retention', 3_600_000, async () => {
      const r = await applyPowerRetention(db);
      if (r.raw + r.hourly) logger.info(r, 'old power data removed');
    }),
    every('notify', 10_000, () => deliverDue({ db, secrets, logger, allowPrivate: process.env.CDCIM_NOTIFY_ALLOW_PRIVATE === 'true' })),
  ];
  logger.info({ concurrency }, 'Crapplet DCIM worker started (discovery, schedules, DNS, monitoring, power)');

  const stop = async (signal: string) => {
    logger.info({ signal }, 'stopping worker');
    timers.forEach(clearInterval);
    await worker.close().catch(() => undefined);
    await producer.close().catch(() => undefined);
    pub.disconnect();
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  // A stray rejection must not take down polling for every device.
  process.on('unhandledRejection', (err) => logger.error({ err: (err as Error)?.message ?? String(err) }, 'unhandled rejection'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`Fatal worker error: ${(err as Error).message}\n`);
  process.exit(1);
});
