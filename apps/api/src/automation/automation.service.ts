import { randomBytes } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, inArray, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { WorkflowAction, WorkflowInput, WebhookSubscriptionInput, dryRunSchema, runDecisionSchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { domainEvents, notificationChannels, users, webhookDeliveries, webhookSubscriptions, workflowRuns, workflows, type DomainEvent } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { SecretBox } from '../common/secret-box';
import type { Principal, RequestMeta } from '../auth/principal';
import { webhookContext } from './contexts';
import { describeAction, evaluate, eventView, templateContext, type Condition, type EventView } from './workflow-engine';

const isUnique = (e: unknown) => ((e as { cause?: { code?: string } }).cause ?? (e as { code?: string })).code === '23505';

/**
 * Outbound webhook subscriptions, the event log, and workflows with approvals
 * and dry-runs. Workflow actions only create or change records and send
 * messages; there is no action that switches power or changes the network.
 */
@Injectable()
export class AutomationService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
  ) {}

  private record(p: Principal, meta: RequestMeta, action: string, target: { type: string; id: string }, metadata?: Record<string, unknown>, tx?: DbOrTx) {
    return this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action, target, outcome: 'success', meta, metadata }, tx);
  }

  /* ================================================================ events */

  async events(p: Principal, q: { type?: string; limit?: number }) {
    return this.db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.orgId, p.orgId), q.type ? eq(domainEvents.type, q.type) : sql`true`))
      .orderBy(desc(domainEvents.id))
      .limit(Math.min(q.limit ?? 100, 500));
  }

  /* ================================================================ webhook subscriptions */

  private static subView(s: typeof webhookSubscriptions.$inferSelect) {
    const { secretEnc: _s, ...rest } = s;
    return rest;
  }

  async subscriptions(p: Principal) {
    const rows = await this.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.orgId, p.orgId)).orderBy(webhookSubscriptions.name);
    const stats = await this.db.execute<{ subscription_id: string; pending: number; failed: number; sent: number }>(sql`
      select d.subscription_id, count(*) filter (where d.status = 'pending')::int as pending, count(*) filter (where d.status = 'failed')::int as failed,
             count(*) filter (where d.status = 'sent' and d.sent_at > now() - interval '7 days')::int as sent
        from webhook_deliveries d join webhook_subscriptions s on s.id = d.subscription_id where s.org_id = ${p.orgId} group by 1`);
    const by = new Map(stats.rows.map((r) => [r.subscription_id, r]));
    return rows.map((s) => ({ ...AutomationService.subView(s), pending: by.get(s.id)?.pending ?? 0, failed: by.get(s.id)?.failed ?? 0, sent7d: by.get(s.id)?.sent ?? 0 }));
  }

  async createSubscription(p: Principal, input: WebhookSubscriptionInput, meta: RequestMeta) {
    const id = crypto.randomUUID();
    const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    try {
      return await this.db.transaction(async (tx) => {
        const [s] = await tx
          .insert(webhookSubscriptions)
          .values({ id, orgId: p.orgId, name: input.name, url: input.url, events: [...new Set(input.events)], enabled: input.enabled, secretEnc: this.secrets.encrypt(JSON.stringify({ signingSecret }), webhookContext(p.orgId, id)) })
          .returning();
        await this.record(p, meta, 'webhook.create', { type: 'webhook_subscription', id }, { name: input.name, url: input.url, events: s!.events }, tx);
        // The signing secret is shown once.
        return { ...AutomationService.subView(s!), signingSecret };
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ error: 'duplicate_name', message: 'A webhook with this name already exists' });
      throw e;
    }
  }

  async updateSubscription(p: Principal, id: string, input: WebhookSubscriptionInput, meta: RequestMeta) {
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .update(webhookSubscriptions)
          .set({ name: input.name, url: input.url, events: [...new Set(input.events)], enabled: input.enabled })
          .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.orgId, p.orgId)))
          .returning();
        if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Webhook not found' });
        await this.record(p, meta, 'webhook.update', { type: 'webhook_subscription', id }, { name: input.name, url: input.url, events: rows[0]!.events, enabled: input.enabled }, tx);
        return AutomationService.subView(rows[0]!);
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ error: 'duplicate_name', message: 'A webhook with this name already exists' });
      throw e;
    }
  }

  async rotateSecret(p: Principal, id: string, meta: RequestMeta) {
    const signingSecret = `whsec_${randomBytes(24).toString('base64url')}`;
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(webhookSubscriptions)
        .set({ secretEnc: this.secrets.encrypt(JSON.stringify({ signingSecret }), webhookContext(p.orgId, id)) })
        .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.orgId, p.orgId)))
        .returning({ id: webhookSubscriptions.id });
      if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Webhook not found' });
      await this.record(p, meta, 'webhook.rotate_secret', { type: 'webhook_subscription', id }, undefined, tx);
      return { signingSecret };
    });
  }

  async deleteSubscription(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(webhookSubscriptions).where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.orgId, p.orgId))).returning({ name: webhookSubscriptions.name });
      if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Webhook not found' });
      await this.record(p, meta, 'webhook.delete', { type: 'webhook_subscription', id }, { name: rows[0]!.name }, tx);
      return { ok: true };
    });
  }

  async deliveries(p: Principal, id: string) {
    const [s] = await this.db.select({ id: webhookSubscriptions.id }).from(webhookSubscriptions).where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.orgId, p.orgId)));
    if (!s) throw new NotFoundException({ error: 'not_found', message: 'Webhook not found' });
    const r = await this.db.execute(sql`
      select d.id, d.event_id, e.type as event_type, d.status, d.attempts, d.next_attempt_at, d.response_status, d.last_error, d.sent_at, d.created_at
        from webhook_deliveries d join domain_events e on e.id = d.event_id where d.subscription_id = ${id} order by d.created_at desc limit 200`);
    return r.rows;
  }

  /** Sends a delivery again (same event id, so receivers can still de-duplicate). */
  async redeliver(p: Principal, deliveryId: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const r = await tx.execute<{ id: string }>(sql`
        update webhook_deliveries d set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null
          from webhook_subscriptions s where d.id = ${deliveryId} and s.id = d.subscription_id and s.org_id = ${p.orgId} returning d.id`);
      if (!r.rows.length) throw new NotFoundException({ error: 'not_found', message: 'Delivery not found' });
      await this.record(p, meta, 'webhook.redeliver', { type: 'webhook_delivery', id: deliveryId }, undefined, tx);
      return { ok: true };
    });
  }

  /* ================================================================ workflows */

  private async checkActions(p: Principal, actions: WorkflowAction[]) {
    for (const a of actions) {
      if (a.type === 'notify') {
        const [c] = await this.db.select({ id: notificationChannels.id }).from(notificationChannels).where(and(eq(notificationChannels.id, a.channelId), eq(notificationChannels.orgId, p.orgId)));
        if (!c) throw new BadRequestException({ error: 'invalid_channel', message: 'Notification channel not found' });
      }
      if (a.type === 'assign_ticket') {
        const [u] = await this.db.select({ id: users.id }).from(users).where(and(eq(users.id, a.userId), eq(users.orgId, p.orgId), eq(users.userType, 'staff')));
        if (!u) throw new BadRequestException({ error: 'invalid_assignee', message: 'Assign to a staff member of this organization' });
      }
    }
  }

  async workflows(p: Principal) {
    const rows = await this.db.select().from(workflows).where(eq(workflows.orgId, p.orgId)).orderBy(workflows.name);
    const stats = await this.db.execute<{ workflow_id: string; waiting: number; failed: number; completed: number; last: string | null }>(sql`
      select workflow_id, count(*) filter (where status = 'waiting_approval')::int as waiting, count(*) filter (where status = 'failed' and created_at > now() - interval '7 days')::int as failed,
             count(*) filter (where status = 'completed' and created_at > now() - interval '7 days')::int as completed, max(created_at) as last
        from workflow_runs where org_id = ${p.orgId} group by 1`);
    const by = new Map(stats.rows.map((r) => [r.workflow_id, r]));
    return rows.map((w) => ({ ...w, waiting: by.get(w.id)?.waiting ?? 0, failed7d: by.get(w.id)?.failed ?? 0, completed7d: by.get(w.id)?.completed ?? 0, lastRunAt: by.get(w.id)?.last ?? null }));
  }

  async createWorkflow(p: Principal, input: WorkflowInput, meta: RequestMeta) {
    await this.checkActions(p, input.actions);
    try {
      return await this.db.transaction(async (tx) => {
        const [w] = await tx
          .insert(workflows)
          .values({ orgId: p.orgId, name: input.name, description: input.description ?? null, enabled: input.enabled, trigger: input.trigger, conditions: input.conditions, actions: input.actions, updatedByUserId: p.userId, updatedBy: p.email })
          .returning();
        await this.record(p, meta, 'workflow.create', { type: 'workflow', id: w!.id }, { name: input.name, trigger: input.trigger, actions: input.actions.map((a) => a.type) }, tx);
        return w!;
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ error: 'duplicate_name', message: 'A workflow with this name already exists' });
      throw e;
    }
  }

  async updateWorkflow(p: Principal, id: string, input: WorkflowInput, meta: RequestMeta) {
    await this.checkActions(p, input.actions);
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .update(workflows)
          .set({ name: input.name, description: input.description ?? null, enabled: input.enabled, trigger: input.trigger, conditions: input.conditions, actions: input.actions, version: sql`${workflows.version} + 1`, updatedByUserId: p.userId, updatedBy: p.email })
          .where(and(eq(workflows.id, id), eq(workflows.orgId, p.orgId)))
          .returning();
        if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Workflow not found' });
        // Runs waiting for approval were matched against the old definition: they are stopped, not silently changed.
        const stopped = await tx
          .update(workflowRuns)
          .set({ status: 'rejected', finishedAt: new Date(), decidedBy: p.email, decidedAt: new Date(), log: sql`${workflowRuns.log} || ${JSON.stringify([{ at: new Date().toISOString(), message: 'Stopped: the workflow was changed before the approved step ran', level: 'warn' }])}::jsonb` })
          .where(and(eq(workflowRuns.workflowId, id), inArray(workflowRuns.status, ['waiting_approval', 'approved'])))
          .returning({ id: workflowRuns.id });
        await this.record(p, meta, 'workflow.update', { type: 'workflow', id }, { name: input.name, version: rows[0]!.version, enabled: input.enabled, stoppedRuns: stopped.length }, tx);
        return rows[0]!;
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ error: 'duplicate_name', message: 'A workflow with this name already exists' });
      throw e;
    }
  }

  async deleteWorkflow(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.delete(workflows).where(and(eq(workflows.id, id), eq(workflows.orgId, p.orgId))).returning({ name: workflows.name });
      if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Workflow not found' });
      await this.record(p, meta, 'workflow.delete', { type: 'workflow', id }, { name: rows[0]!.name }, tx);
      return { ok: true };
    });
  }

  async runs(p: Principal, q: { workflowId?: string; status?: string }) {
    const r = await this.db.execute(sql`
      select r.*, w.name as workflow_name, e.type as event_type, e.subject_type, e.subject_id
        from workflow_runs r join workflows w on w.id = r.workflow_id join domain_events e on e.id = r.event_id
       where r.org_id = ${p.orgId} ${q.workflowId ? sql`and r.workflow_id = ${q.workflowId}` : sql``} ${q.status ? sql`and r.status = ${q.status}` : sql``}
       order by (r.status = 'waiting_approval') desc, r.created_at desc limit 200`);
    return r.rows;
  }

  /**
   * Approves the action a run is waiting on. Four eyes: the person who last
   * changed the workflow can't approve its runs.
   */
  async decide(p: Principal, runId: string, approve: boolean, input: z.infer<typeof runDecisionSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.orgId, p.orgId))).for('update');
      if (!run) throw new NotFoundException({ error: 'not_found', message: 'Run not found' });
      if (run.status !== 'waiting_approval') throw new ConflictException({ error: 'not_waiting', message: 'The run is not waiting for approval' });
      const [wf] = await tx.select().from(workflows).where(eq(workflows.id, run.workflowId));
      if (approve && wf?.updatedByUserId === p.userId) throw new ForbiddenException({ error: 'four_eyes', message: 'Someone other than the last editor of the workflow must approve it' });
      const msg = `${approve ? 'Approved' : 'Rejected'} by ${p.email}${input.note ? `: ${input.note}` : ''}`;
      await tx
        .update(workflowRuns)
        .set({
          status: approve ? 'approved' : 'rejected',
          decidedBy: p.email,
          decidedAt: new Date(),
          finishedAt: approve ? null : new Date(),
          log: sql`${workflowRuns.log} || ${JSON.stringify([{ at: new Date().toISOString(), message: msg, level: approve ? 'info' : 'warn' }])}::jsonb`,
        })
        .where(eq(workflowRuns.id, runId));
      await this.record(p, meta, approve ? 'workflow.approve' : 'workflow.reject', { type: 'workflow_run', id: runId }, { workflowId: run.workflowId, action: run.nextAction, note: input.note ?? null }, tx);
      return { id: runId, status: approve ? 'approved' : 'rejected' };
    });
  }

  /** Evaluates a workflow definition against a stored or sample event. Nothing is executed or stored. */
  async dryRun(p: Principal, input: z.infer<typeof dryRunSchema>) {
    await this.checkActions(p, input.workflow.actions);
    let ev: EventView;
    if (input.eventId) {
      const [e] = await this.db.select().from(domainEvents).where(and(eq(domainEvents.id, input.eventId), eq(domainEvents.orgId, p.orgId)));
      if (!e) throw new NotFoundException({ error: 'not_found', message: 'Event not found' });
      ev = eventView(e as DomainEvent);
    } else if (input.sample) {
      ev = { id: null, type: input.workflow.trigger, customerId: input.sample.customerId ?? null, subjectType: null, subjectId: null, payload: input.sample.payload, at: new Date().toISOString() };
      if (input.workflow.trigger.startsWith('ticket.')) ev.subjectType = 'ticket';
    } else {
      throw new BadRequestException({ error: 'event_required', message: 'Give an event id or a sample payload' });
    }
    const triggerMatches = ev.type === input.workflow.trigger;
    const { matched, results } = evaluate(input.workflow.conditions as Condition[], ev);
    const ctx = await templateContext(this.db, p.orgId, ev);
    return {
      event: ev,
      triggerMatches,
      conditionsMatched: matched,
      wouldRun: triggerMatches && matched,
      conditions: results,
      actions: input.workflow.actions.map((a, i) => ({ step: i + 1, type: a.type, requiresApproval: a.requiresApproval, description: describeAction(a, ctx, ev) })),
    };
  }
}
