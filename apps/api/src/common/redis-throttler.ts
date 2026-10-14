import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type Redis from 'ioredis';

/**
 * Rate-limit counters in Redis, so every API process shares the same budget
 * per client (sign-in attempts included). Fixed window per key and throttler.
 *
 * If Redis can't be reached the request is counted in this process's memory
 * instead: limits still apply, per process, rather than being switched off.
 */
const SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); pttl = tonumber(ARGV[1]) end
local bttl = redis.call('PTTL', KEYS[2])
if bttl <= 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  bttl = tonumber(ARGV[3])
end
return {hits, pttl, bttl}
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly fallback = new ThrottlerStorageService();
  /** When Redis last failed; while recent, the in-memory store is used without waiting on Redis. */
  private failedAt = 0;

  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'cdcim:throttle:',
  ) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    if (Date.now() - this.failedAt < 10_000) return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const base = `${this.prefix}${throttlerName}:${key}`;
      const [hits, pttl, bttl] = (await this.redis.eval(SCRIPT, 2, `${base}:hits`, `${base}:block`, String(ttl), String(limit), String(blockDuration || ttl))) as [number, number, number];
      const blocked = bttl > 0;
      return { totalHits: hits, timeToExpire: Math.ceil(pttl / 1000), isBlocked: blocked, timeToBlockExpire: blocked ? Math.ceil(bttl / 1000) : 0 };
    } catch {
      this.failedAt = Date.now();
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  onApplicationShutdown() {
    this.fallback.onApplicationShutdown?.();
  }
}
