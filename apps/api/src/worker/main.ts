import { Worker } from 'bullmq';
import { loadConfig } from '../config/config';
import { createLogger } from '../common/logger';
import { createDb, createPool } from '../db/db';
import { SecretBox } from '../common/secret-box';
import { DISCOVERY_QUEUE, redisOptionsFromUrl, type DiscoveryJob } from '../network/discovery/queue';
import { failOrphanedRuns, processRun } from './processor';

/**
 * Discovery worker: a separate process from the API so that device
 * credentials are only ever decrypted here, and slow or hanging devices can't
 * tie up API requests. Run exactly one instance (systemd unit
 * crapplet-dcim-worker). It performs read-only collection only.
 */
async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'development', 'crapplet-dcim-worker');
  const pool = createPool(config.DATABASE_URL, 5);
  const db = createDb(pool);
  const secrets = new SecretBox(config.CDCIM_ENCRYPTION_KEYS);
  const concurrency = Math.max(1, Math.min(16, Number(process.env.DISCOVERY_CONCURRENCY ?? 4) || 4));

  const orphaned = await failOrphanedRuns(db);
  if (orphaned) logger.warn({ orphaned }, 'marked runs interrupted by a previous worker as failed');

  const worker = new Worker<DiscoveryJob>(
    DISCOVERY_QUEUE,
    async (job) => {
      await processRun({ db, secrets, logger }, job.data.runId);
    },
    { connection: redisOptionsFromUrl(config.REDIS_URL), concurrency },
  );
  worker.on('error', (err) => logger.error({ err: err.message }, 'queue error'));
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'job failed'));
  logger.info({ concurrency }, 'Crapplet DCIM discovery worker started');

  const stop = async (signal: string) => {
    logger.info({ signal }, 'stopping worker');
    await worker.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(`Fatal worker error: ${(err as Error).message}\n`);
  process.exit(1);
});
