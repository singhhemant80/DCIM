import { and, eq, inArray, sql } from 'drizzle-orm';
import { ALERT_METRIC_LABELS, formatBitRate, type AlertMetric } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { alertRules, alertState, alerts, interfaces, notificationChannels, notifications, type AlertRule } from '../../db/schema';
import type { PollOutcome, PortUpdate } from './poller';

/**
 * Alert evaluation, run by the worker after every poll of a device.
 *
 * A rule fires for a target (a port, or the device for reachability) only
 * after the condition has held for `forSeconds` AND for `minSamples`
 * consecutive samples; it resolves after `clearSamples` consecutive good
 * samples. A poll that produced no value for a port (first sample, counter
 * reset, gap, device unreachable) neither advances nor clears the condition:
 * missing data is not treated as good or bad. When the gap since the last
 * evaluated sample is longer than three polling intervals, the count starts
 * again: samples on either side of an outage are not "consecutive".
 *
 * Alerts only record and notify. Nothing here (or anywhere in the system)
 * shuts a port, changes a route or otherwise acts on a device.
 *
 * Inside a maintenance window covering the device, alerts are still recorded
 * but marked suppressed and no notifications are sent. If the problem is
 * still there when the window ends, the alert is un-suppressed and notified.
 */

export interface AlertEvent {
  type: 'alert';
  orgId: string;
  alertId: string;
  status: 'firing' | 'resolved';
  severity: string;
  deviceId: string | null;
  interfaceId: string | null;
  message: string;
  suppressed: boolean;
}

interface DeviceCtx {
  orgId: string;
  deviceId: string;
  deviceName: string;
  datacenterId: string | null;
  customerId: string | null;
  inMaintenance: boolean;
}

interface PortCtx {
  id: string;
  name: string;
  enabled: boolean;
  countInTotals: boolean;
}

function inScope(rule: AlertRule, dev: DeviceCtx, port: PortCtx | null): boolean {
  switch (rule.scope) {
    case 'all':
      return true;
    case 'totals':
      return !!port?.countInTotals;
    case 'datacenter':
      return !!rule.datacenterId && rule.datacenterId === dev.datacenterId;
    case 'devices':
      return rule.deviceIds.includes(dev.deviceId);
    case 'interfaces':
      return !!port && rule.interfaceIds.includes(port.id);
    default:
      return false;
  }
}

/** The metric's value for a port this poll; null = no data this time. */
export function portValue(metric: AlertMetric, p: PortUpdate, port: PortCtx): number | null {
  switch (metric) {
    case 'util_max':
      return p.utilIn === null && p.utilOut === null ? null : Math.max(p.utilIn ?? 0, p.utilOut ?? 0);
    case 'util_in':
      return p.utilIn;
    case 'util_out':
      return p.utilOut;
    case 'in_bps':
      return p.inBps;
    case 'out_bps':
      return p.outBps;
    case 'errors_ps':
      return p.errorsPs;
    case 'discards_ps':
      return p.discardsPs;
    case 'oper_down':
      // Only ports that are meant to be up (enabled in inventory) can be "down".
      if (!port.enabled || p.operUp === null) return null;
      return p.operUp ? 0 : 1;
    default:
      return null;
  }
}

function breaches(rule: AlertRule, value: number): boolean {
  if (rule.metric === 'oper_down') return value === 1;
  if (rule.metric === 'device_unreachable') return value > 0;
  return rule.comparator === 'lt' ? value < rule.threshold : value > rule.threshold;
}

function describe(rule: AlertRule, dev: DeviceCtx, port: PortCtx | null, value: number): string {
  const where = port ? `${dev.deviceName} ${port.name}` : dev.deviceName;
  const m = rule.metric as AlertMetric;
  if (m === 'oper_down') return `${where}: port is down`;
  if (m === 'device_unreachable') return `${where}: not answering polls (${value} consecutive failures)`;
  const fmt = (v: number) => (m.startsWith('util_') ? `${v.toFixed(1)}%` : m.endsWith('_bps') ? formatBitRate(v) : `${v.toFixed(2)}/s`);
  return `${where}: ${ALERT_METRIC_LABELS[m].replace(/ \(.*\)$/, '').toLowerCase()} ${fmt(value)} ${rule.comparator === 'lt' ? '<' : '>'} ${fmt(rule.threshold)}`;
}

async function deviceContext(db: Db, orgId: string, deviceId: string, now: Date): Promise<DeviceCtx | null> {
  const r = await db.execute<{ name: string; datacenter_id: string | null; customer_id: string | null; maint: boolean }>(sql`
    select coalesce(d.hostname, d.asset_tag) as name, b.datacenter_id, d.customer_id,
           exists (select 1 from maintenance_windows w
                    where w.org_id = d.org_id and w.starts_at <= ${now.toISOString()}::timestamptz and w.ends_at > ${now.toISOString()}::timestamptz
                      and (w.scope = 'all' or (w.scope = 'datacenter' and w.datacenter_id = b.datacenter_id) or (w.scope = 'devices' and d.id = any(w.device_ids)))) as maint
      from devices d
      left join racks r on r.id = d.rack_id left join rooms rm on rm.id = r.room_id left join buildings b on b.id = rm.building_id
     where d.id = ${deviceId} and d.org_id = ${orgId}`);
  const row = r.rows[0];
  if (!row) return null;
  return { orgId, deviceId, deviceName: row.name, datacenterId: row.datacenter_id, customerId: row.customer_id, inMaintenance: row.maint };
}

/** Evaluates every enabled rule of the device's organization against one poll outcome. */
export async function evaluateAlerts(db: Db, o: PollOutcome, now: Date = o.at): Promise<AlertEvent[]> {
  const rules = await db.select().from(alertRules).where(and(eq(alertRules.orgId, o.orgId), eq(alertRules.enabled, true)));
  if (!rules.length) return [];
  const dev = await deviceContext(db, o.orgId, o.deviceId, now);
  if (!dev) return [];
  const portRows = o.ports.length
    ? await db
        .select({ id: interfaces.id, name: interfaces.name, enabled: interfaces.enabled, countInTotals: interfaces.countInTotals })
        .from(interfaces)
        .where(inArray(interfaces.id, o.ports.map((p) => p.interfaceId)))
    : [];
  const ports = new Map(portRows.map((p) => [p.id, p]));
  const events: AlertEvent[] = [];
  for (const rule of rules) {
    if (rule.metric === 'device_unreachable') {
      if (!inScope(rule, dev, null)) continue;
      const value = o.ok ? 0 : o.consecutiveFailures;
      const ev = await step(db, rule, dev, null, `d:${dev.deviceId}`, value, now, o.intervalSeconds);
      if (ev) events.push(ev);
      continue;
    }
    if (!o.ok) continue; // no data for ports this time
    for (const p of o.ports) {
      const port = ports.get(p.interfaceId);
      if (!port || !inScope(rule, dev, port)) continue;
      const value = portValue(rule.metric as AlertMetric, p, port);
      if (value === null) continue;
      const ev = await step(db, rule, dev, port, `i:${port.id}`, value, now, o.intervalSeconds);
      if (ev) events.push(ev);
    }
  }
  return events;
}

async function step(db: Db, rule: AlertRule, dev: DeviceCtx, port: PortCtx | null, targetKey: string, value: number, now: Date, intervalSeconds: number): Promise<AlertEvent | null> {
  const bad = breaches(rule, value);
  return db.transaction(async (tx) => {
    // The rule may have been edited, disabled or deleted since evaluation began:
    // hold it (FOR SHARE blocks a concurrent update) and skip if it changed.
    const [current] = await tx.select({ enabled: alertRules.enabled, updatedAt: alertRules.updatedAt }).from(alertRules).where(eq(alertRules.id, rule.id)).for('share');
    if (!current || !current.enabled || current.updatedAt.getTime() !== rule.updatedAt.getTime()) return null;
    // A previous sample older than 3 intervals does not continue a streak.
    const cutoff = new Date(now.getTime() - intervalSeconds * 3000).toISOString();
    const stale = sql`(${alertState.lastEvaluatedAt} is null or ${alertState.lastEvaluatedAt} < ${cutoff}::timestamptz)`;
    const nowTs = sql`${now.toISOString()}::timestamptz`;
    // Upsert the per-target state; the row lock serializes concurrent evaluations of the same target.
    const [st] = await tx
      .insert(alertState)
      .values({ ruleId: rule.id, targetKey, orgId: dev.orgId, breachSince: bad ? now : null, breachCount: bad ? 1 : 0, clearCount: bad ? 0 : 1, lastValue: value, lastEvaluatedAt: now })
      .onConflictDoUpdate({
        target: [alertState.ruleId, alertState.targetKey],
        set: bad
          ? {
              breachSince: sql`case when ${stale} then ${nowTs} else coalesce(${alertState.breachSince}, ${nowTs}) end`,
              breachCount: sql`case when ${stale} then 1 else ${alertState.breachCount} + 1 end`,
              clearCount: 0,
              lastValue: value,
              lastEvaluatedAt: now,
            }
          : { breachSince: null, breachCount: 0, clearCount: sql`case when ${stale} then 1 else ${alertState.clearCount} + 1 end`, lastValue: value, lastEvaluatedAt: now },
      })
      .returning();
    const [firing] = await tx
      .select()
      .from(alerts)
      .where(and(eq(alerts.ruleId, rule.id), eq(alerts.targetKey, targetKey), eq(alerts.status, 'firing')))
      .for('update');
    const event = (a: typeof alerts.$inferSelect, status: 'firing' | 'resolved'): AlertEvent => ({
      type: 'alert',
      orgId: dev.orgId,
      alertId: a.id,
      status,
      severity: a.severity,
      deviceId: a.deviceId,
      interfaceId: a.interfaceId,
      message: a.message,
      suppressed: a.suppressed,
    });
    const enqueue = async (alertId: string, ev: 'firing' | 'resolved') => {
      if (!rule.channelIds.length) return;
      const chans = await tx
        .select({ id: notificationChannels.id })
        .from(notificationChannels)
        .where(and(eq(notificationChannels.orgId, dev.orgId), eq(notificationChannels.enabled, true), inArray(notificationChannels.id, rule.channelIds)));
      if (chans.length) await tx.insert(notifications).values(chans.map((c) => ({ orgId: dev.orgId, channelId: c.id, alertId, event: ev })));
    };

    if (!firing) {
      if (!bad || !st || !st.breachSince) return null;
      const heldFor = (now.getTime() - st.breachSince.getTime()) / 1000;
      if (st.breachCount < rule.minSamples || heldFor < rule.forSeconds) return null;
      const [a] = await tx
        .insert(alerts)
        .values({
          orgId: dev.orgId,
          ruleId: rule.id,
          ruleName: rule.name,
          metric: rule.metric,
          targetKey,
          deviceId: dev.deviceId,
          interfaceId: port?.id ?? null,
          severity: rule.severity,
          message: describe(rule, dev, port, value),
          startedAt: st.breachSince,
          lastValue: value,
          peakValue: value,
          suppressed: dev.inMaintenance,
        })
        .onConflictDoNothing()
        .returning();
      if (!a) return null;
      if (!a.suppressed) await enqueue(a.id, 'firing');
      return event(a, 'firing');
    }

    const peak = firing.peakValue === null ? value : rule.comparator === 'lt' ? Math.min(firing.peakValue, value) : Math.max(firing.peakValue, value);
    if (!bad && st && st.clearCount >= rule.clearSamples) {
      const [a] = await tx.update(alerts).set({ status: 'resolved', resolvedAt: now, lastValue: value, peakValue: peak }).where(eq(alerts.id, firing.id)).returning();
      if (rule.notifyOnResolve && !firing.suppressed) await enqueue(firing.id, 'resolved');
      return event(a!, 'resolved');
    }
    const patch: Partial<typeof alerts.$inferInsert> = { lastValue: value, peakValue: peak };
    if (bad) patch.message = describe(rule, dev, port, value);
    // The maintenance window ended while the problem persists: notify now.
    const unsuppress = firing.suppressed && !dev.inMaintenance && bad;
    if (unsuppress) patch.suppressed = false;
    const [a] = await tx.update(alerts).set(patch).where(eq(alerts.id, firing.id)).returning();
    if (unsuppress) {
      await enqueue(firing.id, 'firing');
      return event(a!, 'firing');
    }
    return null;
  });
}

/**
 * Closes firing alerts whose target is no longer polled (polling removed or
 * paused, port no longer monitored, rule disabled): with no more samples they
 * could never resolve on their own. They are closed without a notification
 * and the message says why.
 */
export async function closeUnmonitoredAlerts(db: Db): Promise<number> {
  const r = await db.execute(sql`
    with gone as (
      select a.id, a.rule_id, a.target_key from alerts a
        left join alert_rules ar on ar.id = a.rule_id
        left join device_monitoring m on m.device_id = a.device_id
        left join interfaces i on i.id = a.interface_id
       where a.status = 'firing'
         and (ar.id is null or not ar.enabled or m.device_id is null or not m.enabled or (a.interface_id is not null and (i.id is null or not i.monitored))))
    update alerts set status = 'resolved', resolved_at = now(), message = left(alerts.message || ' (closed: no longer monitored)', 500)
      from gone where alerts.id = gone.id
    returning alerts.rule_id, alerts.target_key`);
  for (const row of r.rows as { rule_id: string | null; target_key: string }[]) {
    if (row.rule_id) await db.execute(sql`delete from alert_state where rule_id = ${row.rule_id} and target_key = ${row.target_key}`);
  }
  return r.rowCount ?? 0;
}
