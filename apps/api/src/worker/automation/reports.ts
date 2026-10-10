import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { notificationChannels, reportSchedules } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { AuditService } from '../../audit/audit.service';
import { PowerService } from '../../power/power.service';
import { ReportsService, nextRunSql } from '../../reports/reports.service';
import { systemPrincipal } from '../../billing/system-principal';
import { channelContext } from '../../monitoring/channels';
import { type EmailMessage, sendEmail } from '../monitoring/notify';
import type { ReportType } from '@crapplet/shared';

export interface ReportDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  allowPrivate?: boolean;
  /** Tests replace the SMTP sender. */
  send?: (config: Record<string, unknown>, secret: Record<string, unknown>, m: EmailMessage) => Promise<void>;
}

/**
 * Sends due scheduled reports. Each schedule is claimed with a 30-minute lease
 * (so a crash doesn't send it twice in a row), generated as an organization-wide
 * staff report, emailed as an attachment through its email channel, then moved
 * to its next run time. A failure is recorded and retried at the next run.
 */
export async function runReportSchedules(deps: ReportDeps, limit = 5): Promise<number> {
  const reports = new ReportsService(deps.db, new PowerService(deps.db, new AuditService(deps.db)), new AuditService(deps.db));
  let n = 0;
  for (let i = 0; i < limit; i++) {
    const claimed = await deps.db.execute<{ id: string }>(sql`
      update report_schedules set next_run_at = now() + interval '30 minutes'
       where id = (select id from report_schedules where enabled and next_run_at <= now() order by next_run_at limit 1 for update skip locked)
      returning id`);
    const id = claimed.rows[0]?.id;
    if (!id) break;
    const [s] = await deps.db.select().from(reportSchedules).where(eq(reportSchedules.id, id));
    if (!s) continue;
    let status = 'sent';
    let error: string | null = null;
    try {
      const [ch] = await deps.db.select().from(notificationChannels).where(eq(notificationChannels.id, s.channelId));
      if (!ch) throw new Error('The email channel no longer exists');
      if (ch.kind !== 'email') throw new Error('The channel is no longer an email channel; choose an email channel for this schedule');
      if (!ch.enabled) throw new Error('The email channel is disabled');
      const p = systemPrincipal(s.orgId, `report schedule ${s.name}`);
      const out = await reports.render(p, s.type as ReportType, s.period as 'last_month', s.format as 'csv' | 'pdf');
      const secret = JSON.parse(deps.secrets.decrypt(ch.secretEnc, channelContext(ch.orgId, ch.id, ch.kind))) as Record<string, unknown>;
      const r = out.report;
      const msg: EmailMessage = {
        to: s.recipients,
        subject: `[NexoraDC] ${s.name}: ${r.title} (${r.period.from.slice(0, 10)} – ${r.period.to.slice(0, 10)})`,
        text: [`${r.title}`, `Period: ${r.period.from} to ${r.period.to} (${r.period.name}, ${r.period.timezone})`, `Rows: ${r.rows.length}`, '', ...r.notes.map((x) => `- ${x}`), '', 'The report is attached. Sent by NexoraDC.'].join('\n'),
        attachments: [{ filename: out.filename, content: out.body!, contentType: out.contentType }],
      };
      await (deps.send ? deps.send(ch.config, secret, msg) : sendEmail(ch.config, secret, msg, { allowPrivate: deps.allowPrivate }));
      n++;
    } catch (e) {
      status = 'failed';
      error = ((e as Error).message || 'Failed').slice(0, 500);
      deps.logger.warn({ scheduleId: id, err: error }, 'scheduled report failed');
    }
    try {
      await deps.db
        .update(reportSchedules)
        .set({ lastRunAt: new Date(), lastStatus: status, lastError: error, nextRunAt: sql`${nextRunSql(s.orgId, s)}` })
        .where(eq(reportSchedules.id, id));
    } catch (e) {
      // The 30-minute lease stays in place, so one broken schedule can't hold up the others.
      deps.logger.error({ scheduleId: id, err: (e as Error).message }, 'could not record a scheduled report run');
      continue;
    }
    await new AuditService(deps.db).record({ orgId: s.orgId, actor: { type: 'system', label: 'report scheduler' }, action: 'report.sent', target: { type: 'report_schedule', id }, outcome: status === 'sent' ? 'success' : 'failure', metadata: { name: s.name, type: s.type, recipients: s.recipients.length, error } });
  }
  return n;
}
