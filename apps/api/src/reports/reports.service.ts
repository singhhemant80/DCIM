import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { REPORT_LABELS, type ReportType, reportScheduleSchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { notificationChannels, reportSchedules } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import type { Principal, RequestMeta } from '../auth/principal';
import { PowerService } from '../power/power.service';
import { customerP95 } from './bandwidth';
import { type Report, toCsv, toPdf } from './render';

type Period = 'last_7d' | 'last_30d' | 'this_month' | 'last_month';
const POWER_PERIOD = { last_7d: '7d', last_30d: '30d', this_month: 'mtd', last_month: 'last_month' } as const;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const mbps = (bps: number | null) => (bps === null ? null : Math.round(bps / 10_000) / 100);

/** Next run time of a schedule (hour of day in the organization's time zone), computed in Postgres. */
export function nextRunSql(orgId: string, s: { frequency: string; hour: number; weekday?: number | null; dayOfMonth?: number | null }) {
  const local = sql`(now() at time zone o.tz)`;
  const day = sql`date_trunc('day', ${local})`;
  const cand =
    s.frequency === 'daily'
      ? sql`${day} + make_interval(hours => ${s.hour})`
      : s.frequency === 'weekly'
        ? sql`${day} + make_interval(days => ((${s.weekday ?? 1} - extract(dow from ${local})::int + 7) % 7), hours => ${s.hour})`
        : sql`date_trunc('month', ${local}) + make_interval(days => ${(s.dayOfMonth ?? 1) - 1}, hours => ${s.hour})`;
  const step = s.frequency === 'daily' ? sql`interval '1 day'` : s.frequency === 'weekly' ? sql`interval '7 days'` : sql`interval '1 month'`;
  return sql`(select (case when c.v > ${local} then c.v else c.v + ${step} end) at time zone o.tz
     from (select coalesce(nullif(settings->>'timezone', ''), 'Asia/Kolkata') as tz from organizations where id = ${orgId}) o,
          lateral (select ${cand} as v) c)`;
}

/**
 * Reports. Every figure comes from data already collected: energy from the
 * hourly power rows (measured and estimated kept apart), bandwidth from the
 * 5-minute interface rates (measured only, with coverage), remote hands from
 * logged ticket time. Customers get their own account only; the capacity
 * report is staff-only.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly power: PowerService,
    private readonly audit: AuditService,
  ) {}

  async build(p: Principal, type: ReportType, period: Period): Promise<Report> {
    if (type === 'capacity' && p.userType !== 'staff') throw new ForbiddenException({ error: 'forbidden', message: 'The capacity report is for datacenter staff' });
    if (p.userType === 'customer' && !p.customerId) throw new ForbiddenException({ error: 'forbidden', message: 'No customer account' });
    const per = await this.power.period(p, POWER_PERIOD[period]);
    const scope = p.userType === 'staff' ? 'All customers' : ((await this.db.execute<{ name: string }>(sql`select name from customers where id = ${p.customerId}`)).rows[0]?.name ?? 'Your account');
    const base = { type, title: REPORT_LABELS[type], period: { name: period, from: per.from.toISOString(), to: per.to.toISOString(), timezone: per.timezone }, generatedAt: new Date().toISOString(), scope };
    switch (type) {
      case 'energy':
        return { ...base, ...(await this.energy(p, per.from, per.to)) };
      case 'bandwidth':
        return { ...base, ...(await this.bandwidth(p, per.from, per.to)) };
      case 'capacity':
        return { ...base, ...(await this.capacity(p)) };
      case 'remote_hands':
        return { ...base, ...(await this.remoteHands(p, per.from, per.to)) };
      case 'services':
        return { ...base, ...(await this.services(p)) };
    }
  }

  async render(p: Principal, type: ReportType, period: Period, format: 'json' | 'csv' | 'pdf') {
    const r = await this.build(p, type, period);
    const name = `nexoradc-${type}-${r.period.from.slice(0, 10)}-${r.period.to.slice(0, 10)}`;
    if (format === 'csv') return { report: r, filename: `${name}.csv`, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`﻿${toCsv(r)}`, 'utf8') };
    if (format === 'pdf') return { report: r, filename: `${name}.pdf`, contentType: 'application/pdf', body: await toPdf(r) };
    return { report: r, filename: `${name}.json`, contentType: 'application/json', body: null };
  }

  private customerScope(p: Principal, col = 'c.id') {
    return p.userType === 'staff' ? sql`true` : sql`${sql.raw(col)} = ${p.customerId}`;
  }

  private async energy(p: Principal, from: Date, to: Date) {
    const by = await this.power.energy(p, from, to, 'customer');
    const names = await this.db.execute<{ id: string; code: string; name: string }>(sql`select id, code, name from customers c where org_id = ${p.orgId} and ${this.customerScope(p)}`);
    const rows = [...by.values()]
      .map((e) => {
        const c = names.rows.find((n) => n.id === e.key);
        const cost = e.cost.map((x) => `${x.amount.toFixed(2)} ${x.currency}`).join(' + ');
        return {
          customer: c ? `${c.name} (${c.code})` : e.key ? 'Unknown customer' : 'Unassigned (operator equipment)',
          measuredKwh: r3(e.measuredKwh),
          estimatedKwh: r3(e.estimatedKwh),
          totalKwh: r3(e.measuredKwh + e.estimatedKwh),
          measuredShare: e.measuredKwh + e.estimatedKwh > 0 ? Math.round((e.measuredKwh / (e.measuredKwh + e.estimatedKwh)) * 1000) / 10 : null,
          unknownHours: Math.round(e.unknownHours * 10) / 10,
          ...(p.userType === 'staff' ? { cost: cost || null } : {}),
        };
      })
      .filter((x) => p.userType === 'staff' || x.customer !== 'Unassigned (operator equipment)')
      .sort((a, b) => b.totalKwh - a.totalKwh);
    return {
      columns: [
        { key: 'customer', label: 'Customer' },
        { key: 'measuredKwh', label: 'Measured kWh', numeric: true, decimals: 3 },
        { key: 'estimatedKwh', label: 'Estimated kWh', numeric: true, decimals: 3 },
        { key: 'totalKwh', label: 'Total kWh', numeric: true, decimals: 3 },
        { key: 'measuredShare', label: 'Measured %', numeric: true, decimals: 1 },
        { key: 'unknownHours', label: 'Device-hours without data', numeric: true, decimals: 1 },
        ...(p.userType === 'staff' ? [{ key: 'cost', label: 'Cost (tariffs)' }] : []),
      ],
      rows,
      notes: [
        'Measured kWh come from meter readings; estimated kWh come from configured or model power figures and are not measurements.',
        'Device-hours without data are not counted in either figure.',
        ...(p.userType === 'staff' ? ['Costs use the energy tariffs configured in Power.'] : []),
      ],
    };
  }

  private async bandwidth(p: Principal, from: Date, to: Date) {
    const list = await this.db.execute<{ id: string; code: string; name: string }>(sql`
      select id, code, name from customers c where org_id = ${p.orgId} and status <> 'closed' and ${this.customerScope(p)} order by name`);
    const rows = [];
    for (const c of list.rows) {
      const bw = await customerP95(this.db, p.orgId, c.id, from, to);
      if (!bw.ports) continue;
      rows.push({
        customer: `${c.name} (${c.code})`,
        ports: bw.ports,
        basis: bw.basis === 'uplinks' ? 'Uplinks' : 'Customer ports',
        inP95Mbps: mbps(bw.inP95Bps),
        outP95Mbps: mbps(bw.outP95Bps),
        billableP95Mbps: mbps(bw.billableP95Bps),
        inMaxMbps: mbps(bw.inMaxBps),
        outMaxMbps: mbps(bw.outMaxBps),
        coverage: bw.expectedSamples ? Math.round((bw.samples / bw.expectedSamples) * 1000) / 10 : null,
      });
    }
    return {
      columns: [
        { key: 'customer', label: 'Customer' },
        { key: 'ports', label: 'Ports', numeric: true },
        { key: 'basis', label: 'Measured on' },
        { key: 'inP95Mbps', label: 'In 95th (Mbit/s)', numeric: true, decimals: 2 },
        { key: 'outP95Mbps', label: 'Out 95th (Mbit/s)', numeric: true, decimals: 2 },
        { key: 'billableP95Mbps', label: 'Billable 95th (Mbit/s)', numeric: true, decimals: 2 },
        { key: 'inMaxMbps', label: 'In peak', numeric: true, decimals: 2 },
        { key: 'outMaxMbps', label: 'Out peak', numeric: true, decimals: 2 },
        { key: 'coverage', label: 'Sample coverage %', numeric: true, decimals: 1 },
      ],
      rows,
      notes: [
        "Measured 5-minute rates only. 'Uplinks' are the operator's ports cabled to the customer's equipment (traffic between the customer's own devices is not counted); 'Customer ports' are the customer's uncabled ports, used only when no uplink cable is recorded.",
        'Directions are as seen by the port. 95th percentile: nearest rank over the 5-minute samples; billable is the higher of in and out.',
        'Sample coverage below 100% means some 5-minute intervals have no data (missing polls are not filled in).',
      ],
    };
  }

  private async capacity(p: Principal) {
    const r = await this.db.execute<Record<string, number | string | null>>(sql`
      select dc.code, dc.name,
             count(distinct r.id)::int as racks,
             coalesce(sum(distinct_r.u_height), 0)::int as total_u,
             (select coalesce(sum(d.u_height), 0)::int from devices d join racks r2 on r2.id = d.rack_id join rooms ro2 on ro2.id = r2.room_id join buildings b2 on b2.id = ro2.building_id
               where b2.datacenter_id = dc.id and d.position_u is not null) as used_u,
             (select coalesce(sum(a.end_u - a.start_u + 1), 0)::int from colo_allocations a join racks r3 on r3.id = a.rack_id join rooms ro3 on ro3.id = r3.room_id join buildings b3 on b3.id = ro3.building_id
               where b3.datacenter_id = dc.id and a.ended_at is null) as allocated_u,
             (select coalesce(sum(a.contracted_power_w), 0)::int from colo_allocations a join racks r3 on r3.id = a.rack_id join rooms ro3 on ro3.id = r3.room_id join buildings b3 on b3.id = ro3.building_id
               where b3.datacenter_id = dc.id and a.ended_at is null) as contracted_w,
             coalesce(sum(distinct_r.max_power_w), 0)::int as rack_power_w
        from datacenters dc
        left join buildings b on b.datacenter_id = dc.id
        left join rooms ro on ro.building_id = b.id
        left join racks r on r.room_id = ro.id
        left join lateral (select r.u_height, r.max_power_w) distinct_r on true
       where dc.org_id = ${p.orgId}
       group by dc.id order by dc.code`);
    const now = await this.power.current(p);
    const rows = r.rows.map((x) => {
      const here = now.filter((d) => d.counted && d.datacenterCode === x.code);
      const measured = here.filter((d) => d.quality === 'measured').reduce((a, d) => a + (d.watts ?? 0), 0);
      const estimated = here.filter((d) => d.quality === 'estimated').reduce((a, d) => a + (d.watts ?? 0), 0);
      const total = Number(x.total_u);
      return {
        datacenter: `${x.name} (${x.code})`,
        racks: Number(x.racks),
        totalU: total,
        usedU: Number(x.used_u),
        allocatedU: Number(x.allocated_u),
        usedPct: total ? Math.round((Number(x.used_u) / total) * 1000) / 10 : null,
        rackPowerKw: r3(Number(x.rack_power_w) / 1000),
        contractedKw: r3(Number(x.contracted_w) / 1000),
        measuredKwNow: r3(measured / 1000),
        estimatedKwNow: r3(estimated / 1000),
      };
    });
    return {
      columns: [
        { key: 'datacenter', label: 'Datacenter' },
        { key: 'racks', label: 'Racks', numeric: true },
        { key: 'totalU', label: 'Total U', numeric: true },
        { key: 'usedU', label: 'U with equipment', numeric: true },
        { key: 'allocatedU', label: 'U allocated (colo)', numeric: true },
        { key: 'usedPct', label: 'Used %', numeric: true, decimals: 1 },
        { key: 'rackPowerKw', label: 'Rack power limit kW', numeric: true, decimals: 1 },
        { key: 'contractedKw', label: 'Contracted kW', numeric: true, decimals: 1 },
        { key: 'measuredKwNow', label: 'Measured kW now', numeric: true, decimals: 2 },
        { key: 'estimatedKwNow', label: 'Estimated kW now', numeric: true, decimals: 2 },
      ],
      rows,
      notes: ['A snapshot at generation time (the period does not apply). Rack power limit counts only racks with a limit set. Measured and estimated draw are shown separately.'],
    };
  }

  private async remoteHands(p: Principal, from: Date, to: Date) {
    const staff = p.userType === 'staff';
    const r = await this.db.execute<{ customer: string | null; code: string | null; tickets: number; entries: number; billable: number; total: number }>(sql`
      select c.name as customer, c.code, count(distinct t.id)::int as tickets, count(e.id)::int as entries,
             coalesce(sum(e.minutes) filter (where e.billable), 0)::int as billable, coalesce(sum(e.minutes), 0)::int as total
        from ticket_time_entries e join tickets t on t.id = e.ticket_id left join customers c on c.id = t.customer_id
       where t.org_id = ${p.orgId} and e.created_at >= ${from.toISOString()}::timestamptz and e.created_at < ${to.toISOString()}::timestamptz
         and ${staff ? sql`true` : sql`t.customer_id = ${p.customerId} and e.billable`}
       group by c.id, c.name, c.code order by billable desc`);
    return {
      columns: [
        { key: 'customer', label: 'Customer' },
        { key: 'tickets', label: 'Tickets', numeric: true },
        { key: 'billableMinutes', label: 'Billable minutes', numeric: true },
        { key: 'billableHours', label: 'Billable hours', numeric: true, decimals: 2 },
        ...(staff ? [{ key: 'totalMinutes', label: 'All logged minutes', numeric: true }] : []),
      ],
      rows: r.rows.map((x) => ({
        customer: x.customer ? `${x.customer} (${x.code})` : 'Internal (no customer)',
        tickets: x.tickets,
        billableMinutes: x.billable,
        billableHours: Math.round((x.billable / 60) * 100) / 100,
        ...(staff ? { totalMinutes: x.total } : {}),
      })),
      notes: ['Time logged on tickets during the period, by the date it was logged.'],
    };
  }

  private async services(p: Principal) {
    const r = await this.db.execute<Record<string, string | null>>(sql`
      select c.name as customer, c.code, s.name, s.kind::text as kind, s.status::text as status, s.billing_reference, s.start_date::text as start_date, s.end_date::text as end_date
        from services s join customers c on c.id = s.customer_id
       where s.org_id = ${p.orgId} and ${this.customerScope(p)} order by c.name, s.name`);
    return {
      columns: [
        { key: 'customer', label: 'Customer' },
        { key: 'name', label: 'Service' },
        { key: 'kind', label: 'Kind' },
        { key: 'status', label: 'Status' },
        { key: 'billingReference', label: 'Billing reference' },
        { key: 'startDate', label: 'Start' },
        { key: 'endDate', label: 'End' },
      ],
      rows: r.rows.map((x) => ({ customer: `${x.customer} (${x.code})`, name: x.name, kind: x.kind, status: x.status, billingReference: x.billing_reference, startDate: x.start_date, endDate: x.end_date })),
      notes: ['A snapshot at generation time (the period does not apply).'],
    };
  }

  /* ---------------------------------------------------------------- schedules (staff) */

  private async checkChannel(tx: DbOrTx, p: Principal, channelId: string) {
    const [ch] = await tx.select().from(notificationChannels).where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.orgId, p.orgId)));
    if (!ch) throw new BadRequestException({ error: 'invalid_channel', message: 'Notification channel not found' });
    if (ch.kind !== 'email') throw new BadRequestException({ error: 'invalid_channel', message: 'Choose an email channel: reports are sent as attachments' });
  }

  schedules(p: Principal) {
    return this.db.select().from(reportSchedules).where(eq(reportSchedules.orgId, p.orgId)).orderBy(reportSchedules.name);
  }

  async createSchedule(p: Principal, input: z.infer<typeof reportScheduleSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      await this.checkChannel(tx, p, input.channelId);
      const [s] = await tx
        .insert(reportSchedules)
        .values({ orgId: p.orgId, name: input.name, type: input.type, period: input.period, format: input.format, frequency: input.frequency, hour: input.hour, weekday: input.weekday ?? null, dayOfMonth: input.dayOfMonth ?? null, channelId: input.channelId, recipients: input.recipients, enabled: input.enabled, createdBy: p.email, nextRunAt: sql`${nextRunSql(p.orgId, input)}` })
        .returning();
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'report.schedule_create', target: { type: 'report_schedule', id: s!.id }, outcome: 'success', meta, metadata: { name: input.name, type: input.type, frequency: input.frequency, recipients: input.recipients.length } }, tx);
      return s!;
    });
  }

  async updateSchedule(p: Principal, id: string, input: z.infer<typeof reportScheduleSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      await this.checkChannel(tx, p, input.channelId);
      const [s] = await tx
        .update(reportSchedules)
        .set({ name: input.name, type: input.type, period: input.period, format: input.format, frequency: input.frequency, hour: input.hour, weekday: input.weekday ?? null, dayOfMonth: input.dayOfMonth ?? null, channelId: input.channelId, recipients: input.recipients, enabled: input.enabled, nextRunAt: sql`${nextRunSql(p.orgId, input)}` })
        .where(and(eq(reportSchedules.id, id), eq(reportSchedules.orgId, p.orgId)))
        .returning();
      if (!s) throw new NotFoundException({ error: 'not_found', message: 'Schedule not found' });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'report.schedule_update', target: { type: 'report_schedule', id }, outcome: 'success', meta, metadata: { name: input.name, enabled: input.enabled } }, tx);
      return s;
    });
  }

  async deleteSchedule(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(reportSchedules).where(and(eq(reportSchedules.id, id), eq(reportSchedules.orgId, p.orgId))).returning();
      if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Schedule not found' });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'report.schedule_delete', target: { type: 'report_schedule', id }, outcome: 'success', meta, metadata: { name: rows[0]!.name } }, tx);
      return { ok: true };
    });
  }

  /** Runs a schedule at its next opportunity (the worker sends it within a minute). */
  async runNow(p: Principal, id: string, meta: RequestMeta) {
    const rows = await this.db.update(reportSchedules).set({ nextRunAt: new Date() }).where(and(eq(reportSchedules.id, id), eq(reportSchedules.orgId, p.orgId))).returning();
    if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Schedule not found' });
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'report.schedule_run', target: { type: 'report_schedule', id }, outcome: 'success', meta });
    return { ok: true, queued: true };
  }

  async recentSchedules(orgId: string) {
    return this.db.select().from(reportSchedules).where(eq(reportSchedules.orgId, orgId)).orderBy(desc(reportSchedules.lastRunAt)).limit(10);
  }
}
