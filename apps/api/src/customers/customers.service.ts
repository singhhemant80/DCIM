import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { paginationSchema, type CustomerInput, type Paginated } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { customers, sessions, users, type Customer } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowConflict } from '../common/pg-errors';
import { tenantFilter } from '../tenancy/tenant-scope';
import type { Principal, RequestMeta } from '../auth/principal';

export const customerListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'suspended', 'closed']).optional(),
});

/** Customers are themselves tenants: for a customer principal, the "row owner" is the row's own id. */
const scopeCols = { orgId: customers.orgId, customerId: customers.id };

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(p: Principal, q: z.infer<typeof customerListQuerySchema>): Promise<Paginated<ReturnType<CustomersService['view']>>> {
    const conds: SQL[] = [tenantFilter(p, scopeCols)];
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m: string) => `\\${m}`)}%`;
      conds.push(or(ilike(customers.name, like), ilike(customers.code, like), ilike(customers.contactEmail, like))!);
    }
    if (q.status) conds.push(eq(customers.status, q.status));
    const where = and(...conds);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      this.db
        .select({ c: customers, userCount: sql<number>`(select count(*)::int from users u where u.customer_id = "customers"."id")` })
        .from(customers)
        .where(where)
        .orderBy(asc(customers.name))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.db.select({ total: count() }).from(customers).where(where),
    ]);
    return { items: rows.map((r) => this.view(p, r.c, r.userCount)), page: q.page, pageSize: q.pageSize, total };
  }

  async get(p: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), tenantFilter(p, scopeCols)));
    // 404 for both "missing" and "someone else's" so existence never leaks across tenants.
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'Customer not found' });
    return this.view(p, row);
  }

  async create(p: Principal, input: CustomerInput, meta: RequestMeta) {
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx
          .insert(customers)
          .values({ ...this.columns(input), orgId: p.orgId })
          .returning();
        await this.audit.record(
          { orgId: p.orgId, actor: actorFrom(p), customerId: c!.id, action: 'customer.create', target: { type: 'customer', id: c!.id }, outcome: 'success', meta, metadata: { code: c!.code, name: c!.name } },
          tx,
        );
        return this.view(p, c!);
      });
    } catch (err) {
      rethrowConflict(err, 'A customer with this code already exists');
    }
  }

  async update(p: Principal, id: string, input: CustomerInput, meta: RequestMeta) {
    const before = await this.get(p, id);
    try {
      return await this.db.transaction(async (tx) => {
        const [c] = await tx
          .update(customers)
          .set(this.columns(input))
          .where(and(eq(customers.id, id), eq(customers.orgId, p.orgId)))
          .returning();
        let sessionsRevoked = 0;
        if (c!.status === 'closed' && before.status !== 'closed') {
          // Closing a customer ends every portal session it has.
          const res = await tx
            .update(sessions)
            .set({ revokedAt: new Date(), revokedReason: 'customer_closed' })
            .where(and(isNull(sessions.revokedAt), inArray(sessions.userId, tx.select({ id: users.id }).from(users).where(eq(users.customerId, id)))))
            .returning({ id: sessions.id });
          sessionsRevoked = res.length;
        }
        await this.audit.record(
          {
            orgId: p.orgId,
            actor: actorFrom(p),
            customerId: id,
            action: 'customer.update',
            target: { type: 'customer', id },
            outcome: 'success',
            meta,
            metadata: { before: { code: before.code, name: before.name, status: before.status }, after: { code: c!.code, name: c!.name, status: c!.status }, sessionsRevoked },
          },
          tx,
        );
        return this.view(p, c!);
      });
    } catch (err) {
      rethrowConflict(err, 'A customer with this code already exists');
    }
  }

  private columns(input: CustomerInput) {
    return {
      name: input.name,
      code: input.code,
      contactEmail: input.contactEmail ?? null,
      phone: input.phone ?? null,
      billingReference: input.billingReference ?? null,
      notes: input.notes ?? null,
      status: input.status,
    };
  }

  /** Internal notes and billing references are staff-only and stripped for customer principals. */
  /** Counts of everything assigned to one customer, for the customer's page. */
  async summary(p: Principal, id: string) {
    await this.get(p, id); // tenant check (404 for someone else's)
    const n = (q: SQL) => sql<number>`(${q})::int`;
    const [row] = (
      await this.db.execute<Record<string, number>>(sql`select
        ${n(sql`select count(*) from devices where org_id = ${p.orgId} and customer_id = ${id} and lifecycle_state <> 'retired'`)} as devices,
        ${n(sql`select count(*) from devices where org_id = ${p.orgId} and customer_id = ${id} and lifecycle_state <> 'retired' and category in ('server', 'gpu_server')`)} as servers,
        ${n(sql`select count(*) from ip_addresses where org_id = ${p.orgId} and customer_id = ${id} and status in ('allocated', 'reserved')`)} as ips,
        ${n(sql`select count(*) from prefixes where org_id = ${p.orgId} and customer_id = ${id}`)} as prefixes,
        ${n(sql`select count(*) from colo_allocations where org_id = ${p.orgId} and customer_id = ${id} and ended_at is null`)} as allocations,
        ${n(sql`select coalesce(sum(end_u - start_u + 1), 0) from colo_allocations where org_id = ${p.orgId} and customer_id = ${id} and ended_at is null`)} as "allocatedU",
        ${n(sql`select coalesce(sum(contracted_power_w), 0) from colo_allocations where org_id = ${p.orgId} and customer_id = ${id} and ended_at is null`)} as "contractedPowerW",
        ${n(sql`select count(*) from cross_connects where org_id = ${p.orgId} and customer_id = ${id} and status not in ('rejected', 'decommissioned')`)} as "crossConnects",
        ${n(sql`select count(*) from services where org_id = ${p.orgId} and customer_id = ${id} and status in ('pending', 'active', 'suspended')`)} as services,
        ${n(sql`select count(*) from tickets where org_id = ${p.orgId} and customer_id = ${id} and status not in ('resolved', 'closed')`)} as "openTickets",
        ${n(sql`select count(*) from users where customer_id = ${id}`)} as users`)
    ).rows;
    return row!;
  }

  view(p: Principal, c: Customer, userCount?: number) {
    const base = {
      id: c.id,
      code: c.code,
      name: c.name,
      contactEmail: c.contactEmail,
      phone: c.phone,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      ...(userCount !== undefined && { userCount }),
    };
    if (p.userType !== 'staff') return base;
    return { ...base, billingReference: c.billingReference, notes: c.notes };
  }
}
