import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../../config/config';

export const DISCOVERY_QUEUE = 'cdcim-discovery';
export interface DiscoveryJob {
  runId: string;
}

/** BullMQ connection options from a redis:// or rediss:// URL. */
export function redisOptionsFromUrl(url: string) {
  const u = new URL(url);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    // Required by BullMQ for blocking commands.
    maxRetriesPerRequest: null,
  };
}

/**
 * Producer side of the discovery queue. The API only enqueues run ids; the
 * separate worker process (src/worker) loads the run, decrypts the credential
 * and talks to the device.
 */
@Injectable()
export class DiscoveryQueue implements OnApplicationShutdown {
  private queue?: Queue<DiscoveryJob>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async add(runId: string): Promise<void> {
    this.queue ??= new Queue<DiscoveryJob>(DISCOVERY_QUEUE, { connection: { ...redisOptionsFromUrl(this.config.REDIS_URL), enableOfflineQueue: false } });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.add('run', { runId }, { jobId: runId, attempts: 1, removeOnComplete: 1000, removeOnFail: 1000 }),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('Timed out talking to Redis')), 5_000))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue?.close().catch(() => undefined);
  }
}
