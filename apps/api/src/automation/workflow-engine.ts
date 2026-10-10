import { and, eq, sql } from 'drizzle-orm';
import { ACTION_LABELS, type WorkflowAction } from '@crapplet/shared';
import type { Db, DbOrTx } from '../db/db';
import { customers, notificationChannels, notifications, ticketMessages, tickets, users, workflowRuns, workflows, type DomainEvent, type Workflow, type WorkflowRun } from '../db/schema';
import { insertTicket } from '../colocation/tickets.service';
import { AuditService } from '../audit/audit.service';

export interface Condition {
  field: string;
  op: 'eq' | 'neq' | 'in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';
  value?: unknown;
}

export interface EventView {
  id: number | null;
  type: string;
  customerId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  at: string;
}

export const eventView = (e: DomainEvent): EventView => ({ id: e.id, type: e.type, customerId: e.customerId, subjectType: e.subjectType, subjectId: e.subjectId, payload: e.payload, at: e.at.toISOString() });

/** Dot-path lookup over plain data (no prototype access, no code). */
export function lookup(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function compare(v: unknown, op: Condition['op'], want: unknown): boolean {
  const num = (x: unknown) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : NaN);
  switch (op) {
    case 'exists':
      return v !== undefined && v !== null && v !== '';
    case 'eq':
      return String(v ?? '') === String(want ?? '');
    case 'neq':
      return String(v ?? '') !== String(want ?? '');
    case 'in':
      return Array.isArray(want) && want.map(String).includes(String(v ?? ''));
    case 'contains':
      return Array.isArray(v) ? v.map(String).includes(String(want)) : String(v ?? '').toLowerCase().includes(String(want ?? '').toLowerCase());
    case 'gt':
      return num(v) > num(want);
    case 'gte':
      return num(v) >= num(want);
    case 'lt':
      return num(v) < num(want);
    case 'lte':
      return num(v) <= num(want);
  }
}

export function evaluate(conditions: Condition[], ev: EventView): { matched: boolean; results: { field: string; op: string; value: unknown; actual: unknown; ok: boolean }[] } {
  const root = { ...ev } as unknown as Record<string, unknown>;
  const results = conditions.map((c) => {
    const actual = lookup(root, c.field);
    return { field: c.field, op: c.op, value: c.value ?? null, actual: actual === undefined ? null : actual, ok: compare(actual, c.op, c.value) };
  });
  return { matched: results.every((r) => r.ok), results };
}

/** `{{payload.subject}}`, `{{event.type}}`, `{{customer.name}}`: plain substitution, nothing else. */
export function render(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z][\w]*(?:\.[A-Za-z_][\w]*){0,5})\s*\}\}/g, (_m, path: string) => {
    const v = lookup(ctx, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export async function templateContext(db: DbOrTx, orgId: string, ev: EventView): Promise<Record<string, unknown>> {
  let customer: Record<string, unknown> = {};
  if (ev.customerId) {
    const [c] = await db.select({ name: customers.name, code: customers.code }).from(customers).where(and(eq(customers.id, ev.customerId), eq(customers.orgId, orgId)));
    if (c) customer = c;
  }
  return { event: { id: ev.id, type: ev.type, at: ev.at, customerId: ev.customerId, subjectType: ev.subjectType, subjectId: ev.subjectId }, payload: ev.payload, customer };
}

/** What each action would do, rendered (for dry-run and approval screens). */
export function describeAction(a: WorkflowAction, ctx: Record<string, unknown>, ev: EventView): string {
  switch (a.type) {
    case 'create_ticket':
      return `Create a ${a.priority} ${a.kind.replace('_', ' ')} ticket ${a.forCustomer === 'event' && ev.customerId ? 'for the event’s customer' : '(internal)'}: “${render(a.subject, ctx)}”`;
    case 'add_ticket_note':
      return ev.subjectType === 'ticket' ? `Add an internal note to ticket #${String(ev.payload.number ?? '')}: “${render(a.body, ctx).slice(0, 200)}”` : 'Add a note — but this event is not about a ticket (would fail)';
    case 'set_ticket_priority':
      return ev.subjectType === 'ticket' ? `Set ticket #${String(ev.payload.number ?? '')} to ${a.priority} priority` : 'Set priority — but this event is not about a ticket (would fail)';
    case 'assign_ticket':
      return ev.subjectType === 'ticket' ? `Assign ticket #${String(ev.payload.number ?? '')} to user ${a.userId}` : 'Assign — but this event is not about a ticket (would fail)';
    case 'notify':
      return `Notify channel ${a.channelId}: “${render(a.title, ctx)}”`;
  }
}

class StepError extends Error {}

/** Runs one action. Actions create or change records and send messages only. */
async function execute(tx: DbOrTx, wf: Workflow, run: WorkflowRun, a: WorkflowAction, ev: EventView, ctx: Record<string, unknown>): Promise<string> {
  const label = `Workflow: ${wf.name}`;
  const ticketOfEvent = async () => {
    if (ev.subjectType !== 'ticket' || !ev.subjectId) throw new StepError('The event is not about a ticket');
    const [t] = await tx.select().from(tickets).where(and(eq(tickets.id, ev.subjectId), eq(tickets.orgId, wf.orgId)));
    if (!t) throw new StepError('The ticket no longer exists');
    return t;
  };
  switch (a.type) {
    case 'create_ticket': {
      let customerId: string | null = null;
      if (a.forCustomer === 'event' && ev.customerId) {
        const [c] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.id, ev.customerId), eq(customers.orgId, wf.orgId)));
        customerId = c?.id ?? null;
      }
      const t = await insertTicket(tx, {
        orgId: wf.orgId,
        customerId,
        kind: a.kind,
        priority: a.priority,
        subject: render(a.subject, ctx).slice(0, 200) || wf.name,
        body: render(a.body, ctx).slice(0, 20_000) || wf.name,
        author: { userId: null, label, type: 'system' },
        causedByRunId: run.id,
      });
      return `Created ticket #${t.number}`;
    }
    case 'add_ticket_note': {
      const t = await ticketOfEvent();
      await tx.insert(ticketMessages).values({ ticketId: t.id, authorType: 'staff', authorLabel: label, internal: true, body: render(a.body, ctx).slice(0, 20_000) });
      return `Added an internal note to ticket #${t.number}`;
    }
    case 'set_ticket_priority': {
      const t = await ticketOfEvent();
      if (t.priority === a.priority) return `Ticket #${t.number} already ${a.priority}`;
      await tx.update(tickets).set({ priority: a.priority, updatedAt: new Date() }).where(eq(tickets.id, t.id));
      await tx.insert(ticketMessages).values({ ticketId: t.id, authorType: 'system', internal: false, body: `Priority: ${t.priority} → ${a.priority} (${label})` });
      return `Set ticket #${t.number} to ${a.priority}`;
    }
    case 'assign_ticket': {
      const t = await ticketOfEvent();
      const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, a.userId), eq(users.orgId, wf.orgId), eq(users.userType, 'staff'), eq(users.status, 'active')));
      if (!u) throw new StepError('The assignee is not an active staff member');
      await tx.update(tickets).set({ assigneeUserId: u.id, updatedAt: new Date() }).where(eq(tickets.id, t.id));
      await tx.insert(ticketMessages).values({ ticketId: t.id, authorType: 'system', internal: true, body: `Assigned by ${label}` });
      return `Assigned ticket #${t.number}`;
    }
    case 'notify': {
      const [ch] = await tx.select({ id: notificationChannels.id, enabled: notificationChannels.enabled }).from(notificationChannels).where(and(eq(notificationChannels.id, a.channelId), eq(notificationChannels.orgId, wf.orgId)));
      if (!ch) throw new StepError('The notification channel no longer exists');
      if (!ch.enabled) throw new StepError('The notification channel is disabled');
      await tx.insert(notifications).values({ orgId: wf.orgId, channelId: ch.id, event: 'workflow', payload: { title: render(a.title, ctx).slice(0, 200), text: render(a.text, ctx).slice(0, 5000) } });
      return 'Queued a notification';
    }
  }
}

const line = (message: string, level = 'info') => ({ at: new Date().toISOString(), message, level });

/**
 * Advances one run: evaluates conditions on the first pass, then runs actions in
 * order. An action that needs approval stops the run in `waiting_approval`
 * (status `approved` lets exactly that action run). Each action runs in its own
 * transaction with the run's progress, so a crash never repeats a finished action.
 */
export async function advanceRun(db: Db, runId: string): Promise<void> {
  for (;;) {
    const done = await db.transaction(async (tx) => {
      const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for('update', { skipLocked: true });
      if (!run || !['pending', 'approved'].includes(run.status)) return true;
      const [wf] = await tx.select().from(workflows).where(eq(workflows.id, run.workflowId));
      const evRow = (await tx.execute(sql`select * from domain_events where id = ${run.eventId}`)).rows[0] as Record<string, unknown> | undefined;
      const finish = async (status: string, msg: string, level = 'info') => {
        await tx
          .update(workflowRuns)
          .set({ status, finishedAt: status === 'waiting_approval' ? null : new Date(), log: sql`${workflowRuns.log} || ${JSON.stringify([line(msg, level)])}::jsonb` })
          .where(eq(workflowRuns.id, runId));
        return true;
      };
      if (!wf || !evRow) return finish('failed', 'The workflow or its event no longer exists', 'error');
      const ev: EventView = {
        id: Number(evRow.id),
        type: String(evRow.type),
        customerId: (evRow.customer_id as string | null) ?? null,
        subjectType: (evRow.subject_type as string | null) ?? null,
        subjectId: (evRow.subject_id as string | null) ?? null,
        payload: (evRow.payload as Record<string, unknown>) ?? {},
        at: new Date(evRow.at as string).toISOString(),
      };
      // A run keeps to the version it started with. Before its first step it adopts the current version;
      // once it has started (or a step was approved), a changed workflow stops it.
      if (run.workflowVersion !== wf.version) {
        if (run.nextAction > 0 || run.status === 'approved') return finish('failed', `The workflow was changed (version ${run.workflowVersion} → ${wf.version}) after this run started; the remaining steps were not run`, 'error');
        await tx.update(workflowRuns).set({ workflowVersion: wf.version }).where(eq(workflowRuns.id, runId));
      }
      const actions = wf.actions as unknown as WorkflowAction[];
      const ctx = await templateContext(tx, wf.orgId, ev);
      // First pass: the workflow version in force when the event was matched is recorded; conditions decide.
      if (run.nextAction === 0 && run.status === 'pending') {
        const { matched, results } = evaluate(wf.conditions as unknown as Condition[], ev);
        if (!matched) return finish('skipped', `Conditions not met: ${results.filter((r) => !r.ok).map((r) => `${r.field} ${r.op} ${JSON.stringify(r.value)} (was ${JSON.stringify(r.actual)})`).join('; ')}`);
      }
      const i = run.nextAction;
      const a = actions[i];
      if (!a) return finish('completed', 'All actions done');
      if (a.requiresApproval && run.status !== 'approved') {
        await tx
          .update(workflowRuns)
          .set({ status: 'waiting_approval', log: sql`${workflowRuns.log} || ${JSON.stringify([line(`Waiting for approval: ${describeAction(a, ctx, ev)}`)])}::jsonb` })
          .where(eq(workflowRuns.id, runId));
        return true;
      }
      try {
        // A savepoint, so a failed action leaves no partial rows but the run's log is still written.
        const msg = await tx.transaction(async (sp) => execute(sp, wf, run, a, ev, ctx));
        await tx
          .update(workflowRuns)
          .set({ status: 'pending', nextAction: i + 1, log: sql`${workflowRuns.log} || ${JSON.stringify([line(`${i + 1}. ${ACTION_LABELS[a.type]}: ${msg}`)])}::jsonb` })
          .where(eq(workflowRuns.id, runId));
        await new AuditService(tx).record({ orgId: wf.orgId, actor: { type: 'system', label: `workflow ${wf.name}` }, action: 'workflow.action', target: { type: 'workflow_run', id: runId }, outcome: 'success', metadata: { workflowId: wf.id, action: a.type, result: msg, eventId: ev.id } }, tx);
        return false;
      } catch (e) {
        const msg = e instanceof StepError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return finish('failed', `${i + 1}. ${ACTION_LABELS[a.type]} failed: ${msg}`, 'error');
      }
    });
    if (done) return;
  }
}
