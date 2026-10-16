import { BlockList, isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import type { SecretBox } from '../../common/secret-box';
import { credentialContext, type AdapterTarget } from '../../network/discovery/types';
import { RouterOsApiClient } from '../adapters/routeros-api';
import { assertDeviceHost } from '../device-allow';
import { redact } from '../processor';
import { loadOwnPrefixes } from './collector';

/**
 * Real-time bandwidth per IP from MikroTik Torch. While someone has the live
 * view open (a heartbeat in Redis, per organization), the worker keeps one
 * RouterOS API connection per router streaming `/tool/torch` on the router's
 * uplink interface, which reports every second the rate between each pair of
 * addresses. Only addresses in your IPAM prefixes are kept. Read-only: Torch is
 * a monitor, nothing on the router changes; it stops when nobody watches.
 */

export const FLOW_WATCH_KEY = 'cdcim:flows:watch';
export const flowRealtimeKey = (orgId: string) => `cdcim:flows:realtime:${orgId}`;

type Row = Record<string, unknown>;

export interface RealtimeSnapshot {
  at: string;
  /** Torch rates are per second. */
  windowSeconds: 1;
  routers: { id: string; name: string; interface: string; ok: boolean; error: string | null; lastAt: string | null }[];
  totals: { inBps: number; outBps: number; addresses: number };
  ips: { ip: string; inBps: number; outBps: number }[];
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const has = (list: BlockList, ip: string) => {
  const f = isIP(ip);
  return f !== 0 && list.check(ip, f === 4 ? 'ipv4' : 'ipv6');
};

/**
 * Per-address rates from one Torch snapshot. Torch's tx/rx are relative to the
 * interface: on an uplink, rx is traffic arriving from the internet (download
 * for your address in the pair) and tx traffic leaving (upload). On an
 * interface facing your customers it is the other way round.
 */
export function torchRates(rows: Row[], own: BlockList, direction: 'uplink' | 'downlink') {
  const out = new Map<string, [number, number]>();
  for (const r of rows) {
    const src = String(r['src-address'] ?? '').replace(/\/(32|128)$/, '');
    const dst = String(r['dst-address'] ?? '').replace(/\/(32|128)$/, '');
    const rx = num(r.rx);
    const tx = num(r.tx);
    const down = direction === 'uplink' ? rx : tx;
    const up = direction === 'uplink' ? tx : rx;
    for (const ip of [src, dst]) {
      if (!ip || !has(own, ip)) continue;
      const c = out.get(ip) ?? [0, 0];
      c[0] += down;
      c[1] += up;
      out.set(ip, c);
    }
  }
  return out;
}

interface Router {
  id: string;
  orgId: string;
  name: string;
  iface: string;
  direction: 'uplink' | 'downlink';
  target: AdapterTarget;
}
interface Session {
  router: Router;
  client: RouterOsApiClient | null;
  stop: (() => void) | null;
  latest: Map<string, [number, number]>;
  lastAt: number;
  error: string | null;
  starting: boolean;
  retryAt: number;
}

export interface TorchDeps {
  db: Db;
  secrets: SecretBox;
  redis: Pick<Redis, 'zremrangebyscore' | 'zrange' | 'set'>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** For tests: a way to open the RouterOS API client. */
  open?: (t: AdapterTarget) => Promise<RouterOsApiClient>;
}

async function openClient(t: AdapterTarget) {
  await assertDeviceHost(t.host);
  const c = new RouterOsApiClient(t);
  await c.connect();
  try {
    await c.login();
  } catch (e) {
    c.close();
    throw e;
  }
  return c;
}

export function createTorchLoop(deps: TorchDeps) {
  const sessions = new Map<string, Session>();
  let routers = new Map<string, Router[]>();
  let routersAt = 0;
  let own = new Map<string, BlockList>();
  let ownAt = 0;
  const open = deps.open ?? openClient;

  async function loadRouters() {
    // Exporters with a real-time interface whose device has a RouterOS API credential.
    const r = await deps.db.execute<{ id: string; org_id: string; name: string; live_interface: string; live_direction: string; device_id: string; host: string; port: number | null; username: string | null; params: Record<string, unknown>; secret_enc: string; kind: string }>(sql`
      select e.id, e.org_id, e.name, e.live_interface, e.live_direction, c.device_id, c.host, c.port, c.username, c.params, c.secret_enc, c.kind
        from flow_exporters e join device_credentials c on c.device_id = e.device_id and c.kind = 'routeros_api'
       where e.enabled and e.live_interface is not null and c.host is not null`);
    const next = new Map<string, Router[]>();
    for (const x of r.rows) {
      let secret: AdapterTarget['secret'];
      try {
        secret = JSON.parse(deps.secrets.decrypt(x.secret_enc, credentialContext(x.org_id, x.device_id, 'routeros_api', x.host, x.port))) as AdapterTarget['secret'];
      } catch {
        continue;
      }
      const list = next.get(x.org_id) ?? [];
      list.push({ id: x.id, orgId: x.org_id, name: x.name, iface: x.live_interface, direction: x.live_direction === 'downlink' ? 'downlink' : 'uplink', target: { host: x.host, port: x.port, username: x.username, params: { ...(x.params as AdapterTarget['params']), timeoutMs: 5000 }, secret } });
      next.set(x.org_id, list);
    }
    routers = next;
    routersAt = Date.now();
  }

  function stopSession(id: string) {
    const s = sessions.get(id);
    if (!s) return;
    try {
      s.stop?.();
    } catch {
      /* already closed */
    }
    s.client?.close();
    sessions.delete(id);
  }

  async function start(router: Router) {
    const s: Session = sessions.get(router.id) ?? { router, client: null, stop: null, latest: new Map(), lastAt: 0, error: null, starting: false, retryAt: 0 };
    sessions.set(router.id, s);
    if (s.starting || Date.now() < s.retryAt) return;
    s.starting = true;
    try {
      const client = await open(router.target);
      s.client = client;
      const args: Record<string, string> = { interface: router.iface, 'src-address': '0.0.0.0/0', 'dst-address': '0.0.0.0/0', 'src-address6': '::/0', 'dst-address6': '::/0' };
      s.stop = client.torch(
        args,
        (rows) => {
          const list = own.get(router.orgId) ?? new BlockList();
          s.latest = torchRates(rows, list, router.direction);
          s.lastAt = Date.now();
          s.error = null;
        },
        (e) => {
          s.error = e ? redact(e.message, router.target.secret as Record<string, unknown>) : 'Torch stopped';
          s.client?.close();
          s.client = null;
          s.stop = null;
          s.retryAt = Date.now() + 5000;
        },
      );
      deps.logger.info({ exporter: router.name, iface: router.iface }, 'real-time torch started');
    } catch (e) {
      s.error = redact((e as Error).message, router.target.secret as Record<string, unknown>);
      s.retryAt = Date.now() + 10_000;
      deps.logger.warn({ exporter: router.name, err: s.error }, 'real-time torch could not start');
    } finally {
      s.starting = false;
    }
  }

  return async function tick(): Promise<number> {
    const now = Date.now();
    await deps.redis.zremrangebyscore(FLOW_WATCH_KEY, '-inf', String(now));
    const watched = new Set(await deps.redis.zrange(FLOW_WATCH_KEY, '0', '-1'));
    if (!watched.size) {
      for (const id of [...sessions.keys()]) stopSession(id);
      return 0;
    }
    if (now - routersAt > 30_000) await loadRouters();
    if (now - ownAt > 60_000) {
      own = await loadOwnPrefixes(deps.db);
      ownAt = now;
    }
    const wanted = new Set<string>();
    for (const orgId of watched) for (const r of routers.get(orgId) ?? []) wanted.add(r.id);
    for (const id of [...sessions.keys()]) if (!wanted.has(id)) stopSession(id);
    for (const orgId of watched) {
      const list = routers.get(orgId) ?? [];
      for (const r of list) {
        const s = sessions.get(r.id);
        // A stream that went quiet for 10 s is restarted.
        if (s?.client && s.lastAt && now - s.lastAt > 10_000) stopSession(r.id);
        if (!sessions.get(r.id)?.client) void start(r);
      }
      if (!list.length) continue;
      const sum = new Map<string, [number, number]>();
      for (const r of list) {
        const s = sessions.get(r.id);
        if (!s || now - s.lastAt > 3000) continue;
        for (const [ip, c] of s.latest) {
          const t = sum.get(ip);
          if (t) (t[0] += c[0]), (t[1] += c[1]);
          else sum.set(ip, [c[0], c[1]]);
        }
      }
      let inB = 0;
      let outB = 0;
      const ips = [...sum.entries()].map(([ip, c]) => ((inB += c[0]), (outB += c[1]), { ip, inBps: c[0], outBps: c[1] })).sort((a, b) => b.inBps + b.outBps - (a.inBps + a.outBps));
      const snap: RealtimeSnapshot = {
        at: new Date(now).toISOString(),
        windowSeconds: 1,
        routers: list.map((r) => {
          const s = sessions.get(r.id);
          return { id: r.id, name: r.name, interface: r.iface, ok: !!s && now - s.lastAt <= 3000, error: s?.error ?? (s?.lastAt ? null : 'Starting…'), lastAt: s?.lastAt ? new Date(s.lastAt).toISOString() : null };
        }),
        totals: { inBps: inB, outBps: outB, addresses: ips.length },
        ips: ips.slice(0, 1000),
      };
      await deps.redis.set(flowRealtimeKey(orgId), JSON.stringify(snap), 'EX', 5);
    }
    return sessions.size;
  };
}
