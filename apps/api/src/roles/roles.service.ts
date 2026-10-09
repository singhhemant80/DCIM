import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { staffOnlyViolations, type createRoleSchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { roles, userRoles, type Role } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowConflict } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';

type RoleInput = z.infer<typeof createRoleSchema>;

@Injectable()
export class RolesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async list(p: Principal) {
    const rows = await this.db
      .select({ role: roles, members: sql<number>`(select count(*)::int from ${userRoles} where ${userRoles.roleId} = ${roles.id})` })
      .from(roles)
      .where(eq(roles.orgId, p.orgId))
      .orderBy(asc(roles.scope), asc(roles.name));
    return rows.map(({ role, members }) => ({ ...this.view(role), members }));
  }

  /**
   * Loads roles by id within the principal's org and checks that:
   *  - every id exists in this organization,
   *  - every role matches the target user type,
   *  - the acting principal already holds every permission the roles grant
   *    (nobody can hand out more power than they have).
   */
  async assertAssignable(p: Principal, roleIds: string[], userType: 'staff' | 'customer', tx: DbOrTx = this.db): Promise<Role[]> {
    const unique = [...new Set(roleIds)];
    const found = await tx.select().from(roles).where(and(eq(roles.orgId, p.orgId), inArray(roles.id, unique)));
    if (found.length !== unique.length) throw new BadRequestException({ error: 'invalid_role', message: 'One or more roles do not exist' });
    const wrongScope = found.filter((r) => r.scope !== userType);
    if (wrongScope.length) {
      throw new BadRequestException({ error: 'invalid_role', message: `Role "${wrongScope[0]!.name}" is for ${wrongScope[0]!.scope} users` });
    }
    this.assertNoEscalation(p, found.flatMap((r) => r.permissions));
    return found;
  }

  assertNoEscalation(p: Principal, perms: string[]): void {
    const beyond = [...new Set(perms)].filter((x) => !p.permissions.has(x as never));
    if (beyond.length) {
      throw new ForbiddenException({ error: 'privilege_escalation', message: `You cannot grant permissions you do not hold: ${beyond.join(', ')}` });
    }
  }

  async create(p: Principal, input: RoleInput, meta: RequestMeta) {
    this.validatePermissions(input.scope, input.permissions);
    this.assertNoEscalation(p, input.permissions);
    try {
      return await this.db.transaction(async (tx) => {
        const [role] = await tx
          .insert(roles)
          .values({ orgId: p.orgId, name: input.name, description: input.description, scope: input.scope, permissions: [...new Set(input.permissions)] })
          .returning();
        await this.audit.record(
          { orgId: p.orgId, actor: actorFrom(p), action: 'role.create', target: { type: 'role', id: role!.id }, outcome: 'success', meta, metadata: { name: role!.name, scope: role!.scope, permissions: role!.permissions } },
          tx,
        );
        return this.view(role!);
      });
    } catch (err) {
      rethrowConflict(err, 'A role with this name already exists');
    }
  }

  async update(p: Principal, id: string, input: RoleInput, meta: RequestMeta) {
    const existing = await this.getOwn(p, id);
    if (existing.systemKey) throw new ForbiddenException({ error: 'system_role', message: 'Built-in roles cannot be modified' });
    if (input.scope !== existing.scope) {
      throw new BadRequestException({ error: 'scope_change', message: 'A role’s scope cannot change after creation' });
    }
    this.validatePermissions(input.scope, input.permissions);
    // Must hold both what is being added and what the role already grants (editing a role you could not assign is escalation too).
    this.assertNoEscalation(p, [...input.permissions, ...existing.permissions]);
    try {
      return await this.db.transaction(async (tx) => {
        const [role] = await tx
          .update(roles)
          .set({ name: input.name, description: input.description, permissions: [...new Set(input.permissions)] })
          .where(eq(roles.id, id))
          .returning();
        await this.audit.record(
          {
            orgId: p.orgId,
            actor: actorFrom(p),
            action: 'role.update',
            target: { type: 'role', id },
            outcome: 'success',
            meta,
            metadata: { before: { name: existing.name, permissions: existing.permissions }, after: { name: role!.name, permissions: role!.permissions } },
          },
          tx,
        );
        return this.view(role!);
      });
    } catch (err) {
      rethrowConflict(err, 'A role with this name already exists');
    }
  }

  async remove(p: Principal, id: string, meta: RequestMeta): Promise<void> {
    const existing = await this.getOwn(p, id);
    if (existing.systemKey) throw new ForbiddenException({ error: 'system_role', message: 'Built-in roles cannot be deleted' });
    this.assertNoEscalation(p, existing.permissions);
    await this.db.transaction(async (tx) => {
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(userRoles).where(eq(userRoles.roleId, id));
      if (n > 0) throw new ConflictException({ error: 'role_in_use', message: `Role is assigned to ${n} user(s); reassign them first` });
      await tx.delete(roles).where(eq(roles.id, id));
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'role.delete', target: { type: 'role', id }, outcome: 'success', meta, metadata: { name: existing.name } }, tx);
    });
  }

  private validatePermissions(scope: 'staff' | 'customer', perms: string[]): void {
    if (scope === 'customer') {
      const bad = staffOnlyViolations(perms);
      if (bad.length) throw new BadRequestException({ error: 'staff_only_permission', message: `Not allowed for customer roles: ${bad.join(', ')}` });
    }
  }

  private async getOwn(p: Principal, id: string): Promise<Role> {
    const [role] = await this.db.select().from(roles).where(and(eq(roles.id, id), eq(roles.orgId, p.orgId)));
    if (!role) throw new NotFoundException({ error: 'not_found', message: 'Role not found' });
    return role;
  }

  private view(r: Role) {
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      scope: r.scope,
      permissions: [...r.permissions].sort(),
      system: !!r.systemKey,
      systemKey: r.systemKey,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}
