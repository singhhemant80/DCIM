import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { paginationSchema, type CreateUserInput, type Paginated, type updateUserSchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { customers, mfaRecoveryCodes, roles, userRoles, users, type User } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import { SessionService } from '../auth/session.service';
import { RolesService } from '../roles/roles.service';
import { rethrowConflict } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';

export const userListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  userType: z.enum(['staff', 'customer']).optional(),
  customerId: z.string().uuid().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export interface UserView {
  id: string;
  email: string;
  name: string;
  userType: 'staff' | 'customer';
  customerId: string | null;
  customerName: string | null;
  status: 'active' | 'disabled';
  mfaEnabled: boolean;
  locked: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  roles: { id: string; name: string }[];
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly rolesSvc: RolesService,
  ) {}

  async list(p: Principal, q: z.infer<typeof userListQuerySchema>): Promise<Paginated<UserView>> {
    const conds: SQL[] = [eq(users.orgId, p.orgId)];
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (m: string) => `\\${m}`)}%`;
      conds.push(or(ilike(users.email, like), ilike(users.name, like))!);
    }
    if (q.userType) conds.push(eq(users.userType, q.userType));
    if (q.customerId) conds.push(eq(users.customerId, q.customerId));
    if (q.status) conds.push(eq(users.status, q.status));
    const where = and(...conds);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      this.db
        .select({ user: users, customerName: customers.name })
        .from(users)
        .leftJoin(customers, eq(customers.id, users.customerId))
        .where(where)
        .orderBy(asc(users.name))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.db.select({ total: count() }).from(users).where(where),
    ]);
    const roleMap = await this.rolesFor(rows.map((r) => r.user.id));
    return {
      items: rows.map((r) => this.view(r.user, r.customerName, roleMap.get(r.user.id) ?? [])),
      page: q.page,
      pageSize: q.pageSize,
      total,
    };
  }

  async get(p: Principal, id: string): Promise<UserView> {
    const [row] = await this.db
      .select({ user: users, customerName: customers.name })
      .from(users)
      .leftJoin(customers, eq(customers.id, users.customerId))
      .where(and(eq(users.id, id), eq(users.orgId, p.orgId)));
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'User not found' });
    const roleMap = await this.rolesFor([id]);
    return this.view(row.user, row.customerName, roleMap.get(id) ?? []);
  }

  async create(p: Principal, input: CreateUserInput, meta: RequestMeta): Promise<UserView> {
    const weak = this.passwords.weakness(input.password, { email: input.email, name: input.name });
    if (weak) throw new BadRequestException({ error: 'weak_password', message: weak });
    const passwordHash = await this.passwords.hash(input.password);
    let userId: string;
    try {
      userId = await this.db.transaction(async (tx) => {
        await this.rolesSvc.assertAssignable(p, input.roleIds, input.userType, tx);
        if (input.customerId) await this.assertCustomer(p, input.customerId, tx);
        const [u] = await tx
          .insert(users)
          .values({
            orgId: p.orgId,
            customerId: input.customerId ?? null,
            email: input.email,
            name: input.name,
            passwordHash,
            userType: input.userType,
          })
          .returning();
        await tx.insert(userRoles).values([...new Set(input.roleIds)].map((roleId) => ({ userId: u!.id, roleId })));
        await this.audit.record(
          {
            orgId: p.orgId,
            actor: actorFrom(p),
            customerId: u!.customerId,
            action: 'user.create',
            target: { type: 'user', id: u!.id },
            outcome: 'success',
            meta,
            metadata: { email: u!.email, userType: u!.userType, roleIds: input.roleIds },
          },
          tx,
        );
        return u!.id;
      });
    } catch (err) {
      rethrowConflict(err, 'A user with this email already exists');
    }
    return this.get(p, userId);
  }

  async update(p: Principal, id: string, input: z.infer<typeof updateUserSchema>, meta: RequestMeta): Promise<UserView> {
    const target = await this.getOwnRow(p, id);
    const self = target.id === p.userId;
    if (self && input.status === 'disabled') throw new ForbiddenException({ error: 'self_lockout', message: 'You cannot disable your own account' });
    if (self && input.roleIds) throw new ForbiddenException({ error: 'self_role_change', message: 'You cannot change your own roles' });

    await this.db.transaction(async (tx) => {
      // Serialize every change that could affect Super Administrator coverage, so two
      // admins disabling each other concurrently cannot leave the organization with none.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'superadmin:' + p.orgId}, 0))`);
      const before = { name: target.name, status: target.status, roleIds: (await this.rolesFor([id], tx)).get(id)?.map((r) => r.id) ?? [] };
      // Changing anything about another user (roles, status, name) requires holding every
      // permission they currently have, so a junior admin cannot strip, revive or rename a
      // more privileged account.
      if (!self) await this.assertCanManage(p, target, tx);
      if (input.roleIds) {
        await this.rolesSvc.assertAssignable(p, input.roleIds, target.userType, tx);
        await tx.delete(userRoles).where(eq(userRoles.userId, id));
        await tx.insert(userRoles).values([...new Set(input.roleIds)].map((roleId) => ({ userId: id, roleId })));
      }
      if (input.name !== undefined || input.status !== undefined) {
        await tx.update(users).set({ ...(input.name !== undefined && { name: input.name }), ...(input.status && { status: input.status }) }).where(eq(users.id, id));
      }
      if (input.status === 'disabled' && target.status !== 'disabled') {
        await this.sessions.revokeAllForUser(id, 'user_disabled', undefined, tx);
      }
      await this.assertSuperAdminRemains(p.orgId, tx);
      await this.audit.record(
        {
          orgId: p.orgId,
          actor: actorFrom(p),
          customerId: target.customerId,
          action: 'user.update',
          target: { type: 'user', id },
          outcome: 'success',
          meta,
          metadata: { before, changes: input },
        },
        tx,
      );
    });
    return this.get(p, id);
  }

  async revokeSessions(p: Principal, id: string, meta: RequestMeta): Promise<{ revoked: number }> {
    const target = await this.getOwnRow(p, id);
    return this.db.transaction(async (tx) => {
      await this.assertCanManage(p, target, tx);
      const revoked = await this.sessions.revokeAllForUser(id, 'admin_revoked', id === p.userId ? p.sessionId : undefined, tx);
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: target.customerId, action: 'user.sessions.revoke', target: { type: 'user', id }, outcome: 'success', meta, metadata: { revoked } }, tx);
      return { revoked };
    });
  }

  /** For a user who lost their authenticator and recovery codes. Signs them out everywhere. */
  async resetMfa(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    const target = await this.getOwnRow(p, id);
    if (target.id === p.userId) throw new ForbiddenException({ error: 'self_mfa_reset', message: 'Use your profile to manage your own MFA' });
    await this.db.transaction(async (tx) => {
      await this.assertCanManage(p, target, tx);
      // The admin has verified the person's identity, so clear any lockout caused by failed codes too.
      await tx.update(users).set({ mfaEnabledAt: null, mfaSecretEnc: null, mfaLastTimeStep: null, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, id));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, id));
      await this.sessions.revokeAllForUser(id, 'mfa_reset', undefined, tx);
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: target.customerId, action: 'user.mfa.reset', target: { type: 'user', id }, outcome: 'success', meta }, tx);
    });
  }

  private async assertCanManage(p: Principal, target: User, tx: DbOrTx): Promise<void> {
    const theirs = await this.sessions.effectivePermissions(target, tx);
    this.rolesSvc.assertNoEscalation(p, [...theirs]);
  }

  /** The organization must always keep at least one active Super Administrator. */
  private async assertSuperAdminRemains(orgId: string, tx: DbOrTx): Promise<void> {
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(distinct ${users.id})::int` })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(users.orgId, orgId), eq(users.status, 'active'), eq(roles.systemKey, 'super_admin')));
    if (n < 1) throw new ConflictException({ error: 'last_super_admin', message: 'At least one active Super Administrator is required' });
  }

  private async assertCustomer(p: Principal, customerId: string, tx: DbOrTx): Promise<void> {
    const [c] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.id, customerId), eq(customers.orgId, p.orgId)));
    if (!c) throw new BadRequestException({ error: 'invalid_customer', message: 'Customer does not exist' });
  }

  private async getOwnRow(p: Principal, id: string): Promise<User> {
    const [u] = await this.db.select().from(users).where(and(eq(users.id, id), eq(users.orgId, p.orgId)));
    if (!u) throw new NotFoundException({ error: 'not_found', message: 'User not found' });
    return u;
  }

  private async rolesFor(userIds: string[], tx: DbOrTx = this.db): Promise<Map<string, { id: string; name: string }[]>> {
    const map = new Map<string, { id: string; name: string }[]>();
    if (userIds.length === 0) return map;
    const rows = await tx
      .select({ userId: userRoles.userId, id: roles.id, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(inArray(userRoles.userId, userIds))
      .orderBy(asc(roles.name));
    for (const r of rows) {
      const list = map.get(r.userId) ?? [];
      list.push({ id: r.id, name: r.name });
      map.set(r.userId, list);
    }
    return map;
  }

  private view(u: User, customerName: string | null, roleList: { id: string; name: string }[]): UserView {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      userType: u.userType,
      customerId: u.customerId,
      customerName,
      status: u.status,
      mfaEnabled: !!u.mfaEnabledAt,
      locked: !!u.lockedUntil && u.lockedUntil > new Date(),
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
      roles: roleList,
    };
  }
}

