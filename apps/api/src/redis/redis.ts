import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

/**
 * Shared Redis connection. Phase 1 uses it for readiness checks; Phase 4+
 * uses it for BullMQ polling queues and distributed locks. `lazyConnect`
 * keeps the API starting even if Redis is briefly unavailable — readiness
 * reports it instead.
 */
export function createRedis(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  client.on('error', () => {
    // Connection errors are surfaced via /health/ready; avoid log floods here.
  });
  return client;
}
