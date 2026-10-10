import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { webhookDeliveries, webhookSubscriptions } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { advanceRun } from '../../automation/workflow-engine';
import { webhookContext } from '../../automation/contexts';
import { checkDestination, safeFetch } from '../monitoring/notify';

export interface AutomationDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Allow webhook receivers on private/loopback addresses (CDCIM_WEBHOOK_ALLOW_PRIVATE). */
  allowPrivate?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 8;
const MAX_RUN_ATTEMPTS = 5;

/**
 * Fans new events out: one delivery per matching webhook subscription and one
 * run per matching workflow. Claiming, fan-out and marking the events processed
 * happen in one transaction, so an event is fanned out exactly once.
 * Workflows never trigger on events a workflow caused (no loops).
 */
export async function dispatchEvents(deps: AutomationDeps, limit = 200): Promise<number> {
  return deps.db.transaction(async (tx) => {
    const evs = await tx.execute<{ id: number; org_id: string; type: string; caused_by_run_id: string | null }>(sql`
      select id, org_id, type, caused_by_run_id from domain_events where processed_at is null order by id limit ${limit} for update skip locked`);
    if (!evs.rows.length) return 0;
    const ids = evs.rows.map((e) => Number(e.id));
    await tx.execute(sql`
      insert into webhook_deliveries (subscription_id, event_id)
      select s.id, e.id from domain_events e
        join webhook_subscriptions s on s.org_id = e.org_id and s.enabled and (e.type = any(s.events) or '*' = any(s.events))
       where e.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      on conflict do nothing`);
    await tx.execute(sql`
      insert into workflow_runs (org_id, workflow_id, workflow_version, event_id, status)
      select e.org_id, w.id, w.version, e.id, 'pending' from domain_events e
        join workflows w on w.org_id = e.org_id and w.enabled and w.trigger = e.type
       where e.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and e.caused_by_run_id is null
      on conflict do nothing`);
    await tx.execute(sql`update domain_events set processed_at = now() where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    return ids.length;
  });
}

/** Runs pending (or just approved) workflow runs. */
export async function runWorkflows(deps: AutomationDeps, limit = 50): Promise<number> {
  const due = await deps.db.execute<{ id: string }>(sql`select id from workflow_runs where status in ('pending','approved') order by created_at limit ${limit}`);
  for (const r of due.rows) {
    try {
      await advanceRun(deps.db, r.id);
    } catch (e) {
      // Outside the step's own error handling (e.g. the database). Retried a few times, then failed,
      // so a broken run can't hold up newer ones.
      const msg = `The worker could not advance this run: ${(e as Error).message}`.slice(0, 500);
      deps.logger.error({ runId: r.id, err: (e as Error).message }, 'workflow run crashed');
      await deps.db
        .execute(sql`
          update workflow_runs set attempts = attempts + 1,
                 status = case when attempts + 1 >= ${MAX_RUN_ATTEMPTS} then 'failed' else status end,
                 finished_at = case when attempts + 1 >= ${MAX_RUN_ATTEMPTS} then now() else finished_at end,
                 log = log || jsonb_build_array(jsonb_build_object('at', now(), 'message', ${msg}::text, 'level', 'error'))
           where id = ${r.id} and status in ('pending','approved')`)
        .catch(() => undefined);
    }
  }
  return due.rows.length;
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/**
 * Delivers pending webhooks with retries (exponential backoff, 8 attempts).
 * Each delivery carries the event id so receivers can drop repeats, and an
 * HMAC-SHA256 signature over "<timestamp>.<body>".
 */
export async function deliverWebhooks(deps: AutomationDeps, limit = 25): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const f = deps.fetchImpl ?? ((url: string, init: RequestInit) => safeFetch(url, init, deps.allowPrivate));
  for (let i = 0; i < limit; i++) {
    const claimed = await deps.db.execute<{ id: string; subscription_id: string; event_id: number; attempts: number }>(sql`
      update webhook_deliveries set attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
       where id = (select id from webhook_deliveries where status = 'pending' and next_attempt_at <= now() order by next_attempt_at limit 1 for update skip locked)
      returning id, subscription_id, event_id, attempts`);
    const d = claimed.rows[0];
    if (!d) break;
    const [sub] = await deps.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, d.subscription_id));
    const ev = (await deps.db.execute(sql`select * from domain_events where id = ${d.event_id}`)).rows[0] as Record<string, unknown> | undefined;
    if (!sub || !ev || !sub.enabled) {
      await deps.db.update(webhookDeliveries).set({ status: 'cancelled', lastError: 'Subscription disabled or removed' }).where(eq(webhookDeliveries.id, d.id));
      continue;
    }
    let secret = '';
    try {
      secret = JSON.parse(deps.secrets.decrypt(sub.secretEnc, webhookContext(sub.orgId, sub.id))).signingSecret as string;
      const body = JSON.stringify({
        id: Number(ev.id),
        type: ev.type,
        occurredAt: new Date(ev.at as string).toISOString(),
        customerId: ev.customer_id ?? null,
        subject: ev.subject_type ? { type: ev.subject_type, id: ev.subject_id } : null,
        data: ev.payload,
      });
      const ts = Math.floor(Date.now() / 1000).toString();
      await checkDestination(new URL(sub.url).hostname, deps.allowPrivate);
      const res = await f(sub.url, {
        method: 'POST',
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'NexoraDC-Webhooks/1',
          'x-nexoradc-event': String(ev.type),
          'x-nexoradc-event-id': String(ev.id),
          'x-nexoradc-delivery': d.id,
          'x-nexoradc-timestamp': ts,
          'x-nexoradc-signature': signWebhook(secret, ts, body),
        },
      });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from the receiver`), { status: res.status });
      await deps.db.update(webhookDeliveries).set({ status: 'sent', sentAt: new Date(), responseStatus: res.status, lastError: null }).where(eq(webhookDeliveries.id, d.id));
      await deps.db.update(webhookSubscriptions).set({ lastSuccessAt: new Date() }).where(eq(webhookSubscriptions.id, sub.id));
      sent++;
    } catch (e) {
      const msg = ((e as Error).message || 'Delivery failed').replaceAll(secret || '\u0000', '***').slice(0, 500);
      const final = d.attempts >= MAX_ATTEMPTS;
      await deps.db
        .update(webhookDeliveries)
        .set({
          status: final ? 'failed' : 'pending',
          lastError: msg,
          responseStatus: (e as { status?: number }).status ?? null,
          nextAttemptAt: new Date(Date.now() + Math.min(30_000 * 2 ** (d.attempts - 1), 6 * 3600_000)),
        })
        .where(eq(webhookDeliveries.id, d.id));
      await deps.db.update(webhookSubscriptions).set({ lastFailureAt: new Date(), lastError: msg }).where(eq(webhookSubscriptions.id, sub.id));
      if (final) failed++;
    } finally {
      secret = '';
    }
  }
  return { sent, failed };
}
