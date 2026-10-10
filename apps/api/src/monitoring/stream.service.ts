import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import type { Logger } from 'pino';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LOGGER } from '../common/logger';
import { MONITORING_PATTERN, type MonitoringEvent } from './events';

type Listener = (ev: MonitoringEvent) => void;

/**
 * One Redis subscription per API process, fanned out in memory to the
 * browsers connected over SSE. The worker publishes after the data is
 * stored, so a missed event only delays the screen until the next poll or
 * page refresh. Subscribing is lazy: no Redis connection until the first
 * browser connects.
 */
@Injectable()
export class MonitoringStream implements OnApplicationShutdown {
  static readonly MAX_LISTENERS = 500;
  static readonly MAX_PER_USER = 10;
  private readonly perUser = new Map<string, number>();
  private sub: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private count = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  get live(): boolean {
    return this.sub?.status === 'ready';
  }

  /** Resolves when the subscription is up (or after `ms`), so the first status a browser sees is accurate. */
  async ready(ms = 2000): Promise<boolean> {
    this.ensure();
    const sub = this.sub!;
    if (sub.status === 'ready') return true;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      sub.once('ready', () => (clearTimeout(t), resolve()));
    });
    return this.live;
  }

  get size(): number {
    return this.count;
  }

  private ensure() {
    if (this.sub) return;
    const sub = new Redis(this.config.REDIS_URL, { maxRetriesPerRequest: null, retryStrategy: (n) => Math.min(n * 1000, 10_000) });
    sub.on('error', () => undefined);
    sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      const orgId = channel.slice(channel.lastIndexOf(':') + 1);
      const set = this.listeners.get(orgId);
      if (!set?.size) return;
      let ev: MonitoringEvent;
      try {
        ev = JSON.parse(message) as MonitoringEvent;
      } catch {
        return;
      }
      for (const l of set) {
        try {
          l(ev);
        } catch (e) {
          this.logger.warn({ err: (e as Error).message }, 'monitoring stream listener failed');
        }
      }
    });
    sub.psubscribe(MONITORING_PATTERN).catch((e: Error) => this.logger.warn({ err: e.message }, 'monitoring stream subscribe failed'));
    this.sub = sub;
  }

  /** Registers a listener for one organization's events; returns the unsubscribe function, or null when full. */
  subscribe(orgId: string, l: Listener, userId = ''): (() => void) | null {
    if (this.count >= MonitoringStream.MAX_LISTENERS) return null;
    if ((this.perUser.get(userId) ?? 0) >= MonitoringStream.MAX_PER_USER) return null;
    this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);
    this.ensure();
    let set = this.listeners.get(orgId);
    if (!set) this.listeners.set(orgId, (set = new Set()));
    set.add(l);
    this.count++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set.delete(l);
      this.count--;
      const n = (this.perUser.get(userId) ?? 1) - 1;
      if (n > 0) this.perUser.set(userId, n);
      else this.perUser.delete(userId);
      if (!set.size) this.listeners.delete(orgId);
    };
  }

  onApplicationShutdown() {
    this.sub?.disconnect();
    this.sub = null;
  }
}
