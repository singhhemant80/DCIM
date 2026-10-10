import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { TICKET_STATUS_LABELS, type TicketInput, type TicketStatus, ticketListQuerySchema, ticketMessageSchema, ticketTimeSchema, ticketUpdateSchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { devices, ticketMessages, ticketTimeEntries, tickets, users } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';
import { customerFor } from './common';

const staff = (p: Principal) => p.userType === 'staff';
const OPEN = ['open', 'in_progress', 'waiting_customer'];

/**
 * Support tickets and remote-hands requests. Customers see their own tickets
 * and only the public messages; staff see everything, including internal
 * notes and tickets with no customer. Remote-hands time is logged by staff
 * and shown to the customer (it is billable work). Closing or resolving a
 * ticket never acts on equipment.
 */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  private scope(p: Principal): SQL {
    if (staff(p)) return sql`t.org_id = ${p.orgId}`;
    return p.customerId ? sql`t.org_id = ${p.orgId} and t.customer_id = ${p.customerId}` : sql`false`;
  }

  private view(p: Principal, t: Record<string, unknown>) {
    return {
      id: t.id,
      number: t.number,
      customerId: t.customer_id ?? null,
      customerName: t.customer_name ?? null,
      kind: t.kind,
      priority: t.priority,
      status: t.status,
      subject: t.subject,
      deviceId: t.device_id ?? null,
      deviceName: t.device_name ?? null,
      assigneeUserId: staff(p) ? (t.assignee_user_id ?? null) : null,
      // Customers see the team, not individual staff members.
      assigneeName: staff(p) ? (t.assignee_name ?? null) : null,
      authorizedMinutes: t.authorized_minutes ?? null,
      /** Staff: all logged minutes; customers: billable minutes only. */
      minutesSpent: (staff(p) ? t.minutes_spent : t.billable_minutes) ?? 0,
      createdBy: !staff(p) && t.created_by_type === 'staff' ? 'Datacenter team' : t.created_by,
      /** Whose turn it is: the last public reply was from staff (waiting on the customer) or the customer. */
      lastPublicReplyBy: t.last_public_reply_by ?? null,
      firstResponseAt: t.first_response_at ?? null,
      resolvedAt: t.resolved_at ?? null,
      closedAt: t.closed_at ?? null,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  }

  async list(p: Principal, q: z.infer<typeof ticketListQuerySchema> & { id?: string }) {
    const conds: SQL[] = [this.scope(p)];
    if (q.id) conds.push(sql`t.id = ${q.id}`);
    if (q.status === 'open') conds.push(sql`t.status in ('open','in_progress','waiting_customer')`);
    else if (q.status !== 'all') conds.push(sql`t.status = ${q.status}`);
    if (q.kind) conds.push(sql`t.kind = ${q.kind}`);
    if (q.customerId && staff(p)) conds.push(sql`t.customer_id = ${q.customerId}`);
    if (q.mine === 'true' && staff(p)) conds.push(sql`t.assignee_user_id = ${p.userId}`);
    if (q.q) {
      const n = /^#?(\d{1,9})$/.exec(q.q);
      conds.push(n ? sql`t.number = ${Number(n[1])}` : sql`t.subject ilike ${'%' + q.q.replace(/[\\%_]/g, (m) => `\\${m}`) + '%'}`);
    }
    const where = sql.join(conds, sql` and `);
    const [rows, total] = await Promise.all([
      this.db.execute<Record<string, unknown>>(sql`
        select t.*, c.name as customer_name, coalesce(d.hostname, d.asset_tag) as device_name, u.name as assignee_name, cu.user_type::text as created_by_type,
               (select coalesce(sum(e.minutes), 0)::int from ticket_time_entries e where e.ticket_id = t.id) as minutes_spent,
               (select coalesce(sum(e.minutes) filter (where e.billable), 0)::int from ticket_time_entries e where e.ticket_id = t.id) as billable_minutes
          from tickets t left join customers c on c.id = t.customer_id left join devices d on d.id = t.device_id left join users u on u.id = t.assignee_user_id left join users cu on cu.id = t.created_by_user_id
         where ${where}
         order by (t.status in ('open','in_progress','waiting_customer')) desc,
                  case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.updated_at desc
         limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
      this.db.execute<{ n: number }>(sql`select count(*)::int as n from tickets t where ${where}`),
    ]);
    return { items: rows.rows.map((t) => this.view(p, t)), page: q.page, pageSize: q.pageSize, total: total.rows[0]?.n ?? 0 };
  }

  async get(p: Principal, id: string) {
    const { items } = await this.list(p, { id, status: 'all', page: 1, pageSize: 1 });
    const t = items[0];
    if (!t) throw new NotFoundException({ error: 'not_found', message: 'Ticket not found' });
    const [messages, time] = await Promise.all([
      this.db
        .select()
        .from(ticketMessages)
        .where(and(eq(ticketMessages.ticketId, id), staff(p) ? sql`true` : eq(ticketMessages.internal, false)))
        .orderBy(asc(ticketMessages.id)),
      this.db.select().from(ticketTimeEntries).where(eq(ticketTimeEntries.ticketId, id)).orderBy(asc(ticketTimeEntries.id)),
    ]);
    return {
      ...t,
      messages: messages.map((m) => ({ id: m.id, at: m.at, authorLabel: !staff(p) && m.authorType === 'staff' ? 'Datacenter team' : m.authorLabel, authorType: m.authorType, internal: m.internal, body: m.body })),
      // Customers see the billable work done for them, without staff identities beyond the name shown.
      time: time
        .filter((e) => staff(p) || e.billable)
        .map((e) => ({ id: e.id, at: e.at, userLabel: staff(p) ? e.userLabel : 'Datacenter team', minutes: e.minutes, note: e.note, billable: e.billable })),
    };
  }

  private async load(tx: DbOrTx, p: Principal, id: string) {
    const [t] = await tx.select().from(tickets).where(and(eq(tickets.id, id), eq(tickets.orgId, p.orgId))).for('update');
    if (!t || (!staff(p) && (!t.customerId || t.customerId !== p.customerId))) throw new NotFoundException({ error: 'not_found', message: 'Ticket not found' });
    return t;
  }

  private async system(tx: DbOrTx, ticketId: string, body: string, internal = false) {
    await tx.insert(ticketMessages).values({ ticketId, authorType: 'system', authorLabel: null, internal, body });
  }

  async create(p: Principal, input: TicketInput, meta: RequestMeta) {
    const customerId = await customerFor(this.db, p, input.customerId, { required: false });
    if (input.deviceId) {
      const [d] = await this.db.select({ customerId: devices.customerId }).from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.orgId, p.orgId)));
      // A customer can only reference its own equipment; staff may link company equipment to a customer's ticket.
      if (!d || (!staff(p) && d.customerId !== customerId) || (staff(p) && customerId && d.customerId && d.customerId !== customerId))
        throw new BadRequestException({ error: 'invalid_device', message: 'Device not found for this customer' });
    }
    try {
      return await this.db.transaction(async (tx) => {
        const n = await tx.execute<{ n: number }>(sql`
          insert into ticket_counters (org_id, next) values (${p.orgId}, 2)
          on conflict (org_id) do update set next = ticket_counters.next + 1
          returning next - 1 as n`);
        const [t] = await tx
          .insert(tickets)
          .values({
            orgId: p.orgId,
            number: n.rows[0]!.n,
            customerId,
            kind: input.kind,
            priority: input.priority,
            subject: input.subject,
            deviceId: input.deviceId ?? null,
            authorizedMinutes: input.kind === 'remote_hands' ? (input.authorizedMinutes ?? null) : null,
            createdByUserId: p.userId,
            createdBy: p.email,
            lastPublicReplyBy: staff(p) ? 'staff' : 'customer',
          })
          .returning();
        await tx.insert(ticketMessages).values({ ticketId: t!.id, authorUserId: p.userId, authorLabel: p.email, authorType: p.userType, internal: false, body: input.body });
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId, action: 'ticket.create', target: { type: 'ticket', id: t!.id }, outcome: 'success', meta, metadata: { number: t!.number, kind: input.kind, priority: input.priority } }, tx);
        return t!;
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  /** A reply. A customer reply reopens a resolved ticket or one waiting for them. */
  async reply(p: Principal, id: string, input: z.infer<typeof ticketMessageSchema>, meta: RequestMeta) {
    if (input.internal && !staff(p)) throw new ForbiddenException({ error: 'forbidden', message: 'Only staff can add internal notes' });
    return this.db.transaction(async (tx) => {
      const t = await this.load(tx, p, id);
      if (t.status === 'closed') throw new BadRequestException({ error: 'ticket_closed', message: 'The ticket is closed; open a new one' });
      const [m] = await tx.insert(ticketMessages).values({ ticketId: id, authorUserId: p.userId, authorLabel: p.email, authorType: p.userType, internal: input.internal, body: input.body }).returning();
      const patch: Partial<typeof tickets.$inferInsert> = {};
      if (!input.internal) {
        patch.lastPublicReplyBy = staff(p) ? 'staff' : 'customer';
        if (staff(p) && !t.firstResponseAt) patch.firstResponseAt = new Date();
        if (!staff(p) && (t.status === 'waiting_customer' || t.status === 'resolved')) {
          patch.status = 'open';
          patch.resolvedAt = null;
          await this.system(tx, id, `Reopened by the customer's reply`);
        }
      }
      await tx.update(tickets).set({ ...patch, updatedAt: new Date() }).where(eq(tickets.id, id));
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: t.customerId, action: input.internal ? 'ticket.note' : 'ticket.reply', target: { type: 'ticket', id }, outcome: 'success', meta, metadata: { number: t.number } }, tx);
      return { id: m!.id };
    });
  }

  /**
   * Staff change status, priority, assignee and the authorized time.
   * Customers may resolve or close their own ticket, or reopen a resolved one.
   */
  async update(p: Principal, id: string, input: z.infer<typeof ticketUpdateSchema>, meta: RequestMeta) {
    if (!staff(p) && (input.priority !== undefined || input.assigneeUserId !== undefined || input.authorizedMinutes !== undefined))
      throw new ForbiddenException({ error: 'forbidden', message: 'Only the datacenter team can change priority, assignment or authorized time' });
    try {
      return await this.db.transaction(async (tx) => {
        const t = await this.load(tx, p, id);
        if (t.status === 'closed' && input.status !== undefined && input.status !== 'closed') {
          if (!staff(p)) throw new BadRequestException({ error: 'ticket_closed', message: 'The ticket is closed; open a new one' });
        }
        if (!staff(p) && input.status !== undefined) {
          const ok = input.status === 'closed' || input.status === 'resolved' || (input.status === 'open' && t.status === 'resolved');
          if (!ok) throw new BadRequestException({ error: 'invalid_transition', message: 'You can resolve, close or reopen a resolved ticket' });
        }
        if (input.assigneeUserId) {
          const [u] = await tx.select({ type: users.userType, name: users.name }).from(users).where(and(eq(users.id, input.assigneeUserId), eq(users.orgId, p.orgId)));
          if (!u || u.type !== 'staff') throw new BadRequestException({ error: 'invalid_assignee', message: 'Assign the ticket to a staff member' });
        }
        const now = new Date();
        const patch: Partial<typeof tickets.$inferInsert> = { updatedAt: now };
        const lines: { text: string; internal: boolean }[] = [];
        if (input.status !== undefined && input.status !== t.status) {
          patch.status = input.status;
          if (input.status === 'resolved') patch.resolvedAt = now;
          if (input.status === 'closed') patch.closedAt = now;
          if (OPEN.includes(input.status)) {
            patch.resolvedAt = null;
            patch.closedAt = null;
          }
          lines.push({ text: `Status: ${TICKET_STATUS_LABELS[t.status as TicketStatus]} → ${TICKET_STATUS_LABELS[input.status]} (${p.userType === 'staff' ? 'datacenter team' : 'customer'})`, internal: false });
        }
        if (input.priority !== undefined && input.priority !== t.priority) {
          patch.priority = input.priority;
          lines.push({ text: `Priority: ${t.priority} → ${input.priority}`, internal: false });
        }
        if (input.assigneeUserId !== undefined && input.assigneeUserId !== t.assigneeUserId) {
          patch.assigneeUserId = input.assigneeUserId;
          lines.push({ text: input.assigneeUserId ? `Assigned by ${p.email}` : `Unassigned by ${p.email}`, internal: true });
        }
        if (input.authorizedMinutes !== undefined && input.authorizedMinutes !== t.authorizedMinutes) {
          patch.authorizedMinutes = input.authorizedMinutes;
          lines.push({ text: `Authorized time: ${input.authorizedMinutes ?? 'none'} min`, internal: false });
        }
        await tx.update(tickets).set(patch).where(eq(tickets.id, id));
        for (const l of lines) await this.system(tx, id, l.text, l.internal);
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: t.customerId, action: 'ticket.update', target: { type: 'ticket', id }, outcome: 'success', meta, metadata: { number: t.number, ...input } }, tx);
        return { id, changes: lines.length };
      });
    } catch (e) {
      rethrowDbError(e);
    }
  }

  /** Staff log remote-hands work. Going over the customer's authorized time is allowed but flagged. */
  async logTime(p: Principal, id: string, input: z.infer<typeof ticketTimeSchema>, meta: RequestMeta) {
    if (!staff(p)) throw new ForbiddenException({ error: 'forbidden', message: 'Only staff log work time' });
    return this.db.transaction(async (tx) => {
      const t = await this.load(tx, p, id);
      const [e] = await tx.insert(ticketTimeEntries).values({ ticketId: id, userId: p.userId, userLabel: p.email, minutes: input.minutes, note: input.note, billable: input.billable }).returning();
      const [{ total } = { total: 0 }] = await tx.select({ total: sql<number>`coalesce(sum(${ticketTimeEntries.minutes}) filter (where ${ticketTimeEntries.billable}), 0)::int` }).from(ticketTimeEntries).where(eq(ticketTimeEntries.ticketId, id));
      const over = t.authorizedMinutes !== null && total > t.authorizedMinutes;
      if (over) await this.system(tx, id, `Billable time (${total} min) is over the ${t.authorizedMinutes} min the customer authorized`, true);
      await tx.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, id));
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: t.customerId, action: 'ticket.time', target: { type: 'ticket', id }, outcome: 'success', meta, metadata: { number: t.number, minutes: input.minutes, billable: input.billable, totalBillable: total } }, tx);
      return { id: e!.id, totalBillableMinutes: total, overAuthorized: over };
    });
  }

  async assignees(p: Principal) {
    return this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(eq(users.orgId, p.orgId), eq(users.userType, 'staff'), eq(users.status, 'active'))).orderBy(asc(users.name));
  }
}
