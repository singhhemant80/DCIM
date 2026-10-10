import { Controller, Get, Inject } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { auditEvents, customers, roles, sessions, users } from '../db/schema';
import { CurrentPrincipal, StaffOnly } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { AuditService } from '../audit/audit.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { AlertsService } from '../monitoring/alerts.service';
import { PowerService } from '../power/power.service';

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
    private readonly monitoring: MonitoringService,
    private readonly alerts: AlertsService,
    private readonly power: PowerService,
  ) {}

  @Get('power')
  @ApiOperation({ summary: 'Dashboard power panel: current draw (measured / estimated / unknown) and the last 24 h. Null without power.read.' })
  async powerPanel(@CurrentPrincipal() p: Principal) {
    if (!p.permissions.has('power.read')) return null;
    const s = await this.power.summary(p, '24h');
    return { now: s.now, energy: s.energy, byDatacenter: s.byDatacenter, top: s.top.slice(0, 5) };
  }

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

  @Get('bandwidth')
  @ApiOperation({ summary: 'Dashboard bandwidth panel: measured totals now, the last 24 h (5-minute averages) and firing alerts. Null without monitoring.read.' })
  async bandwidth(@CurrentPrincipal() p: Principal) {
    if (!p.permissions.has('monitoring.read')) return null;
    const [now, history, alerts] = await Promise.all([this.monitoring.totals(p), this.monitoring.totalsHistory(p, '24h'), this.alerts.summary(p)]);
    return { now, history, alerts };
  }

  @Get('audit-integrity')
  @ApiOperation({ summary: 'Shortcut for the dashboard: audit chain verification.' })
  async integrity(@CurrentPrincipal() p: Principal) {
    if (!p.permissions.has('audit.read')) return null;
    return this.audit.verifyChain(p.orgId);
  }
}
