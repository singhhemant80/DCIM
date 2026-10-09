import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { DB, type Db } from '../db/db';
import { customers, mfaChallenges, mfaRecoveryCodes, organizations, users, type User } from '../db/schema';
import { SecretBox } from '../common/secret-box';
import { hashToken, newRecoveryCode, newToken } from '../common/tokens';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from './password.service';
import { MfaService } from './mfa.service';
import { SessionService, type IssuedSession } from './session.service';
import type { Principal, RequestMeta } from './principal';

export const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 15 * 60_000;
const LOCKOUT_MAX_MS = 24 * 3_600_000;
const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;
const INVALID_CREDENTIALS = 'Invalid email or password, or the account is temporarily locked';

export type LoginResult =
  | { kind: 'session'; issued: IssuedSession; user: User }
  | { kind: 'mfa'; challengeToken: string };

const mfaContext = (userId: string) => `users.mfa_secret:${userId}`;

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly passwords: PasswordService,
    private readonly sessionsSvc: SessionService,
    private readonly mfa: MfaService,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
  ) {}

  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const [user] = await this.db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    const now = new Date();
    // Always run the hash, even for unknown or locked accounts, so timing does not reveal which case applied.
    const passwordOk = await this.passwords.verify(user?.passwordHash ?? null, password);

    const fail = async (reason: string) => {
      await this.audit.record({
        orgId: user?.orgId ?? null,
        actor: { type: user ? 'user' : 'anonymous', id: user?.id ?? null, label: email },
        customerId: user?.customerId ?? null,
        action: 'auth.login',
        target: user ? { type: 'user', id: user.id } : undefined,
        outcome: 'failure',
        meta,
        metadata: { reason },
      });
      return new UnauthorizedException({ error: 'invalid_credentials', message: INVALID_CREDENTIALS });
    };

    if (!user) throw await fail('unknown_email');
    if (user.lockedUntil && user.lockedUntil > now) throw await fail('locked');

    if (!passwordOk) {
      // Atomic increment so concurrent guesses cannot skip the lock.
      const [updated] = await this.db
        .update(users)
        .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
        .where(eq(users.id, user.id))
        .returning({ failed: users.failedLoginCount });
      const failed = updated?.failed ?? 0;
      if (failed >= LOCKOUT_THRESHOLD) {
        const ms = Math.min(LOCKOUT_BASE_MS * 2 ** (failed - LOCKOUT_THRESHOLD), LOCKOUT_MAX_MS);
        await this.db.update(users).set({ lockedUntil: new Date(now.getTime() + ms) }).where(eq(users.id, user.id));
        throw await fail(failed === LOCKOUT_THRESHOLD ? 'bad_password_lockout_started' : 'bad_password_locked');
      }
      throw await fail('bad_password');
    }

    if (user.status !== 'active') throw await fail('disabled');
    if (user.customerId) {
      const [c] = await this.db.select({ status: customers.status }).from(customers).where(eq(customers.id, user.customerId));
      if (!c || c.status === 'closed') throw await fail('customer_closed');
    }

    const patch: Partial<User> = { failedLoginCount: 0, lockedUntil: null };
    if (this.passwords.needsRehash(user.passwordHash)) patch.passwordHash = await this.passwords.hash(password);
    await this.db.update(users).set(patch).where(eq(users.id, user.id));

    if (user.mfaEnabledAt) {
      const challengeToken = newToken();
      await this.db.insert(mfaChallenges).values({
        userId: user.id,
        tokenHash: hashToken(challengeToken),
        expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await this.audit.record({
        orgId: user.orgId,
        actor: { type: 'user', id: user.id, label: user.email },
        customerId: user.customerId,
        action: 'auth.login.password_ok_mfa_pending',
        target: { type: 'user', id: user.id },
        outcome: 'success',
        meta,
      });
      return { kind: 'mfa', challengeToken };
    }

    return { kind: 'session', issued: await this.completeLogin(user, meta, 'password'), user };
  }

  async verifyMfaChallenge(challengeToken: string, code: string, meta: RequestMeta) {
    const now = new Date();
    // Count the attempt before checking the code so parallel guesses are bounded too.
    const [challenge] = await this.db
      .update(mfaChallenges)
      .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
      .where(
        and(
          eq(mfaChallenges.tokenHash, hashToken(challengeToken)),
          isNull(mfaChallenges.consumedAt),
          gt(mfaChallenges.expiresAt, now),
          lt(mfaChallenges.attempts, MFA_CHALLENGE_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (!challenge) {
      throw new UnauthorizedException({ error: 'mfa_challenge_invalid', message: 'Sign-in expired. Please start again.' });
    }
    const [user] = await this.db.select().from(users).where(eq(users.id, challenge.userId));
    if (!user || user.status !== 'active' || !user.mfaEnabledAt || !user.mfaSecretEnc) {
      throw new UnauthorizedException({ error: 'mfa_challenge_invalid', message: 'Sign-in expired. Please start again.' });
    }

    let method: 'totp' | 'recovery_code' | null = null;
    if (/^\d{6}$/.test(code)) {
      const secret = this.secrets.decrypt(user.mfaSecretEnc, mfaContext(user.id));
      const step = await this.mfa.verifyCode(secret, code, user.mfaLastTimeStep);
      if (step !== null) {
        // Conditional update closes the race where the same code is submitted twice concurrently.
        const updated = await this.db
          .update(users)
          .set({ mfaLastTimeStep: step })
          .where(and(eq(users.id, user.id), sql`coalesce(${users.mfaLastTimeStep}, -1) < ${step}`))
          .returning({ id: users.id });
        if (updated.length) method = 'totp';
      }
    } else {
      const used = await this.db
        .update(mfaRecoveryCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(mfaRecoveryCodes.userId, user.id),
            eq(mfaRecoveryCodes.codeHash, hashToken(code.toLowerCase())),
            isNull(mfaRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: mfaRecoveryCodes.id });
      if (used.length) method = 'recovery_code';
    }

    if (!method) {
      await this.audit.record({
        orgId: user.orgId,
        actor: { type: 'user', id: user.id, label: user.email },
        customerId: user.customerId,
        action: 'auth.mfa.verify',
        target: { type: 'user', id: user.id },
        outcome: 'failure',
        meta,
        metadata: { attempt: challenge.attempts },
      });
      throw new UnauthorizedException({ error: 'mfa_invalid_code', message: 'Invalid verification code' });
    }

    await this.db.update(mfaChallenges).set({ consumedAt: now }).where(eq(mfaChallenges.id, challenge.id));
    return { issued: await this.completeLogin(user, meta, method), user };
  }

  private async completeLogin(user: User, meta: RequestMeta, method: string): Promise<IssuedSession> {
    return this.db.transaction(async (tx) => {
      const issued = await this.sessionsSvc.create(user, meta, true, tx);
      await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await this.audit.record(
        {
          orgId: user.orgId,
          actor: { type: 'user', id: user.id, label: user.email },
          customerId: user.customerId,
          action: 'auth.login',
          target: { type: 'session', id: issued.session.id },
          outcome: 'success',
          meta,
          metadata: { method },
        },
        tx,
      );
      return issued;
    });
  }

  async logout(p: Principal, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.sessionsSvc.revoke(p.sessionId, 'logout', tx);
      await this.audit.record(
        { orgId: p.orgId, actor: { type: 'user', id: p.userId, label: p.email }, customerId: p.customerId, action: 'auth.logout', target: { type: 'session', id: p.sessionId }, outcome: 'success', meta },
        tx,
      );
    });
  }

  async changePassword(p: Principal, current: string, next: string, meta: RequestMeta): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, p.userId));
    if (!user || !(await this.passwords.verify(user.passwordHash, current))) {
      await this.audit.record({ orgId: p.orgId, actor: { type: 'user', id: p.userId, label: p.email }, customerId: p.customerId, action: 'auth.password.change', target: { type: 'user', id: p.userId }, outcome: 'failure', meta, metadata: { reason: 'bad_current_password' } });
      throw new BadRequestException({ error: 'invalid_password', message: 'Current password is incorrect' });
    }
    const weak = this.passwords.weakness(next, { email: user.email, name: user.name });
    if (weak) throw new BadRequestException({ error: 'weak_password', message: weak });
    if (await this.passwords.verify(user.passwordHash, next)) {
      throw new BadRequestException({ error: 'weak_password', message: 'New password must differ from the current one' });
    }
    const hashStr = await this.passwords.hash(next);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: hashStr, passwordChangedAt: new Date() }).where(eq(users.id, p.userId));
      // Sign out every other device; keep the session that made the change.
      const revoked = await this.sessionsSvc.revokeAllForUser(p.userId, 'password_changed', p.sessionId, tx);
      await this.audit.record(
        { orgId: p.orgId, actor: { type: 'user', id: p.userId, label: p.email }, customerId: p.customerId, action: 'auth.password.change', target: { type: 'user', id: p.userId }, outcome: 'success', meta, metadata: { otherSessionsRevoked: revoked } },
        tx,
      );
    });
  }

  // ---- MFA enrollment ------------------------------------------------------

  async beginMfaSetup(p: Principal) {
    const [user] = await this.db.select().from(users).where(eq(users.id, p.userId));
    if (!user) throw new UnauthorizedException();
    if (user.mfaEnabledAt) throw new ConflictException({ error: 'mfa_already_enabled', message: 'MFA is already enabled. Disable it first to re-enroll.' });
    const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, user.orgId));
    const secret = this.mfa.newSecret();
    await this.db
      .update(users)
      .set({ mfaSecretEnc: this.secrets.encrypt(secret, mfaContext(user.id)), mfaLastTimeStep: null })
      .where(eq(users.id, user.id));
    const { uri, qrDataUrl } = await this.mfa.provisioning(secret, user.email, org?.name ?? 'Crapplet DCIM');
    // The secret is shown once here so it can be typed manually; it is never retrievable afterwards.
    return { secret, otpauthUri: uri, qrDataUrl };
  }

  async enableMfa(p: Principal, code: string, meta: RequestMeta): Promise<{ recoveryCodes: string[] }> {
    const [user] = await this.db.select().from(users).where(eq(users.id, p.userId));
    if (!user?.mfaSecretEnc) throw new BadRequestException({ error: 'mfa_setup_missing', message: 'Start MFA setup first' });
    if (user.mfaEnabledAt) throw new ConflictException({ error: 'mfa_already_enabled', message: 'MFA is already enabled' });
    const secret = this.secrets.decrypt(user.mfaSecretEnc, mfaContext(user.id));
    const step = await this.mfa.verifyCode(secret, code, null);
    if (step === null) throw new BadRequestException({ error: 'mfa_invalid_code', message: 'Invalid verification code' });

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ mfaEnabledAt: new Date(), mfaLastTimeStep: step }).where(eq(users.id, user.id));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id));
      await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId: user.id, codeHash: hashToken(c) })));
      // Other sessions were established without MFA; end them.
      await this.sessionsSvc.revokeAllForUser(user.id, 'mfa_enabled', p.sessionId, tx);
      await this.audit.record(
        { orgId: p.orgId, actor: { type: 'user', id: p.userId, label: p.email }, customerId: p.customerId, action: 'auth.mfa.enable', target: { type: 'user', id: p.userId }, outcome: 'success', meta },
        tx,
      );
    });
    return { recoveryCodes: codes };
  }

  async disableMfa(p: Principal, password: string, meta: RequestMeta): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, p.userId));
    if (!user || !(await this.passwords.verify(user.passwordHash, password))) {
      throw new BadRequestException({ error: 'invalid_password', message: 'Password is incorrect' });
    }
    const [org] = await this.db.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, user.orgId));
    if (user.userType === 'staff' && org?.settings.requireMfaForStaff) {
      throw new BadRequestException({ error: 'mfa_required_by_policy', message: 'Your organization requires MFA for staff accounts' });
    }
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ mfaEnabledAt: null, mfaSecretEnc: null, mfaLastTimeStep: null }).where(eq(users.id, user.id));
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, user.id));
      await this.audit.record(
        { orgId: p.orgId, actor: { type: 'user', id: p.userId, label: p.email }, customerId: p.customerId, action: 'auth.mfa.disable', target: { type: 'user', id: p.userId }, outcome: 'success', meta },
        tx,
      );
    });
  }

  async profile(p: Principal) {
    const [row] = await this.db
      .select({ user: users, orgName: organizations.name, orgSettings: organizations.settings })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.orgId))
      .where(eq(users.id, p.userId));
    if (!row) throw new UnauthorizedException();
    const remaining = row.user.mfaEnabledAt
      ? (
          await this.db
            .select({ n: sql<number>`count(*)::int` })
            .from(mfaRecoveryCodes)
            .where(and(eq(mfaRecoveryCodes.userId, p.userId), isNull(mfaRecoveryCodes.usedAt)))
        )[0]?.n ?? 0
      : 0;
    return {
      user: {
        id: row.user.id,
        email: row.user.email,
        name: row.user.name,
        userType: row.user.userType,
        customerId: row.user.customerId,
        mfaEnabled: !!row.user.mfaEnabledAt,
        recoveryCodesRemaining: remaining,
        lastLoginAt: row.user.lastLoginAt,
      },
      organization: { id: p.orgId, name: row.orgName, currency: row.orgSettings.currency ?? 'INR', timezone: row.orgSettings.timezone ?? 'Asia/Kolkata' },
      permissions: [...p.permissions].sort(),
      mfaEnrollmentRequired: p.mfaEnrollmentRequired,
      sessionId: p.sessionId,
    };
  }
}
