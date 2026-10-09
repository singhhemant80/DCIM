import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { getPermission, type Permission } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { customers, organizations, roles, sessions, userRoles, users, type OrgSettings, type Session, type User } from '../db/schema';
import { hashToken, newToken, safeEqual } from '../common/tokens';
import type { Principal, RequestMeta } from './principal';

export const DEFAULT_SESSION_IDLE_MINUTES = 60;
export const DEFAULT_SESSION_MAX_HOURS = 12;
/** Avoid a write on every request: only bump last_seen_at when it is this stale. */
const TOUCH_INTERVAL_MS = 60_000;

export interface IssuedSession {
  session: Session;
  token: string;
  csrfToken: string;
}

export interface ResolvedSession {
  session: Session;
  user: User;
  principal: Principal;
}

@Injectable()
export class SessionService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(user: User, meta: RequestMeta, mfaSatisfied: boolean, tx: DbOrTx = this.db): Promise<IssuedSession> {
    const settings = await this.orgSettings(user.orgId, tx);
    const token = newToken();
    const csrfToken = newToken();
    const maxHours = settings.sessionMaxHours ?? DEFAULT_SESSION_MAX_HOURS;
    const [session] = await tx
      .insert(sessions)
      .values({
        userId: user.id,
        tokenHash: hashToken(token),
        csrfTokenHash: hashToken(csrfToken),
        ip: meta.ip,
        userAgent: meta.userAgent,
        mfaSatisfied,
        expiresAt: new Date(Date.now() + maxHours * 3_600_000),
      })
      .returning();
    return { session: session!, token, csrfToken };
  }

  /**
   * Validates a session token and builds the principal. Returns null for any
   * invalid state (unknown, revoked, expired, idle, disabled user, MFA
   * pending) — callers respond 401 without saying which, to avoid leaking
   * session state.
   */
  async resolve(token: string): Promise<ResolvedSession | null> {
    if (!token || token.length > 200) return null;
    const now = new Date();
    const [row] = await this.db
      .select({ session: sessions, user: users, settings: organizations.settings, customerStatus: customers.status })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(organizations, eq(organizations.id, users.orgId))
      .leftJoin(customers, eq(customers.id, users.customerId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .limit(1);
    if (!row) return null;
    const { session, user, settings, customerStatus } = row;
    if (user.status !== 'active' || !session.mfaSatisfied) return null;
    // A closed customer account locks out all of its portal users immediately.
    if (user.userType === 'customer' && customerStatus !== 'active' && customerStatus !== 'suspended') return null;

    const idleMs = (settings.sessionIdleMinutes ?? DEFAULT_SESSION_IDLE_MINUTES) * 60_000;
    if (now.getTime() - session.lastSeenAt.getTime() > idleMs) {
      await this.revoke(session.id, 'idle_timeout');
      return null;
    }
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, session.id));
    }

    const permissions = await this.effectivePermissions(user);
    const principal: Principal = {
      userId: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      userType: user.userType,
      customerId: user.customerId,
      permissions,
      sessionId: session.id,
      mfaEnrollmentRequired: user.userType === 'staff' && !!settings.requireMfaForStaff && !user.mfaEnabledAt,
    };
    return { session, user, principal };
  }

  verifyCsrf(session: Session, headerValue: string | undefined): boolean {
    if (!headerValue) return false;
    return safeEqual(hashToken(headerValue), session.csrfTokenHash);
  }

  /**
   * Union of permissions from all of the user's roles, restricted to roles of
   * the user's own scope. Customer users additionally lose any staff-only
   * permission, so a misconfigured role can never grant a customer
   * infrastructure-wide powers.
   */
  async effectivePermissions(user: Pick<User, 'id' | 'orgId' | 'userType'>, tx: DbOrTx = this.db): Promise<Set<Permission>> {
    const rows = await tx
      .select({ permissions: roles.permissions })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(userRoles.userId, user.id), eq(roles.orgId, user.orgId), eq(roles.scope, user.userType)));
    const out = new Set<Permission>();
    for (const r of rows) {
      for (const p of r.permissions) {
        const def = getPermission(p);
        if (!def) continue; // unknown/removed permission strings grant nothing
        if (user.userType === 'customer' && def.staffOnly) continue;
        out.add(p as Permission);
      }
    }
    return out;
  }

  async listForUser(userId: string): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
      .orderBy(sql`${sessions.lastSeenAt} desc`);
  }

  async revoke(sessionId: string, reason: string, tx: DbOrTx = this.db): Promise<boolean> {
    const res = await tx
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return res.length > 0;
  }

  async revokeAllForUser(userId: string, reason: string, exceptSessionId?: string, tx: DbOrTx = this.db): Promise<number> {
    const conds = [eq(sessions.userId, userId), isNull(sessions.revokedAt)];
    if (exceptSessionId) conds.push(ne(sessions.id, exceptSessionId));
    const res = await tx
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(...conds))
      .returning({ id: sessions.id });
    return res.length;
  }

  async revokeAllForUsers(userIds: string[], reason: string, tx: DbOrTx = this.db): Promise<void> {
    if (userIds.length === 0) return;
    await tx
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(inArray(sessions.userId, userIds), isNull(sessions.revokedAt)));
  }

  private async orgSettings(orgId: string, tx: DbOrTx): Promise<OrgSettings> {
    const [org] = await tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, orgId));
    return org?.settings ?? {};
  }
}
