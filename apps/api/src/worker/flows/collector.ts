import { createSocket, type Socket } from 'node:dgram';
import { BlockList, isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { FlowDecodeError, TemplateCache, decodeFlowPacket, type FlowRecord } from './netflow';

/**
 * UDP collector for flow records (NetFlow v5/v9, IPFIX) from registered
 * exporters, e.g. MikroTik "Traffic Flow". For every record it adds the bytes
 * to the destination address as download and to the source address as upload,
 * but only for addresses inside your IPAM prefixes (internet addresses are not
 * stored). Totals are kept per minute and per hour. Read-only: nothing is sent
 * back to the router.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const MAX_KEYS = 500_000;
const FLUSH_MS = 10_000;

interface Exporter {
  id: string;
  orgId: string;
  enabled: boolean;
  samplingRate: number;
}
interface Stats {
  packets: number;
  records: number;
  unmatched: number;
  bad: number;
  lastAt: Date | null;
  version: number | null;
  error: string | null;
}
type Counts = [inBytes: number, outBytes: number, inPackets: number, outPackets: number];

export interface FlowCollectorStatus {
  listening: boolean;
  port: number;
  error: string | null;
  /** Sources that sent packets but are not registered exporters (most recent first). */
  unknownSources: { address: string; packets: number; lastAt: string }[];
  templates: number;
  droppedKeys: number;
}

const norm = (a: string) => (a.startsWith('::ffff:') ? a.slice(7) : a);

/** Splits a flow's bytes over the minutes it lasted (proportionally), or puts them at `now`. */
export function spread(start: number | null, end: number | null, now: number): [bucket: number, share: number][] {
  let s = start ?? now;
  let e = end ?? start ?? now;
  // Exporter clocks can be wrong or uptime can wrap: implausible times fall back to the arrival time.
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s || e > now + 60_000 || s < now - 3 * HOUR) s = e = now;
  if (e - s > HOUR) s = e - HOUR;
  const first = Math.floor(s / MINUTE) * MINUTE;
  const last = Math.floor(e / MINUTE) * MINUTE;
  if (first === last) return [[first, 1]];
  const span = e - s;
  const out: [number, number][] = [];
  for (let b = first; b <= last; b += MINUTE) {
    const overlap = Math.min(e, b + MINUTE) - Math.max(s, b);
    if (overlap > 0) out.push([b, overlap / span]);
  }
  return out;
}

export class FlowAggregator {
  /** org → minute bucket → address → counts */
  pending = new Map<string, Map<number, Map<string, Counts>>>();
  keys = 0;
  droppedKeys = 0;

  /** Adds one record; returns false when neither address is one of yours. */
  add(orgId: string, own: BlockList, r: FlowRecord, multiplier: number, now: number): boolean {
    const srcOwn = check(own, r.src);
    const dstOwn = check(own, r.dst);
    if (!srcOwn && !dstOwn) return false;
    const bytes = r.bytes * multiplier;
    const packets = r.packets * multiplier;
    for (const [bucket, share] of spread(r.start, r.end, now)) {
      if (dstOwn) this.bump(orgId, bucket, r.dst, 0, bytes * share, packets * share);
      if (srcOwn) this.bump(orgId, bucket, r.src, 1, bytes * share, packets * share);
    }
    return true;
  }

  private bump(orgId: string, bucket: number, address: string, dir: 0 | 1, bytes: number, packets: number) {
    let byBucket = this.pending.get(orgId);
    if (!byBucket) this.pending.set(orgId, (byBucket = new Map()));
    let byAddr = byBucket.get(bucket);
    if (!byAddr) byBucket.set(bucket, (byAddr = new Map()));
    let c = byAddr.get(address);
    if (!c) {
      if (this.keys >= MAX_KEYS) {
        this.droppedKeys++;
        return;
      }
      byAddr.set(address, (c = [0, 0, 0, 0]));
      this.keys++;
    }
    c[dir] += bytes;
    c[dir + 2]! += packets;
  }

  take() {
    const p = this.pending;
    this.pending = new Map();
    this.keys = 0;
    return p;
  }
}

function check(list: BlockList, ip: string) {
  const fam = isIP(ip);
  return fam !== 0 && list.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
}

/** Writes pending per-minute counts, and the same added to the hour, with additive upserts. */
export async function flushTraffic(db: Db, pending: Map<string, Map<number, Map<string, Counts>>>) {
  let rows = 0;
  for (const [orgId, byBucket] of pending) {
    const minute: { bucket: number; address: string; c: Counts }[] = [];
    const hour = new Map<string, { bucket: number; address: string; c: Counts }>();
    for (const [bucket, byAddr] of byBucket) {
      const hb = Math.floor(bucket / HOUR) * HOUR;
      for (const [address, c] of byAddr) {
        minute.push({ bucket, address, c });
        const k = `${hb}|${address}`;
        const h = hour.get(k);
        if (h) for (let i = 0; i < 4; i++) h.c[i]! += c[i]!;
        else hour.set(k, { bucket: hb, address, c: [...c] as Counts });
      }
    }
    for (const [table, list] of [
      ['ip_traffic_1m', minute],
      ['ip_traffic_1h', [...hour.values()]],
    ] as const) {
      for (let i = 0; i < list.length; i += 1000) {
        const chunk = list.slice(i, i + 1000);
        const values = sql.join(
          chunk.map((r) => sql`(${orgId}::uuid, ${new Date(r.bucket).toISOString()}::timestamptz, ${r.address}::inet, ${Math.round(r.c[0])}, ${Math.round(r.c[1])}, ${Math.round(r.c[2])}, ${Math.round(r.c[3])})`),
          sql`, `,
        );
        const t = sql.raw(table);
        await db.execute(sql`
          insert into ${t} (org_id, bucket, address, in_bytes, out_bytes, in_packets, out_packets) values ${values}
          on conflict (org_id, bucket, address) do update set
            in_bytes = ${t}.in_bytes + excluded.in_bytes, out_bytes = ${t}.out_bytes + excluded.out_bytes,
            in_packets = ${t}.in_packets + excluded.in_packets, out_packets = ${t}.out_packets + excluded.out_packets`);
      }
    }
    rows += minute.length;
  }
  return rows;
}

/** Your IPAM prefixes per organization, as fast lookup lists. */
export async function loadOwnPrefixes(db: Db) {
  const r = await db.execute<{ org_id: string; prefix: string }>(sql`select org_id, prefix::text as prefix from prefixes where masklen(prefix) > 0`);
  const lists = new Map<string, BlockList>();
  for (const row of r.rows) {
    const [addr, len] = row.prefix.split('/');
    const fam = isIP(addr ?? '');
    if (!fam) continue;
    let l = lists.get(row.org_id);
    if (!l) lists.set(row.org_id, (l = new BlockList()));
    l.addSubnet(addr!, Number(len), fam === 4 ? 'ipv4' : 'ipv6');
  }
  return lists;
}

export async function startFlowCollector(deps: { db: Db; logger: Logger }, opts: { port: number; bind: string }) {
  const { db, logger } = deps;
  const cache = new TemplateCache();
  const agg = new FlowAggregator();
  let exporters = new Map<string, Exporter>();
  let own = new Map<string, BlockList>();
  const stats = new Map<string, Stats>();
  const unknown = new Map<string, { packets: number; lastAt: number }>();
  const status: FlowCollectorStatus = { listening: false, port: opts.port, error: null, unknownSources: [], templates: 0, droppedKeys: 0 };

  const reload = async () => {
    const r = await db.execute<{ id: string; org_id: string; address: string; enabled: boolean; sampling_rate: number }>(sql`select id, org_id, host(address) as address, enabled, sampling_rate from flow_exporters`);
    exporters = new Map(r.rows.map((x) => [x.address, { id: x.id, orgId: x.org_id, enabled: x.enabled, samplingRate: x.sampling_rate }]));
    own = await loadOwnPrefixes(db);
  };
  await reload().catch((e) => logger.error({ err: (e as Error).message }, 'flow collector: could not load exporters'));

  const onMessage = (msg: Buffer, from: string) => {
    const address = norm(from);
    const exp = exporters.get(address);
    if (!exp || !exp.enabled) {
      const u = unknown.get(address) ?? { packets: 0, lastAt: 0 };
      u.packets++;
      u.lastAt = Date.now();
      unknown.set(address, u);
      if (unknown.size > 50) unknown.delete(unknown.keys().next().value!);
      return;
    }
    let st = stats.get(exp.id);
    if (!st) stats.set(exp.id, (st = { packets: 0, records: 0, unmatched: 0, bad: 0, lastAt: null, version: null, error: null }));
    st.packets++;
    st.lastAt = new Date();
    try {
      const { version, records } = decodeFlowPacket(msg, address, cache);
      st.version = version;
      const list = own.get(exp.orgId);
      const now = Date.now();
      for (const r of records) {
        st.records++;
        // Sampling announced by the router wins; otherwise the rate set on the exporter.
        const mult = r.sampling > 1 ? r.sampling : exp.samplingRate;
        if (!list || !agg.add(exp.orgId, list, r, mult, now)) st.unmatched++;
      }
    } catch (e) {
      st.bad++;
      st.error = e instanceof FlowDecodeError ? e.message : `decode failed: ${(e as Error).message}`;
    }
  };

  const flush = async () => {
    const pending = agg.take();
    const n = await flushTraffic(db, pending);
    for (const [id, st] of stats) {
      if (!st.packets) continue;
      await db.execute(sql`
        update flow_exporters set packets = packets + ${st.packets}, records = records + ${st.records}, unmatched_records = unmatched_records + ${st.unmatched},
               bad_packets = bad_packets + ${st.bad}, last_packet_at = ${st.lastAt!.toISOString()}::timestamptz, last_version = ${st.version},
               last_error = ${st.error}, updated_at = now()
         where id = ${id}`);
    }
    stats.clear();
    status.templates = cache.count();
    status.droppedKeys += agg.droppedKeys;
    agg.droppedKeys = 0;
    status.unknownSources = [...unknown.entries()]
      .sort((a, b) => b[1].lastAt - a[1].lastAt)
      .slice(0, 10)
      .map(([address, u]) => ({ address, packets: u.packets, lastAt: new Date(u.lastAt).toISOString() }));
    return n;
  };

  let socket: Socket | null = null;
  if (opts.port > 0) {
    socket = createSocket({ type: isIP(opts.bind) === 6 ? 'udp6' : 'udp4', reuseAddr: true });
    socket.on('message', (msg, rinfo) => onMessage(msg, rinfo.address));
    socket.on('error', (e) => {
      status.listening = false;
      status.error = e.message;
      logger.error({ err: e.message, port: opts.port }, 'flow collector socket error');
    });
    await new Promise<void>((resolve) => {
      socket!.once('listening', () => {
        status.listening = true;
        status.error = null;
        // Bursts from busy routers: a bigger receive buffer loses fewer datagrams.
        try {
          socket!.setRecvBufferSize(8 * 1024 * 1024);
        } catch {
          /* the OS limit applies */
        }
        resolve();
      });
      socket!.once('error', () => resolve());
      socket!.bind(opts.port, opts.bind);
    });
    if (status.listening) logger.info({ port: opts.port, bind: opts.bind }, 'flow collector listening (NetFlow v5/v9, IPFIX)');
  } else status.error = 'Disabled (CDCIM_FLOW_PORT=0)';

  let busy = false;
  const timers = [
    setInterval(() => {
      if (busy) return;
      busy = true;
      flush()
        .catch((e) => logger.error({ err: (e as Error).message }, 'flow collector: flush failed'))
        .finally(() => (busy = false));
    }, FLUSH_MS),
    setInterval(() => void reload().catch(() => undefined), 30_000),
  ];

  return {
    status: () => status,
    /** For tests: feed a datagram as if it arrived from `from`. */
    receive: onMessage,
    flush,
    reload,
    close: async () => {
      timers.forEach(clearInterval);
      await flush().catch(() => undefined);
      await new Promise<void>((r) => (socket ? socket.close(() => r()) : r()));
    },
  };
}

/** Removes per-minute data after `minuteDays` and hourly data after `hourDays`. */
export async function applyFlowRetention(db: Db, minuteDays = 7, hourDays = 400) {
  const a = await db.execute(sql`delete from ip_traffic_1m where bucket < now() - make_interval(days => ${minuteDays})`);
  const b = await db.execute(sql`delete from ip_traffic_1h where bucket < now() - make_interval(days => ${hourDays})`);
  return { minute: a.rowCount ?? 0, hourly: b.rowCount ?? 0 };
}
