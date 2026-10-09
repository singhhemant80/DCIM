import { Controller, Get, Inject } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { auditEvents, customers, roles, sessions, users } from '../db/schema';
import { CurrentPrincipal, StaffOnly } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { AuditService } from '../audit/audit.service';

/**
 * Phase 1 overview: real counts from the identity/tenancy/audit tables.
 * Infrastructure metrics (racks, bandwidth, power) are added by the phases
 * that build those modules — nothing here is simulated.
 */
@ApiTags('overview')
@ApiCookieAuth()
@StaffOnly()
@Controller({ path: 'overview', version: '1' })
export class OverviewController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Platform counts for the staff dashboard.' })
  async get(@CurrentPrincipal() p: Principal) {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const now = new Date();
    const one = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
    const can = (perm: string) => p.permissions.has(perm as never);

    const [customerRows, userRows, roleCount, activeSessions, events24h, failedLogins24h, denied24h] = await Promise.all([
      can('customers.read')
        ? this.db.select({ status: customers.status, n: count() }).from(customers).where(eq(customers.orgId, p.orgId)).groupBy(customers.status)
        : Promise.resolve(null),
      can('users.read')
        ? this.db
            .select({ userType: users.userType, status: users.status, mfa: sql<boolean>`${users.mfaEnabledAt} is not null`, n: count() })
            .from(users)
            .where(eq(users.orgId, p.orgId))
            .groupBy(users.userType, users.status, sql`${users.mfaEnabledAt} is not null`)
        : Promise.resolve(null),
      can('roles.read') ? one(this.db.select({ n: count() }).from(roles).where(eq(roles.orgId, p.orgId))) : Promise.resolve(null),
      can('users.read')
        ? one(
            this.db
              .select({ n: count() })
              .from(sessions)
              .innerJoin(users, eq(users.id, sessions.userId))
              .where(and(eq(users.orgId, p.orgId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now))),
          )
        : Promise.resolve(null),
      can('audit.read') ? one(this.db.select({ n: count() }).from(auditEvents).where(and(eq(auditEvents.orgId, p.orgId), gt(auditEvents.occurredAt, since)))) : Promise.resolve(null),
      can('audit.read')
        ? one(this.db.select({ n: count() }).from(auditEvents).where(and(eq(auditEvents.orgId, p.orgId), gt(auditEvents.occurredAt, since), eq(auditEvents.action, 'auth.login'), eq(auditEvents.outcome, 'failure'))))
        : Promise.resolve(null),
      can('audit.read')
        ? one(this.db.select({ n: count() }).from(auditEvents).where(and(eq(auditEvents.orgId, p.orgId), gt(auditEvents.occurredAt, since), eq(auditEvents.outcome, 'denied'))))
        : Promise.resolve(null),
    ]);

    const sum = <T extends { n: number }>(rows: T[] | null, f: (r: T) => boolean) => (rows ? rows.filter(f).reduce((a, r) => a + r.n, 0) : null);
    return {
      generatedAt: now,
      customers: customerRows && {
        total: sum(customerRows, () => true),
        active: sum(customerRows, (r) => r.status === 'active'),
        suspended: sum(customerRows, (r) => r.status === 'suspended'),
        closed: sum(customerRows, (r) => r.status === 'closed'),
      },
      users: userRows && {
        staff: sum(userRows, (r) => r.userType === 'staff' && r.status === 'active'),
        customer: sum(userRows, (r) => r.userType === 'customer' && r.status === 'active'),
        disabled: sum(userRows, (r) => r.status === 'disabled'),
        staffWithoutMfa: sum(userRows, (r) => r.userType === 'staff' && r.status === 'active' && !r.mfa),
      },
      roles: roleCount,
      activeSessions,
      audit: can('audit.read') ? { events24h, failedLogins24h, denied24h } : null,
    };
  }

  @Get('audit-integrity')
  @ApiOperation({ summary: 'Shortcut for the dashboard: audit chain verification.' })
  async integrity(@CurrentPrincipal() p: Principal) {
    if (!p.permissions.has('audit.read')) return null;
    return this.audit.verifyChain(p.orgId);
  }
}
