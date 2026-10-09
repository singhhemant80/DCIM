import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, type Db } from '../db/db';
import { REDIS } from '../redis/redis';
import { Public } from '../auth/decorators';

const startedAt = new Date();

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('timeout')), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is up and the event loop responds. No dependencies checked. */
  @Get('live')
  live() {
    return { status: 'ok', startedAt };
  }

  /** Readiness: dependencies reachable. Returns 503 if any check fails (for load balancers / systemd checks). */
  @Get('ready')
  async ready() {
    const checks: Record<string, { ok: boolean; error?: string; latencyMs?: number }> = {};
    const run = async (name: string, fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await withTimeout(fn(), 2_000);
        checks[name] = { ok: true, latencyMs: Date.now() - t };
      } catch (err) {
        checks[name] = { ok: false, error: (err as Error).message };
      }
    };
    await Promise.all([
      run('database', () => this.db.execute(sql`select 1`)),
      run('redis', async () => {
        if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect().catch(() => undefined);
        return this.redis.ping();
      }),
    ]);
    const ok = Object.values(checks).every((c) => c.ok);
    const body = { status: ok ? 'ok' : 'degraded', checks };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }
}
