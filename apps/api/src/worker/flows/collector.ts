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
 * but only for addresses inside your IPAM prefixes. Totals are kept per minute
 * and per hour. For each of your addresses the busiest remote addresses (the
 * other side of its flows) are also kept, per hour and in the live view, so you
 * can see who it exchanges traffic with. Read-only: nothing is sent back to the
 * router.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const MAX_KEYS = 500_000;
const FLUSH_MS = 10_000;
/** Remote addresses kept per address and hour (the busiest), and in total in memory. */
export const PEERS_PER_ADDRESS = 100;
const PEER_KEYS = 300_000;
/** Written per address and hour. */
export const PEERS_STORED = 20;
/** Shown live per address (for the busiest 300 addresses). */
const LIVE_PEERS = 5;
const LIVE_PEER_ADDRESSES = 300;

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

/**
 * Live rates: bytes per address by arrival time in 5-second slots over the last
 * minute. Routers report long flows every active timeout (1 minute when set up
 * as recommended), so a one-minute window of what arrived tracks current traffic.
 */
export const LIVE_SLOT_MS = 5_000;
export const LIVE_SLOTS = 12;
export interface LiveSnapshot {
  at: string;
  windowSeconds: number;
  totals: { inBps: number; outBps: number; addresses: number };
  /** Busiest first (download + upload), at most 1000 addresses. */
  ips: { ip: string; inBps: number; outBps: number }[];
  /** For the busiest addresses: their busiest remote addresses over the same window. */
  peers?: Record<string, { ip: string; inBps: number; outBps: number }[]>;
}

/**
 * Remote addresses per address with a bounded memory: at most `perAddress`
 * per address and `total` overall. When full, the least busy one is replaced
 * by the newcomer, which inherits its count (the "Space-Saving" method): the
 * busiest remote addresses are kept with near-exact counts, the tail is
 * approximate.
 */
export class PeerCounter {
  map = new Map<string, Map<string, [number, number]>>();
  entries = 0;
  constructor(
    private readonly perAddress = PEERS_PER_ADDRESS,
    private readonly total = PEER_KEYS,
  ) {}

  add(address: string, peer: string, dir: 0 | 1, bytes: number) {
    let peers = this.map.get(address);
    if (!peers) {
      if (this.entries >= this.total) return;
      this.map.set(address, (peers = new Map()));
    }
    const c = peers.get(peer);
    if (c) {
      c[dir] += bytes;
      return;
    }
    if (peers.size < this.perAddress && this.entries < this.total) {
      const n: [number, number] = [0, 0];
      n[dir] = bytes;
      peers.set(peer, n);
      this.entries++;
      return;
    }
    if (!peers.size) return;
    let minKey = '';
    let min = Infinity;
    for (const [k, v] of peers) {
      const t = v[0] + v[1];
      if (t < min) ((min = t), (minKey = k));
    }
    const old = peers.get(minKey)!;
    peers.delete(minKey);
    const n: [number, number] = [old[0], old[1]];
    n[dir] += bytes;
    peers.set(peer, n);
  }

  top(address: string, n: number): [string, [number, number]][] {
    return [...(this.map.get(address) ?? new Map<string, [number, number]>()).entries()].sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1])).slice(0, n);
  }
}

export class LiveWindow {
  private slots = new Map<string, Map<string, [number, number]>[]>();
  /** Remote addresses per organization and slot. */
  private peerSlots = new Map<string, PeerCounter[]>();
  private slotIndex = 0;
  /** When flows started arriving for each organization (reset after a quiet minute). */
  private since = new Map<string, number>();

  add(orgId: string, ip: string, dir: 0 | 1, bytes: number, now = Date.now()) {
    if (!this.since.has(orgId)) this.since.set(orgId, now);
    let ring = this.slots.get(orgId);
    if (!ring) this.slots.set(orgId, (ring = Array.from({ length: LIVE_SLOTS }, () => new Map())));
    const slot = ring[this.slotIndex]!;
    let c = slot.get(ip);
    if (!c) {
      if (slot.size >= 200_000) return;
      slot.set(ip, (c = [0, 0]));
    }
    c[dir] += bytes;
  }

  addPeer(orgId: string, ip: string, peer: string, dir: 0 | 1, bytes: number) {
    let ring = this.peerSlots.get(orgId);
    if (!ring) this.peerSlots.set(orgId, (ring = Array.from({ length: LIVE_SLOTS }, () => new PeerCounter(20, 50_000))));
    ring[this.slotIndex]!.add(ip, peer, dir, bytes);
  }

  /** Rates over the window per organization; then a new slot starts. */
  rotate(now = Date.now()): Map<string, LiveSnapshot> {
    const out = new Map<string, LiveSnapshot>();
    for (const [orgId, ring] of this.slots) {
      // Every byte arrives once, so bytes arriving per second track the traffic rate. Until a
      // full minute of arrivals exists, average over the time since flows started arriving.
      const seconds = Math.min(LIVE_SLOTS * (LIVE_SLOT_MS / 1000), Math.max(LIVE_SLOT_MS / 1000, (now - (this.since.get(orgId) ?? now)) / 1000));
      const sum = new Map<string, [number, number]>();
      for (const slot of ring)
        for (const [ip, c] of slot) {
          const t = sum.get(ip);
          if (t) ((t[0] += c[0]), (t[1] += c[1]));
          else sum.set(ip, [c[0], c[1]]);
        }
      let inB = 0;
      let outB = 0;
      const ips = [...sum.entries()].map(([ip, c]) => {
        inB += c[0];
        outB += c[1];
        return { ip, inBps: (c[0] * 8) / seconds, outBps: (c[1] * 8) / seconds };
      });
      ips.sort((a, b) => b.inBps + b.outBps - (a.inBps + a.outBps));
      if (!ips.length) this.since.delete(orgId);
      // Remote addresses of the busiest addresses, summed over the window.
      const peers: Record<string, { ip: string; inBps: number; outBps: number }[]> = {};
      const pring = this.peerSlots.get(orgId) ?? [];
      for (const x of ips.slice(0, LIVE_PEER_ADDRESSES)) {
        const sumP = new Map<string, [number, number]>();
        for (const pc of pring)
          for (const [peer, c] of pc.map.get(x.ip) ?? []) {
            const t = sumP.get(peer);
            if (t) ((t[0] += c[0]), (t[1] += c[1]));
            else sumP.set(peer, [c[0], c[1]]);
          }
        if (sumP.size)
          peers[x.ip] = [...sumP.entries()]
            .sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]))
            .slice(0, LIVE_PEERS)
            .map(([ip, c]) => ({ ip, inBps: (c[0] * 8) / seconds, outBps: (c[1] * 8) / seconds }));
      }
      out.set(orgId, { at: new Date(now).toISOString(), windowSeconds: seconds, totals: { inBps: (inB * 8) / seconds, outBps: (outB * 8) / seconds, addresses: ips.length }, ips: ips.slice(0, 1000), peers });
    }
    this.slotIndex = (this.slotIndex + 1) % LIVE_SLOTS;
    for (const ring of this.slots.values()) ring[this.slotIndex] = new Map();
    for (const ring of this.peerSlots.values()) ring[this.slotIndex] = new PeerCounter(20, 50_000);
    return out;
  }
}

export class FlowAggregator {
  /** Optional live window fed with the same attributed bytes (by arrival time). */
  live: LiveWindow | null = null;
  /** org → minute bucket → address → counts */
  pending = new Map<string, Map<number, Map<string, Counts>>>();
  keys = 0;
  droppedKeys = 0;
  /** org → hour → remote addresses per address (kept for the whole hour, written as it goes). */
  peers = new Map<string, Map<number, PeerCounter>>();

  /** Adds one record; returns false when neither address is one of yours. */
  add(orgId: string, own: BlockList, r: FlowRecord, multiplier: number, now: number): boolean {
    const srcOwn = check(own, r.src);
    const dstOwn = check(own, r.dst);
    if (!srcOwn && !dstOwn) return false;
    const bytes = r.bytes * multiplier;
    const packets = r.packets * multiplier;
    if (this.live) {
      if (dstOwn) this.live.add(orgId, r.dst, 0, bytes, now);
      if (srcOwn) this.live.add(orgId, r.src, 1, bytes, now);
      if (dstOwn) this.live.addPeer(orgId, r.dst, r.src, 0, bytes);
      if (srcOwn) this.live.addPeer(orgId, r.src, r.dst, 1, bytes);
    }
    const hour = Math.floor(now / HOUR) * HOUR;
    let byHour = this.peers.get(orgId);
    if (!byHour) this.peers.set(orgId, (byHour = new Map()));
    let pc = byHour.get(hour);
    if (!pc) byHour.set(hour, (pc = new PeerCounter()));
    if (dstOwn) pc.add(r.dst, r.src, 0, bytes);
    if (srcOwn) pc.add(r.src, r.dst, 1, bytes);
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

/**
 * Writes the busiest remote addresses per address for each hour in memory.
 * Counts only grow within an hour, so rows are set to the larger of the stored
 * and the current value (a restart mid-hour never lowers a stored count).
 * Hours before the current one are written a last time and dropped.
 */
export async function flushPeers(db: Db, peers: Map<string, Map<number, PeerCounter>>, now = Date.now()) {
  const current = Math.floor(now / HOUR) * HOUR;
  let rows = 0;
  for (const [orgId, byHour] of peers) {
    for (const [hour, pc] of byHour) {
      const list: { address: string; peer: string; c: [number, number] }[] = [];
      for (const address of pc.map.keys()) for (const [peer, c] of pc.top(address, PEERS_STORED)) list.push({ address, peer, c });
      for (let i = 0; i < list.length; i += 1000) {
        const chunk = list.slice(i, i + 1000);
        const values = sql.join(
          chunk.map((r) => sql`(${orgId}::uuid, ${new Date(hour).toISOString()}::timestamptz, ${r.address}::inet, ${r.peer}::inet, ${Math.round(r.c[0])}, ${Math.round(r.c[1])})`),
          sql`, `,
        );
        await db.execute(sql`
          insert into ip_peer_traffic_1h (org_id, bucket, address, peer, in_bytes, out_bytes) values ${values}
          on conflict (org_id, bucket, address, peer) do update set
            in_bytes = greatest(ip_peer_traffic_1h.in_bytes, excluded.in_bytes), out_bytes = greatest(ip_peer_traffic_1h.out_bytes, excluded.out_bytes)`);
      }
      rows += list.length;
      if (hour < current) byHour.delete(hour);
    }
    if (!byHour.size) peers.delete(orgId);
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

export async function startFlowCollector(deps: { db: Db; logger: Logger; onLive?: (orgId: string, snap: LiveSnapshot) => void }, opts: { port: number; bind: string }) {
  const { db, logger } = deps;
  const cache = new TemplateCache();
  const agg = new FlowAggregator();
  const live = new LiveWindow();
  agg.live = live;
  const publishLive = () => {
    for (const [orgId, snap] of live.rotate()) deps.onLive?.(orgId, snap);
  };
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

  let peersAt = 0;
  const flush = async (force = false) => {
    const pending = agg.take();
    const n = await flushTraffic(db, pending);
    // Remote addresses: every minute (they are re-written, not added).
    if (force || Date.now() - peersAt >= 60_000) {
      peersAt = Date.now();
      await flushPeers(db, agg.peers);
    }
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
    setInterval(publishLive, LIVE_SLOT_MS),
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
    /** For tests: rotate the live window now and publish. */
    publishLive,
    /** For tests: feed a datagram as if it arrived from `from`. */
    receive: onMessage,
    flush,
    reload,
    close: async () => {
      timers.forEach(clearInterval);
      await flush(true).catch(() => undefined);
      await new Promise<void>((r) => (socket ? socket.close(() => r()) : r()));
    },
  };
}

/** Removes per-minute data after `minuteDays` and hourly data after `hourDays`. */
export async function applyFlowRetention(db: Db, minuteDays = 7, hourDays = 400, peerDays = 14) {
  const a = await db.execute(sql`delete from ip_traffic_1m where bucket < now() - make_interval(days => ${minuteDays})`);
  const b = await db.execute(sql`delete from ip_traffic_1h where bucket < now() - make_interval(days => ${hourDays})`);
  const c = await db.execute(sql`delete from ip_peer_traffic_1h where bucket < now() - make_interval(days => ${peerDays})`);
  return { minute: a.rowCount ?? 0, hourly: b.rowCount ?? 0, peers: c.rowCount ?? 0 };
}
