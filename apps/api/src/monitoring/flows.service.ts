import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { isIP } from 'node:net';
import type Redis from 'ioredis';
import type { z } from 'zod';
import type { FlowExporterInput, FlowRange, ipHistoryQuerySchema, topIpQuerySchema } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { flowExporters } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import type { Principal, RequestMeta } from '../auth/principal';
import { dayRange } from '../common/date-range';
import { rethrowConflict } from '../common/pg-errors';
import { REDIS } from '../redis/redis';
import { FLOW_COLLECTOR_STATUS_KEY } from '../health/worker-heartbeat';
import { like, notFound, ownDevice } from '../network/common';

const MINUTE_RANGES: Record<FlowRange, number> = { '15m': 900, '1h': 3600, '6h': 21_600, '24h': 86_400, '7d': 7 * 86_400, '30d': 30 * 86_400 };

/**
 * Bandwidth per IP address from flow records (NetFlow/IPFIX). Download is
 * traffic to the address, upload traffic from it. Only your IPAM addresses are
 * recorded. Customers see the addresses assigned to them (directly or through a
 * prefix assigned to them).
 */
@Injectable()
export class FlowsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /* ------------------------------------------------------------ exporters */

  async exporters(p: Principal) {
    const r = await this.db.execute<Record<string, unknown>>(sql`
      select e.id, e.name, host(e.address) as address, e.device_id, coalesce(d.hostname, d.asset_tag) as device_name, e.enabled, e.sampling_rate,
             e.last_packet_at, e.last_version, e.packets, e.records, e.unmatched_records, e.bad_packets, e.last_error, e.created_at
        from flow_exporters e left join devices d on d.id = e.device_id
       where e.org_id = ${p.orgId} order by e.name`);
    let collector: unknown = null;
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const raw = await this.redis.get(FLOW_COLLECTOR_STATUS_KEY);
      collector = raw ? JSON.parse(raw) : null;
    } catch {
      collector = null;
    }
    const known = new Set(r.rows.map((x) => x.address as string));
    const c = collector as { unknownSources?: { address: string }[] } | null;
    // Sources that send flows but are not registered here: shown so a typo in the address is easy to spot.
    if (c?.unknownSources) c.unknownSources = c.unknownSources.filter((u) => !known.has(u.address));
    return {
      collector,
      exporters: r.rows.map((x) => ({
        id: x.id,
        name: x.name,
        address: x.address,
        deviceId: x.device_id ?? null,
        deviceName: x.device_name ?? null,
        enabled: x.enabled,
        samplingRate: x.sampling_rate,
        lastPacketAt: x.last_packet_at ?? null,
        lastVersion: x.last_version ?? null,
        packets: Number(x.packets),
        records: Number(x.records),
        unmatchedRecords: Number(x.unmatched_records),
        badPackets: Number(x.bad_packets),
        lastError: x.last_error ?? null,
        receiving: !!x.last_packet_at && Date.now() - new Date(x.last_packet_at as string).getTime() < 5 * 60_000,
      })),
    };
  }

  async createExporter(p: Principal, i: FlowExporterInput, meta: RequestMeta) {
    if (i.deviceId) await ownDevice(this.db, p, i.deviceId);
    try {
      const [e] = await this.db
        .insert(flowExporters)
        .values({ orgId: p.orgId, name: i.name, address: i.address, deviceId: i.deviceId ?? null, samplingRate: i.samplingRate, enabled: i.enabled })
        .returning({ id: flowExporters.id });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'flow_exporter.create', target: { type: 'flow_exporter', id: e!.id }, outcome: 'success', meta, metadata: { name: i.name, address: i.address } });
      return e;
    } catch (err) {
      rethrowConflict(err, 'An exporter with this address is already registered');
    }
  }

  async updateExporter(p: Principal, id: string, i: FlowExporterInput, meta: RequestMeta) {
    if (i.deviceId) await ownDevice(this.db, p, i.deviceId);
    try {
      const r = await this.db
        .update(flowExporters)
        .set({ name: i.name, address: i.address, deviceId: i.deviceId ?? null, samplingRate: i.samplingRate, enabled: i.enabled, updatedAt: new Date() })
        .where(and(eq(flowExporters.id, id), eq(flowExporters.orgId, p.orgId)))
        .returning({ id: flowExporters.id });
      if (!r.length) throw notFound('Exporter');
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'flow_exporter.update', target: { type: 'flow_exporter', id }, outcome: 'success', meta, metadata: { name: i.name, address: i.address, enabled: i.enabled } });
      return r[0];
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      rethrowConflict(err, 'An exporter with this address is already registered');
    }
  }

  async deleteExporter(p: Principal, id: string, meta: RequestMeta) {
    const r = await this.db.delete(flowExporters).where(and(eq(flowExporters.id, id), eq(flowExporters.orgId, p.orgId))).returning({ name: flowExporters.name });
    if (!r.length) throw notFound('Exporter');
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'flow_exporter.delete', target: { type: 'flow_exporter', id }, outcome: 'success', meta, metadata: { name: r[0]!.name } });
  }

  /* ------------------------------------------------------------ traffic */

  /** The window and table for a range: per-minute data up to 2 days (kept 7 days), hourly beyond. */
  private async window(p: Principal, range: FlowRange | 'custom', custom: { from?: string; to?: string }) {
    if (range !== 'custom') {
      const seconds = MINUTE_RANGES[range];
      const table = seconds <= 86_400 ? 'ip_traffic_1m' : 'ip_traffic_1h';
      const step = table === 'ip_traffic_1m' ? 60 : 3600;
      const until = new Date();
      // Hourly windows start on an hour boundary so whole hours are compared.
      const since = new Date(step === 3600 ? Math.floor((until.getTime() - seconds * 1000) / 3600_000) * 3600_000 : until.getTime() - seconds * 1000);
      return { since, until, table, step };
    }
    const d = await dayRange(this.db, p.orgId, custom.from, custom.to, 400);
    const span = d.to.getTime() - d.from.getTime();
    const minuteKept = d.from.getTime() > Date.now() - 7 * 86_400_000;
    const table = span <= 2 * 86_400_000 && minuteKept ? 'ip_traffic_1m' : 'ip_traffic_1h';
    return { since: d.from, until: d.to, table, step: table === 'ip_traffic_1m' ? 60 : 3600 };
  }

  /** Each traffic row with the address's IPAM record, prefix, device and customer (the most specific). */
  private owned(p: Principal, inner: SQL) {
    return sql`
      select t.*, a.dns_name, a.device_id, coalesce(a.customer_id, pf.customer_id) as customer_id, pf.prefix::text as prefix, pf.id as prefix_id
        from (${inner}) t
        left join lateral (select id, dns_name, device_id, customer_id from ip_addresses ia
                            where ia.org_id = ${p.orgId} and ia.address = t.address order by (ia.customer_id is null), ia.created_at limit 1) a on true
        left join lateral (select id, prefix, customer_id from prefixes px
                            where px.org_id = ${p.orgId} and px.prefix >>= t.address order by masklen(px.prefix) desc limit 1) pf on true`;
  }

  private scope(p: Principal, customerId: string | undefined) {
    if (p.userType !== 'staff') return p.customerId ? sql`x.customer_id = ${p.customerId}` : sql`false`;
    return customerId ? sql`x.customer_id = ${customerId}` : sql`true`;
  }

  async top(p: Principal, q: z.infer<typeof topIpQuerySchema>) {
    const w = await this.window(p, q.range, q);
    const t = sql.raw(w.table);
    const inner = sql`
      select address, sum(in_bytes)::float8 as in_b, sum(out_bytes)::float8 as out_b, sum(in_packets)::float8 as in_p, sum(out_packets)::float8 as out_p,
             max(in_bytes)::float8 as in_peak, max(out_bytes)::float8 as out_peak
        from ${t} where org_id = ${p.orgId} and bucket >= ${w.since.toISOString()}::timestamptz and bucket < ${w.until.toISOString()}::timestamptz
       group by address`;
    const conds: SQL[] = [this.scope(p, q.customerId)];
    if (q.q) conds.push(sql`(host(x.address) ilike ${like(q.q)} or x.dns_name ilike ${like(q.q)} or coalesce(d.hostname, d.asset_tag) ilike ${like(q.q)} or c.name ilike ${like(q.q)})`);
    const order = { download: sql`x.in_b desc`, upload: sql`x.out_b desc`, total: sql`x.in_b + x.out_b desc` }[q.sort];
    const r = await this.db.execute<Record<string, unknown>>(sql`
      select host(x.address) as ip, x.in_b, x.out_b, x.in_p, x.out_p, x.in_peak, x.out_peak, x.dns_name, x.prefix, x.prefix_id, x.device_id,
             coalesce(d.hostname, d.asset_tag) as device_name, x.customer_id, c.name as customer_name,
             count(*) over () as n, sum(x.in_b) over () as all_in, sum(x.out_b) over () as all_out
        from (${this.owned(p, inner)}) x
        left join devices d on d.id = x.device_id
        left join customers c on c.id = x.customer_id
       where ${sql.join(conds, sql` and `)}
       order by ${order}, x.address limit ${q.limit}`);
    // Average over the part of the period with flow data: right after a router is added,
    // a 24-hour average would otherwise be diluted by hours with no data at all.
    const cov = await this.db.execute<{ first: string | null }>(sql`
      select min(bucket) as first from ${t} where org_id = ${p.orgId} and bucket >= ${w.since.toISOString()}::timestamptz and bucket < ${w.until.toISOString()}::timestamptz`);
    const coveredFrom = cov.rows[0]?.first ? Math.max(w.since.getTime(), new Date(cov.rows[0].first).getTime()) : w.since.getTime();
    const seconds = Math.max(w.step, (w.until.getTime() - coveredFrom) / 1000);
    const first = r.rows[0];
    const latest = await this.db.execute<{ at: string | null }>(sql`select max(bucket) as at from ip_traffic_1m where org_id = ${p.orgId}`);
    return {
      range: { name: q.range, from: w.since.toISOString(), to: w.until.toISOString(), stepSeconds: w.step, coveredFrom: new Date(coveredFrom).toISOString(), averagedSeconds: seconds },
      totals: { addresses: Number(first?.n ?? 0), inBytes: Number(first?.all_in ?? 0), outBytes: Number(first?.all_out ?? 0), inBps: (Number(first?.all_in ?? 0) * 8) / seconds, outBps: (Number(first?.all_out ?? 0) * 8) / seconds },
      latestDataAt: latest.rows[0]?.at ?? null,
      items: r.rows.map((x) => ({
        ip: x.ip as string,
        inBytes: Number(x.in_b),
        outBytes: Number(x.out_b),
        inPackets: Number(x.in_p),
        outPackets: Number(x.out_p),
        /** Average over the whole range. */
        inBps: (Number(x.in_b) * 8) / seconds,
        outBps: (Number(x.out_b) * 8) / seconds,
        /** Busiest minute (or hour) in the range. */
        inPeakBps: (Number(x.in_peak) * 8) / w.step,
        outPeakBps: (Number(x.out_peak) * 8) / w.step,
        dnsName: (x.dns_name as string | null) ?? null,
        prefix: (x.prefix as string | null) ?? null,
        prefixId: (x.prefix_id as string | null) ?? null,
        deviceId: (x.device_id as string | null) ?? null,
        deviceName: (x.device_name as string | null) ?? null,
        customerId: p.userType === 'staff' ? ((x.customer_id as string | null) ?? null) : null,
        customerName: p.userType === 'staff' ? ((x.customer_name as string | null) ?? null) : null,
      })),
    };
  }

  async history(p: Principal, ip: string, q: z.infer<typeof ipHistoryQuerySchema>) {
    if (!isIP(ip)) throw new BadRequestException({ error: 'invalid_address', message: 'Not an IP address' });
    const w = await this.window(p, q.range, q);
    const t = sql.raw(w.table);
    // Same ownership rule as the ranking: a customer only gets their own addresses.
    const own = await this.db.execute<Record<string, unknown>>(sql`
      select x.*, coalesce(d.hostname, d.asset_tag) as device_name, c.name as customer_name
        from (${this.owned(p, sql`select ${ip}::inet as address`)}) x
        left join devices d on d.id = x.device_id left join customers c on c.id = x.customer_id
       where ${this.scope(p, undefined)}`);
    const o = own.rows[0];
    if (!o || (!o.prefix_id && p.userType !== 'staff')) throw notFound('Address');
    const r = await this.db.execute<{ bucket: string; in_b: number; out_b: number }>(sql`
      select bucket, in_bytes::float8 as in_b, out_bytes::float8 as out_b from ${t}
       where org_id = ${p.orgId} and address = ${ip}::inet and bucket >= ${w.since.toISOString()}::timestamptz and bucket < ${w.until.toISOString()}::timestamptz
       order by bucket`);
    const cov = await this.db.execute<{ first: string | null }>(sql`
      select min(bucket) as first from ${t} where org_id = ${p.orgId} and bucket >= ${w.since.toISOString()}::timestamptz and bucket < ${w.until.toISOString()}::timestamptz`);
    const coveredFrom = cov.rows[0]?.first ? Math.max(w.since.getTime(), new Date(cov.rows[0].first).getTime()) : w.since.getTime();
    const seconds = Math.max(w.step, (w.until.getTime() - coveredFrom) / 1000);
    const inB = r.rows.reduce((a, x) => a + Number(x.in_b), 0);
    const outB = r.rows.reduce((a, x) => a + Number(x.out_b), 0);
    return {
      ip,
      dnsName: (o.dns_name as string | null) ?? null,
      prefix: (o.prefix as string | null) ?? null,
      deviceId: (o.device_id as string | null) ?? null,
      deviceName: (o.device_name as string | null) ?? null,
      customerName: p.userType === 'staff' ? ((o.customer_name as string | null) ?? null) : null,
      range: { name: q.range, from: w.since.toISOString(), to: w.until.toISOString() },
      stepSeconds: w.step,
      totals: { inBytes: inB, outBytes: outB, inBps: (inB * 8) / seconds, outBps: (outB * 8) / seconds },
      // Only minutes (hours) with flows have a point; the chart shows the rest as gaps.
      points: r.rows.map((x) => ({ t: new Date(x.bucket).toISOString(), inBps: (Number(x.in_b) * 8) / w.step, outBps: (Number(x.out_b) * 8) / w.step })),
    };
  }
}
