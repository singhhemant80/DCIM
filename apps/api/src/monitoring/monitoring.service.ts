import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { RANGE_RESOLUTION, type DeviceMonitoringInput, type RateRange } from '@crapplet/shared';
import { z } from 'zod';
import { DB, type Db } from '../db/db';
import { deviceCredentials, deviceMonitoring, monitoringSettings } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import type { Principal, RequestMeta } from '../auth/principal';
import { notFound, ownDatacenter, ownDevice } from '../network/common';
import { countedInterfaces, percentile95 } from './rate-engine';
import type { monitoringSettingsSchema, portListQuerySchema } from '@crapplet/shared';

type PortQuery = z.infer<typeof portListQuerySchema>;

/**
 * Read side of network monitoring. Everything returned is measured: rates are
 * computed from counters read from the devices. When there is no recent
 * reading, values are null (shown as "no data"), never estimated.
 *
 * Customers (with monitoring.read) see only ports on their own devices and
 * the ports cabled directly to them (typically the switch port feeding their
 * server). Organization totals, polling health and settings are staff-only.
 */
@Injectable()
export class MonitoringService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** SQL condition limiting interface alias `i` to what the principal may see. */
  static visible(p: Principal, alias = 'i'): SQL {
    const a = sql.raw(alias);
    if (p.userType === 'staff') return sql`${a}.org_id = ${p.orgId}`;
    if (!p.customerId) return sql`false`;
    return sql`${a}.org_id = ${p.orgId} and (
      exists (select 1 from devices vd where vd.id = ${a}.device_id and vd.customer_id = ${p.customerId})
      or exists (select 1 from cable_ends e1 join cable_ends e2 on e2.cable_id = e1.cable_id and e2.interface_id <> e1.interface_id
                   join interfaces vi on vi.id = e2.interface_id join devices vd2 on vd2.id = vi.device_id
                  where e1.interface_id = ${a}.id and vd2.customer_id = ${p.customerId}))`;
  }

  /** Ids of every interface the principal may see (used to filter the live stream). */
  async visibleInterfaceIds(p: Principal): Promise<Set<string>> {
    const r = await this.db.execute<{ id: string }>(sql`select i.id from interfaces i where ${MonitoringService.visible(p)}`);
    return new Set(r.rows.map((x) => x.id));
  }

  private static portView(r: Record<string, unknown>) {
    const interval = Number(r.interval_seconds ?? 60);
    const lastRateAt = r.last_rate_at ? new Date(r.last_rate_at as string) : null;
    // A rate older than three intervals is stale: report no data rather than an old number.
    const fresh = !!lastRateAt && Date.now() - lastRateAt.getTime() <= interval * 3000;
    const sampledAt = r.sampled_at ? new Date(r.sampled_at as string) : null;
    // Link state is only reported while readings are recent, like the rates.
    const recent = !!sampledAt && Date.now() - sampledAt.getTime() <= interval * 3000;
    const v = (k: string) => (fresh && r[k] !== null && r[k] !== undefined ? Number(r[k]) : null);
    return {
      interfaceId: r.id as string,
      name: r.name as string,
      description: (r.description as string | null) ?? null,
      kind: r.kind as string,
      enabled: r.enabled as boolean,
      deviceId: r.device_id as string,
      deviceName: r.device_name as string,
      datacenterId: (r.datacenter_id as string | null) ?? null,
      speedBps: r.speed_bps === null ? null : Number(r.speed_bps),
      countInTotals: r.count_in_totals as boolean,
      lagId: (r.lag_id as string | null) ?? null,
      pollingEnabled: r.polling_enabled as boolean,
      intervalSeconds: interval,
      operUp: recent ? ((r.oper_up as boolean | null) ?? null) : null,
      sampledAt,
      lastRateAt,
      fresh,
      /** Why the latest poll gave no rate (first sample, reset, gap, implausible…). */
      lastSkip: (r.last_skip as string | null) ?? null,
      inBps: v('in_bps'),
      outBps: v('out_bps'),
      utilIn: v('util_in'),
      utilOut: v('util_out'),
      errorsPs: v('errors_ps'),
      discardsPs: v('discards_ps'),
    };
  }

  private portSelect(p: Principal, where: SQL) {
    return sql`
      select i.id, i.name, i.description, i.kind, i.enabled, i.count_in_totals, i.lag_id, i.device_id,
             coalesce(c.speed_bps, i.speed_bps) as speed_bps,
             coalesce(d.hostname, d.asset_tag) as device_name, b.datacenter_id,
             m.enabled as polling_enabled, m.interval_seconds,
             c.sampled_at, c.last_rate_at, c.in_bps, c.out_bps, c.util_in, c.util_out, c.errors_ps, c.discards_ps, c.oper_up, c.last_skip
        from interfaces i
        join devices d on d.id = i.device_id
        join device_monitoring m on m.device_id = d.id
        left join interface_counters c on c.interface_id = i.id
        left join racks r on r.id = d.rack_id left join rooms rm on rm.id = r.room_id left join buildings b on b.id = rm.building_id
       where i.monitored and ${MonitoringService.visible(p)} and ${where}`;
  }

  /** Monitored ports with their latest measured rates. */
  async ports(p: Principal, q: PortQuery) {
    const conds: SQL[] = [sql`true`];
    if (q.q) conds.push(sql`(i.name ilike ${'%' + q.q + '%'} or i.description ilike ${'%' + q.q + '%'} or d.hostname ilike ${'%' + q.q + '%'} or d.asset_tag ilike ${'%' + q.q + '%'})`);
    if (q.deviceId) conds.push(sql`i.device_id = ${q.deviceId}`);
    if (q.datacenterId) conds.push(sql`b.datacenter_id = ${q.datacenterId}`);
    if (q.totalsOnly === 'true') conds.push(sql`i.count_in_totals`);
    const where = sql.join(conds, sql` and `);
    const fresh = sql`(c.last_rate_at > now() - make_interval(secs => m.interval_seconds * 3))`;
    const order = {
      traffic: sql`case when ${fresh} then coalesce(c.in_bps, 0) + coalesce(c.out_bps, 0) else -1 end desc, device_name, i.name`,
      utilization: sql`case when ${fresh} then greatest(coalesce(c.util_in, -1), coalesce(c.util_out, -1)) else -2 end desc, device_name, i.name`,
      errors: sql`case when ${fresh} then coalesce(c.errors_ps, 0) + coalesce(c.discards_ps, 0) else -1 end desc, device_name, i.name`,
      name: sql`device_name, i.name`,
    }[q.sort];
    const [rows, total] = await Promise.all([
      this.db.execute(sql`${this.portSelect(p, where)} order by ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
      this.db.execute<{ n: number }>(sql`select count(*)::int as n from (${this.portSelect(p, where)}) x`),
    ]);
    return { items: (rows.rows as Record<string, unknown>[]).map(MonitoringService.portView), page: q.page, pageSize: q.pageSize, total: total.rows[0]?.n ?? 0 };
  }

  async port(p: Principal, interfaceId: string) {
    const r = await this.db.execute(this.portSelect(p, sql`i.id = ${interfaceId}`));
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw notFound('Port');
    return MonitoringService.portView(row);
  }

  /** Rate history for one port, with the 95th percentile of 5-minute averages over the range. */
  async history(p: Principal, interfaceId: string, range: RateRange) {
    const port = await this.port(p, interfaceId);
    const res = RANGE_RESOLUTION[range];
    const since = new Date(Date.now() - res.seconds * 1000).toISOString();
    let points: Record<string, unknown>[];
    let stepSeconds: number;
    if (res.table === 'raw') {
      stepSeconds = port.intervalSeconds;
      const r = await this.db.execute(sql`
        select at as t, in_bps, out_bps, in_bps as in_max, out_bps as out_max, util_in, util_out, errors_ps, discards_ps, flags
          from interface_rates where interface_id = ${interfaceId} and at > ${since}::timestamptz order by at`);
      points = r.rows as Record<string, unknown>[];
    } else {
      stepSeconds = res.table === '5m' ? 300 : 3600;
      const table = sql.raw(res.table === '5m' ? 'interface_rates_5m' : 'interface_rates_1h');
      const r = await this.db.execute(sql`
        select bucket as t, in_bps, out_bps, in_max, out_max, util_in_max as util_in, util_out_max as util_out, errors_ps, discards_ps, covered_seconds
          from ${table} where interface_id = ${interfaceId} and bucket > ${since}::timestamptz order by bucket`);
      points = r.rows as Record<string, unknown>[];
    }
    const p95rows = await this.db.execute<{ in_bps: number; out_bps: number }>(
      // Complete buckets only: the one still filling would skew the percentile.
      sql`select in_bps, out_bps from interface_rates_5m where interface_id = ${interfaceId} and bucket > ${since}::timestamptz and bucket <= now() - interval '5 minutes'`,
    );
    const ins = p95rows.rows.map((r) => Number(r.in_bps));
    const outs = p95rows.rows.map((r) => Number(r.out_bps));
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      port,
      range,
      resolution: res.table,
      stepSeconds,
      points: points.map((r) => ({
        t: new Date(r.t as string),
        inBps: n(r.in_bps),
        outBps: n(r.out_bps),
        inMax: n(r.in_max),
        outMax: n(r.out_max),
        utilIn: n(r.util_in),
        utilOut: n(r.util_out),
        errorsPs: n(r.errors_ps),
        discardsPs: n(r.discards_ps),
        coveredSeconds: n(r.covered_seconds),
        flags: (r.flags as string[] | undefined) ?? [],
      })),
      p95: { inBps: percentile95(ins), outBps: percentile95(outs), samples: ins.length, basis: '5-minute averages (nearest rank)' },
    };
  }

  /** Ports that count towards totals, with LAG members dropped when their LAG is counted. */
  private async countedPorts(p: Principal, datacenterId?: string) {
    const r = await this.db.execute(this.portSelect(p, sql`i.count_in_totals and ${datacenterId ? sql`b.datacenter_id = ${datacenterId}` : sql`true`}`));
    const all = (r.rows as Record<string, unknown>[]).map(MonitoringService.portView);
    const counted = countedInterfaces(all.map((x) => ({ id: x.interfaceId, lagId: x.lagId, countInTotals: x.countInTotals })));
    const ids = new Set(counted.map((c) => c.id));
    return { ports: all.filter((x) => ids.has(x.interfaceId)), excludedLagMembers: all.length - ids.size };
  }

  /** Current traffic totals (staff only). Only fresh measurements are summed; stale ports are counted separately. */
  async totals(p: Principal, datacenterId?: string) {
    if (datacenterId) await ownDatacenter(this.db, p, datacenterId);
    const { ports, excludedLagMembers } = await this.countedPorts(p, datacenterId);
    const fresh = ports.filter((x) => x.fresh);
    const sum = (k: 'inBps' | 'outBps') => fresh.reduce((a, x) => a + (x[k] ?? 0), 0);
    return {
      inBps: fresh.length ? sum('inBps') : null,
      outBps: fresh.length ? sum('outBps') : null,
      ports: ports.length,
      freshPorts: fresh.length,
      stalePorts: ports.length - fresh.length,
      excludedLagMembers,
      top: [...fresh].sort((a, b) => (b.inBps ?? 0) + (b.outBps ?? 0) - ((a.inBps ?? 0) + (a.outBps ?? 0))).slice(0, 5),
    };
  }

  /** Total traffic over time from the aggregates (5-minute buckets up to 7 days, hourly for 30 days). */
  async totalsHistory(p: Principal, range: RateRange, datacenterId?: string) {
    if (datacenterId) await ownDatacenter(this.db, p, datacenterId);
    const { ports } = await this.countedPorts(p, datacenterId);
    const ids = ports.map((x) => x.interfaceId);
    const res = RANGE_RESOLUTION[range];
    const hourly = res.table === '1h';
    const since = new Date(Date.now() - res.seconds * 1000).toISOString();
    if (!ids.length) return { range, stepSeconds: hourly ? 3600 : 300, ports: 0, points: [], p95: { inBps: null, outBps: null, samples: 0 } };
    const table = sql.raw(hourly ? 'interface_rates_1h' : 'interface_rates_5m');
    const r = await this.db.execute<{ t: string; in_bps: number; out_bps: number; ports: number }>(sql`
      select bucket as t, sum(in_bps) as in_bps, sum(out_bps) as out_bps, count(*)::int as ports
        from ${table}
       where interface_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) and bucket > ${since}::timestamptz
       group by bucket order by bucket`);
    const points = r.rows.map((x) => ({ t: new Date(x.t), inBps: Number(x.in_bps), outBps: Number(x.out_bps), ports: x.ports }));
    return {
      range,
      stepSeconds: hourly ? 3600 : 300,
      ports: ids.length,
      points,
      p95: (() => {
        const done = points.filter((x) => x.t.getTime() <= Date.now() - (hourly ? 3600_000 : 300_000));
        return { inBps: percentile95(done.map((x) => x.inBps)), outBps: percentile95(done.map((x) => x.outBps)), samples: done.length };
      })(),
    };
  }

  /* ---------------------------------------------------------------- polling configuration */

  /** Polling configuration and health of every device that has (or could have) polling. */
  async devices(p: Principal) {
    const r = await this.db.execute(sql`
      select d.id as device_id, coalesce(d.hostname, d.asset_tag) as device_name, d.platform,
             m.enabled, m.credential_kind, m.interval_seconds, m.next_poll_at, m.last_poll_at, m.last_ok_at, m.last_error,
             m.consecutive_failures, m.last_duration_ms, m.last_matched, m.last_reported,
             (select array_agg(c.kind::text order by c.kind) from device_credentials c where c.device_id = d.id) as credential_kinds,
             (select count(*)::int from interfaces i where i.device_id = d.id and i.monitored) as monitored_ports
        from devices d
        left join device_monitoring m on m.device_id = d.id
       where d.org_id = ${p.orgId} and (m.device_id is not null or exists (select 1 from device_credentials c where c.device_id = d.id))
       order by device_name`);
    return (r.rows as Record<string, unknown>[]).map((x) => ({
      deviceId: x.device_id as string,
      deviceName: x.device_name as string,
      platform: (x.platform as string | null) ?? null,
      configured: x.credential_kind !== null,
      enabled: (x.enabled as boolean | null) ?? false,
      credentialKind: (x.credential_kind as string | null) ?? null,
      intervalSeconds: (x.interval_seconds as number | null) ?? null,
      nextPollAt: x.next_poll_at ?? null,
      lastPollAt: x.last_poll_at ?? null,
      lastOkAt: x.last_ok_at ?? null,
      lastError: (x.last_error as string | null) ?? null,
      consecutiveFailures: (x.consecutive_failures as number | null) ?? 0,
      lastDurationMs: (x.last_duration_ms as number | null) ?? null,
      lastMatched: (x.last_matched as number | null) ?? null,
      lastReported: (x.last_reported as number | null) ?? null,
      credentialKinds: (x.credential_kinds as string[] | null) ?? [],
      monitoredPorts: x.monitored_ports as number,
    }));
  }

  /** Turns polling on/off for a device. Requires a stored credential of the chosen kind; polling is read-only. */
  async configure(p: Principal, deviceId: string, input: DeviceMonitoringInput, meta: RequestMeta) {
    await ownDevice(this.db, p, deviceId);
    const [cred] = await this.db
      .select({ id: deviceCredentials.id })
      .from(deviceCredentials)
      .where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, input.credentialKind), eq(deviceCredentials.orgId, p.orgId)));
    if (!cred) throw new BadRequestException({ error: 'no_credential', message: `Store a ${input.credentialKind} credential for this device first (Network → device → Access)` });
    return this.db.transaction(async (tx) => {
      const values = { enabled: input.enabled, credentialKind: input.credentialKind, intervalSeconds: input.intervalSeconds, nextPollAt: input.enabled ? new Date() : null };
      const [row] = await tx
        .insert(deviceMonitoring)
        .values({ deviceId, orgId: p.orgId, ...values })
        .onConflictDoUpdate({ target: deviceMonitoring.deviceId, set: { ...values, consecutiveFailures: 0, lastError: null } })
        .returning();
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'monitoring.configure', target: { type: 'device', id: deviceId }, outcome: 'success', meta, metadata: { ...input } }, tx);
      return row;
    });
  }

  async unconfigure(p: Principal, deviceId: string, meta: RequestMeta) {
    await ownDevice(this.db, p, deviceId);
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(deviceMonitoring).where(and(eq(deviceMonitoring.deviceId, deviceId), eq(deviceMonitoring.orgId, p.orgId))).returning();
      if (!rows.length) throw notFound('Polling configuration');
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'monitoring.remove', target: { type: 'device', id: deviceId }, outcome: 'success', meta }, tx);
      return { ok: true };
    });
  }

  async settings(p: Principal) {
    const [s] = await this.db.select().from(monitoringSettings).where(eq(monitoringSettings.orgId, p.orgId));
    return { rawDays: s?.rawDays ?? 7, fiveMinuteDays: s?.fiveMinuteDays ?? 90, hourlyDays: s?.hourlyDays ?? 730 };
  }

  async updateSettings(p: Principal, input: z.infer<typeof monitoringSettingsSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      await tx.insert(monitoringSettings).values({ orgId: p.orgId, ...input }).onConflictDoUpdate({ target: monitoringSettings.orgId, set: input });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'monitoring.settings', target: { type: 'organization', id: p.orgId }, outcome: 'success', meta, metadata: { ...input } }, tx);
      return input;
    });
  }
}
