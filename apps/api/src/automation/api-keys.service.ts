import { randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Permission } from '@crapplet/shared';
import type { z } from 'zod';
import type { apiKeySchema } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { apiKeys, organizations, users } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { hashToken, safeEqual } from '../common/tokens';
import { SessionService } from '../auth/session.service';
import type { Principal, RequestMeta } from '../auth/principal';

/** `ndc_<12 hex prefix>_<43 chars>`: the prefix finds the key, the whole token is compared by hash. */
const TOKEN = /^ndc_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

/**
 * API keys for machine clients (WHMCS module, scripts). A key belongs to a
 * staff user and carries a fixed list of scopes; at every request it can use
 * only the scopes its owner still holds, so removing a role from the owner (or
 * disabling them) narrows or stops the key too. The secret is shown once.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  async list(p: Principal) {
    const rows = await this.db
      .select({ k: apiKeys, owner: users.email })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.ownerUserId))
      .where(eq(apiKeys.orgId, p.orgId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(({ k, owner }) => ({
      id: k.id,
      name: k.name,
      prefix: `ndc_${k.prefix}_…`,
      owner,
      scopes: k.scopes,
      expiresAt: k.expiresAt,
      lastUsedAt: k.lastUsedAt,
      lastUsedIp: k.lastUsedIp,
      revokedAt: k.revokedAt,
      createdAt: k.createdAt,
      active: !k.revokedAt && (!k.expiresAt || k.expiresAt > new Date()),
    }));
  }

  async create(p: Principal, input: z.infer<typeof apiKeySchema>, meta: RequestMeta) {
    if (p.userType !== 'staff') throw new ForbiddenException({ error: 'forbidden', message: 'Only staff can create API keys' });
    const missing = input.scopes.filter((s) => !p.permissions.has(s as Permission));
    if (missing.length) throw new BadRequestException({ error: 'scope_not_held', message: `You can't give a key permissions you don't have: ${missing.join(', ')}` });
    const prefix = randomBytes(6).toString('hex');
    const token = `ndc_${prefix}_${randomBytes(32).toString('base64url')}`;
    return this.db.transaction(async (tx) => {
      const [k] = await tx
        .insert(apiKeys)
        .values({
          orgId: p.orgId,
          name: input.name,
          prefix,
          secretHash: hashToken(token),
          ownerUserId: p.userId,
          scopes: [...new Set(input.scopes)],
          expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
        })
        .returning();
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'apikey.create', target: { type: 'api_key', id: k!.id }, outcome: 'success', meta, metadata: { name: input.name, scopes: k!.scopes, expiresAt: k!.expiresAt } }, tx);
      // The only time the token is returned.
      return { id: k!.id, name: k!.name, token, scopes: k!.scopes, expiresAt: k!.expiresAt };
    });
  }

  async revoke(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, id), eq(apiKeys.orgId, p.orgId), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id, name: apiKeys.name });
      if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Active key not found' });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'apikey.revoke', target: { type: 'api_key', id }, outcome: 'success', meta, metadata: { name: rows[0]!.name } }, tx);
      return { ok: true };
    });
  }

  /** Resolves a bearer token to a principal, or null. */
  async resolve(token: string, ip: string | null): Promise<Principal | null> {
    const m = TOKEN.exec(token);
    if (!m) return null;
    const [row] = await this.db
      .select({ k: apiKeys, user: users, settings: organizations.settings })
      .from(apiKeys)
      .innerJoin(users, eq(users.id, apiKeys.ownerUserId))
      .innerJoin(organizations, eq(organizations.id, apiKeys.orgId))
      .where(eq(apiKeys.prefix, m[1]!));
    if (!row) return null;
    const { k, user, settings } = row;
    if (!safeEqual(hashToken(token), k.secretHash)) return null;
    if (k.revokedAt || (k.expiresAt && k.expiresAt <= new Date())) return null;
    if (user.status !== 'active' || user.userType !== 'staff' || user.orgId !== k.orgId) return null;
    // An owner who must still enroll in MFA can't use keys either.
    if (settings.requireMfaForStaff && !user.mfaEnabledAt) return null;
    const held = await this.sessions.effectivePermissions(user);
    const permissions = new Set<Permission>(k.scopes.filter((s) => held.has(s as Permission)) as Permission[]);
    if (!k.lastUsedAt || Date.now() - k.lastUsedAt.getTime() > 60_000) {
      await this.db.update(apiKeys).set({ lastUsedAt: new Date(), lastUsedIp: ip }).where(eq(apiKeys.id, k.id));
    }
    return {
      userId: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      userType: 'staff',
      customerId: null,
      permissions,
      sessionId: `api-key:${k.id}`,
      mfaEnrollmentRequired: false,
      apiKey: { id: k.id, name: k.name },
    };
  }
}
