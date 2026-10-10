import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { AlertRuleInput, ChannelInput, alertListQuerySchema, maintenanceSchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { alertRules, alertState, alerts, devices, interfaces, maintenanceWindows, notificationChannels, notifications, type NotificationChannel } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { SecretBox } from '../common/secret-box';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';
import { notFound, ownDatacenter } from '../network/common';
import { channelContext, splitChannel } from './channels';

/**
 * Alert rules, active/past alerts, maintenance windows and notification
 * channels (staff only). Evaluation and delivery happen in the worker; this
 * service only configures and reads. Alerts never trigger any action on a
 * device: no port is shut and no route is changed.
 */
@Injectable()
export class AlertsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
  ) {}

  private record(tx: DbOrTx, p: Principal, meta: RequestMeta, action: string, target: { type: string; id: string }, metadata?: Record<string, unknown>) {
    return this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action, target, outcome: 'success', meta, metadata }, tx);
  }

  /* ---------------------------------------------------------------- alerts */

  async list(p: Principal, q: z.infer<typeof alertListQuerySchema>) {
    const conds: SQL[] = [sql`a.org_id = ${p.orgId}`];
    if (q.status !== 'all') conds.push(sql`a.status = ${q.status}`);
    if (q.severity) conds.push(sql`a.severity = ${q.severity}`);
    if (q.deviceId) conds.push(sql`a.device_id = ${q.deviceId}`);
    const where = sql.join(conds, sql` and `);
    const [rows, total] = await Promise.all([
      this.db.execute(sql`
        select a.*, coalesce(d.hostname, d.asset_tag) as device_name, i.name as interface_name
          from alerts a left join devices d on d.id = a.device_id left join interfaces i on i.id = a.interface_id
         where ${where}
         order by (a.status = 'firing') desc, case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end, a.started_at desc
         limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
      this.db.execute<{ n: number }>(sql`select count(*)::int as n from alerts a where ${where}`),
    ]);
    return {
      items: (rows.rows as Record<string, unknown>[]).map((r) => ({
        id: r.id,
        ruleId: r.rule_id,
        ruleName: r.rule_name,
        metric: r.metric,
        severity: r.severity,
        status: r.status,
        message: r.message,
        deviceId: r.device_id,
        deviceName: r.device_name ?? null,
        interfaceId: r.interface_id,
        interfaceName: r.interface_name ?? null,
        startedAt: r.started_at,
        resolvedAt: r.resolved_at,
        lastValue: r.last_value,
        peakValue: r.peak_value,
        suppressed: r.suppressed,
        acknowledgedAt: r.acknowledged_at,
        acknowledgedBy: r.acknowledged_by,
        ackNote: r.ack_note,
      })),
      page: q.page,
      pageSize: q.pageSize,
      total: total.rows[0]?.n ?? 0,
    };
  }

  async summary(p: Principal) {
    const r = await this.db.execute<{ severity: string; n: number; unacked: number }>(sql`
      select severity::text, count(*)::int as n, count(*) filter (where acknowledged_at is null)::int as unacked
        from alerts where org_id = ${p.orgId} and status = 'firing' and not suppressed group by severity`);
    const by = Object.fromEntries(r.rows.map((x) => [x.severity, x.n]));
    return { firing: r.rows.reduce((a, x) => a + x.n, 0), unacknowledged: r.rows.reduce((a, x) => a + x.unacked, 0), critical: by.critical ?? 0, warning: by.warning ?? 0, info: by.info ?? 0 };
  }

  async acknowledge(p: Principal, id: string, note: string | undefined, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [a] = await tx
        .update(alerts)
        .set({ acknowledgedAt: new Date(), acknowledgedBy: p.email, ackNote: note ?? null })
        .where(and(eq(alerts.id, id), eq(alerts.orgId, p.orgId)))
        .returning();
      if (!a) throw notFound('Alert');
      await this.record(tx, p, meta, 'alert.acknowledge', { type: 'alert', id }, { note: note ?? null });
      return { id: a.id, acknowledgedAt: a.acknowledgedAt, acknowledgedBy: a.acknowledgedBy };
    });
  }

  /* ---------------------------------------------------------------- rules */

  async rules(p: Principal) {
    return this.db.select().from(alertRules).where(eq(alertRules.orgId, p.orgId)).orderBy(alertRules.name);
  }

  private async checkRuleRefs(tx: DbOrTx, p: Principal, r: AlertRuleInput) {
    if (r.scope === 'datacenter') await ownDatacenter(tx, p, r.datacenterId);
    const count = async (table: typeof devices | typeof interfaces | typeof notificationChannels, ids: string[]) =>
      ids.length ? (await tx.select({ id: table.id }).from(table).where(and(eq(table.orgId, p.orgId), inArray(table.id, ids)))).length : 0;
    const dev = [...new Set(r.deviceIds)];
    const ifs = [...new Set(r.interfaceIds)];
    const ch = [...new Set(r.channelIds)];
    if ((await count(devices, dev)) !== dev.length) throw new BadRequestException({ error: 'invalid_device', message: 'One or more devices do not exist' });
    if ((await count(interfaces, ifs)) !== ifs.length) throw new BadRequestException({ error: 'invalid_interface', message: 'One or more ports do not exist' });
    if ((await count(notificationChannels, ch)) !== ch.length) throw new BadRequestException({ error: 'invalid_channel', message: 'One or more notification channels do not exist' });
    return { deviceIds: dev, interfaceIds: ifs, channelIds: ch, datacenterId: r.scope === 'datacenter' ? (r.datacenterId ?? null) : null };
  }

  /**
   * Firing alerts of a rule that was changed, disabled or deleted are closed
   * (without a notification) and its evaluation state reset, so the new
   * definition starts clean instead of inheriting counts from the old one.
   */
  private async closeRuleAlerts(tx: DbOrTx, ruleId: string) {
    await tx.update(alerts).set({ status: 'resolved', resolvedAt: new Date() }).where(and(eq(alerts.ruleId, ruleId), eq(alerts.status, 'firing')));
    await tx.delete(alertState).where(eq(alertState.ruleId, ruleId));
  }

  async createRule(p: Principal, input: AlertRuleInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const refs = await this.checkRuleRefs(tx, p, input);
      const [r] = await tx
        .insert(alertRules)
        .values({ ...input, ...refs, orgId: p.orgId, createdBy: p.userId })
        .returning();
      await this.record(tx, p, meta, 'alert_rule.create', { type: 'alert_rule', id: r!.id }, { name: input.name, metric: input.metric, threshold: input.threshold });
      return r;
    });
  }

  async updateRule(p: Principal, id: string, input: AlertRuleInput, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const refs = await this.checkRuleRefs(tx, p, input);
      const [r] = await tx
        .update(alertRules)
        .set({ ...input, ...refs })
        .where(and(eq(alertRules.id, id), eq(alertRules.orgId, p.orgId)))
        .returning();
      if (!r) throw notFound('Alert rule');
      await this.closeRuleAlerts(tx, id);
      await this.record(tx, p, meta, 'alert_rule.update', { type: 'alert_rule', id }, { name: input.name, metric: input.metric, threshold: input.threshold, enabled: input.enabled });
      return r;
    });
  }

  async deleteRule(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [r] = await tx.select().from(alertRules).where(and(eq(alertRules.id, id), eq(alertRules.orgId, p.orgId)));
      if (!r) throw notFound('Alert rule');
      await this.closeRuleAlerts(tx, id);
      await tx.delete(alertRules).where(eq(alertRules.id, id));
      await this.record(tx, p, meta, 'alert_rule.delete', { type: 'alert_rule', id }, { name: r.name });
      return { ok: true };
    });
  }

  /* ---------------------------------------------------------------- maintenance */

  async maintenance(p: Principal) {
    return this.db
      .select()
      .from(maintenanceWindows)
      .where(and(eq(maintenanceWindows.orgId, p.orgId), sql`${maintenanceWindows.endsAt} > now() - interval '30 days'`))
      .orderBy(desc(maintenanceWindows.startsAt));
  }

  private async maintenanceValues(tx: DbOrTx, p: Principal, m: z.infer<typeof maintenanceSchema>) {
    if (m.scope === 'datacenter') await ownDatacenter(tx, p, m.datacenterId);
    const ids = m.scope === 'devices' ? [...new Set(m.deviceIds)] : [];
    if (ids.length) {
      const found = await tx.select({ id: devices.id }).from(devices).where(and(eq(devices.orgId, p.orgId), inArray(devices.id, ids)));
      if (found.length !== ids.length) throw new BadRequestException({ error: 'invalid_device', message: 'One or more devices do not exist' });
    }
    return { name: m.name, startsAt: new Date(m.startsAt), endsAt: new Date(m.endsAt), scope: m.scope, datacenterId: m.scope === 'datacenter' ? (m.datacenterId ?? null) : null, deviceIds: ids, notes: m.notes ?? null };
  }

  async createMaintenance(p: Principal, input: z.infer<typeof maintenanceSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [m] = await tx
        .insert(maintenanceWindows)
        .values({ ...(await this.maintenanceValues(tx, p, input)), orgId: p.orgId, createdBy: p.email })
        .returning();
      await this.record(tx, p, meta, 'maintenance.create', { type: 'maintenance_window', id: m!.id }, { name: input.name, startsAt: input.startsAt, endsAt: input.endsAt, scope: input.scope });
      return m;
    });
  }

  async updateMaintenance(p: Principal, id: string, input: z.infer<typeof maintenanceSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [m] = await tx
        .update(maintenanceWindows)
        .set(await this.maintenanceValues(tx, p, input))
        .where(and(eq(maintenanceWindows.id, id), eq(maintenanceWindows.orgId, p.orgId)))
        .returning();
      if (!m) throw notFound('Maintenance window');
      await this.record(tx, p, meta, 'maintenance.update', { type: 'maintenance_window', id }, { name: input.name, startsAt: input.startsAt, endsAt: input.endsAt });
      return m;
    });
  }

  async deleteMaintenance(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(maintenanceWindows).where(and(eq(maintenanceWindows.id, id), eq(maintenanceWindows.orgId, p.orgId))).returning();
      if (!rows.length) throw notFound('Maintenance window');
      await this.record(tx, p, meta, 'maintenance.delete', { type: 'maintenance_window', id }, { name: rows[0]!.name });
      return { ok: true };
    });
  }

  /* ---------------------------------------------------------------- channels */

  /** Public view: non-secret settings only, plus which secrets are set. */
  static channelView(c: NotificationChannel) {
    return { id: c.id, name: c.name, kind: c.kind, enabled: c.enabled, config: c.config, secretConfigured: true as const, lastSentAt: c.lastSentAt, lastError: c.lastError, updatedAt: c.updatedAt };
  }

  async channels(p: Principal) {
    const rows = await this.db.select().from(notificationChannels).where(eq(notificationChannels.orgId, p.orgId)).orderBy(notificationChannels.name);
    return rows.map(AlertsService.channelView);
  }

  async createChannel(p: Principal, input: ChannelInput, meta: RequestMeta) {
    const id = randomUUID();
    const { config, secret } = splitChannel(input);
    const secretEnc = this.secrets.encrypt(JSON.stringify(secret), channelContext(p.orgId, id, input.kind));
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx.insert(notificationChannels).values({ id, orgId: p.orgId, name: input.name, kind: input.kind, enabled: input.enabled, config, secretEnc }).returning();
        await this.record(tx, p, meta, 'notification_channel.create', { type: 'notification_channel', id }, { name: input.name, kind: input.kind });
        return AlertsService.channelView(c!);
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  /** Replaces a channel. Secrets are write-only, so they must be entered again (as with device credentials). */
  async updateChannel(p: Principal, id: string, input: ChannelInput, meta: RequestMeta) {
    const { config, secret } = splitChannel(input);
    const secretEnc = this.secrets.encrypt(JSON.stringify(secret), channelContext(p.orgId, id, input.kind));
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx
          .update(notificationChannels)
          .set({ name: input.name, kind: input.kind, enabled: input.enabled, config, secretEnc, lastError: null })
          .where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, p.orgId)))
          .returning();
        if (!c) throw notFound('Notification channel');
        await this.record(tx, p, meta, 'notification_channel.update', { type: 'notification_channel', id }, { name: input.name, kind: input.kind, enabled: input.enabled });
        return AlertsService.channelView(c);
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  async deleteChannel(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(notificationChannels).where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, p.orgId))).returning();
      if (!rows.length) throw notFound('Notification channel');
      // Rules keep working without it.
      await tx.execute(sql`update alert_rules set channel_ids = array_remove(channel_ids, ${id}::uuid) where org_id = ${p.orgId} and ${id}::uuid = any(channel_ids)`);
      await this.record(tx, p, meta, 'notification_channel.delete', { type: 'notification_channel', id }, { name: rows[0]!.name });
      return { ok: true };
    });
  }

  /** Queues a test message; the worker delivers it (only the worker decrypts channel secrets). */
  async testChannel(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select({ id: notificationChannels.id }).from(notificationChannels).where(and(eq(notificationChannels.id, id), eq(notificationChannels.orgId, p.orgId)));
      if (!c) throw notFound('Notification channel');
      const [n] = await tx.insert(notifications).values({ orgId: p.orgId, channelId: id, event: 'test' }).returning();
      await this.record(tx, p, meta, 'notification_channel.test', { type: 'notification_channel', id });
      return { notificationId: n!.id, status: n!.status };
    });
  }

  async deliveries(p: Principal, channelId?: string) {
    const rows = await this.db.execute(sql`
      select n.id, n.channel_id, c.name as channel_name, n.alert_id, n.event, n.status, n.attempts, n.next_attempt_at, n.last_error, n.sent_at, n.created_at
        from notifications n join notification_channels c on c.id = n.channel_id
       where n.org_id = ${p.orgId} ${channelId ? sql`and n.channel_id = ${channelId}` : sql``}
       order by n.created_at desc limit 100`);
    return (rows.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      alertId: r.alert_id,
      event: r.event,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      lastError: r.last_error,
      sentAt: r.sent_at,
      createdAt: r.created_at,
    }));
  }
}
