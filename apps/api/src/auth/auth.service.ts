import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { DB, type Db, type DbOrTx } from '../db/db';
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

    // Decide the outcome under a row lock so concurrent guesses are serialized:
    // each one re-reads the lock state, so a burst cannot exceed the threshold
    // and a correct password arriving after the lock engaged is still refused.
    const outcome = await this.db.transaction(async (tx): Promise<{ reason: string } | { user: User }> => {
      const [u] = await tx.select().from(users).where(eq(users.id, user.id)).for('update');
      if (!u) return { reason: 'unknown_email' } as const;
      if (u.lockedUntil && u.lockedUntil > now) return { reason: 'locked' } as const;
      if (!passwordOk) return { reason: (await this.registerFailure(tx, u.id, now)).reason };
      if (u.status !== 'active') return { reason: 'disabled' } as const;
      const patch: Partial<User> = {};
      // With MFA the failure counter is only cleared once the second factor succeeds,
      // so alternating "right password, wrong code" still counts toward lockout.
      if (!u.mfaEnabledAt) Object.assign(patch, { failedLoginCount: 0, lockedUntil: null });
      if (this.passwords.needsRehash(u.passwordHash)) patch.passwordHash = await this.passwords.hash(password);
      if (Object.keys(patch).length) await tx.update(users).set(patch).where(eq(users.id, u.id));
      return { user: u };
    });
    if (!('user' in outcome)) throw await fail(outcome.reason);
    const current = outcome.user;

    if (current.customerId) {
      const [c] = await this.db.select({ status: customers.status }).from(customers).where(eq(customers.id, current.customerId));
      if (!c || c.status === 'closed') throw await fail('customer_closed');
    }

    if (current.mfaEnabledAt) {
      const challengeToken = newToken();
      await this.db.insert(mfaChallenges).values({
        userId: current.id,
        tokenHash: hashToken(challengeToken),
        expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      await this.audit.record({
        orgId: current.orgId,
        actor: { type: 'user', id: current.id, label: current.email },
        customerId: current.customerId,
        action: 'auth.login.password_ok_mfa_pending',
        target: { type: 'user', id: current.id },
        outcome: 'success',
        meta,
      });
      return { kind: 'mfa', challengeToken };
    }

    return { kind: 'session', issued: await this.completeLogin(current, meta, 'password'), user: current };
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
    if (!user || user.status !== 'active' || !user.mfaEnabledAt || !user.mfaSecretEnc || (user.lockedUntil && user.lockedUntil > now)) {
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
      // Failed codes count toward the same per-account lockout as bad passwords,
      // so fresh challenges cannot be used to keep guessing.
      const { reason } = await this.db.transaction((tx) => this.registerFailure(tx, user.id, now));
      await this.audit.record({
        orgId: user.orgId,
        actor: { type: 'user', id: user.id, label: user.email },
        customerId: user.customerId,
        action: 'auth.mfa.verify',
        target: { type: 'user', id: user.id },
        outcome: 'failure',
        meta,
        metadata: { attempt: challenge.attempts, reason },
      });
      throw new UnauthorizedException({ error: 'mfa_invalid_code', message: 'Invalid verification code' });
    }

    await this.db.update(mfaChallenges).set({ consumedAt: now }).where(eq(mfaChallenges.id, challenge.id));
    return { issued: await this.completeLogin(user, meta, method), user };
  }

  private async completeLogin(user: User, meta: RequestMeta, method: string): Promise<IssuedSession> {
    return this.db.transaction(async (tx) => {
      const issued = await this.sessionsSvc.create(user, meta, true, tx);
      await tx.update(users).set({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
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

  /**
   * Counts one failed authentication attempt (bad password, bad MFA code, or a
   * failed re-authentication inside a session) and engages an exponential lock
   * once the threshold is reached. Must run in a transaction.
   */
  private async registerFailure(tx: DbOrTx, userId: string, now: Date): Promise<{ reason: string; locked: boolean }> {
    const [updated] = await tx
      .update(users)
      .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
      .where(eq(users.id, userId))
      .returning({ failed: users.failedLoginCount });
    const failed = updated?.failed ?? 0;
    if (failed < LOCKOUT_THRESHOLD) return { reason: 'bad_credentials', locked: false };
    const ms = Math.min(LOCKOUT_BASE_MS * 2 ** (failed - LOCKOUT_THRESHOLD), LOCKOUT_MAX_MS);
    await tx.update(users).set({ lockedUntil: new Date(now.getTime() + ms) }).where(eq(users.id, userId));
    return { reason: failed === LOCKOUT_THRESHOLD ? 'lockout_started' : 'locked_extended', locked: true };
  }

  /**
   * Re-checks the password of an already signed-in user before a sensitive
   * change. Failures are audited and count toward lockout; reaching the lock
   * also ends every session, so a stolen session cookie cannot be used to
   * guess the password indefinitely.
   */
  private async reauthenticate(p: Principal, password: string, action: string, meta: RequestMeta): Promise<User> {
    const [user] = await this.db.select().from(users).where(eq(users.id, p.userId));
    const now = new Date();
    const ok = await this.passwords.verify(user?.passwordHash ?? null, password);
    if (user && ok && !(user.lockedUntil && user.lockedUntil > now)) {
      if (user.failedLoginCount) await this.db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));
      return user;
    }
    await this.db.transaction(async (tx) => {
      const { reason, locked } = user ? await this.registerFailure(tx, user.id, now) : { reason: 'missing_user', locked: false };
      if (locked) await this.sessionsSvc.revokeAllForUser(p.userId, 'reauth_lockout', undefined, tx);
      await this.audit.record(
        { orgId: p.orgId, actor: { type: 'user', id: p.userId, label: p.email }, customerId: p.customerId, action, target: { type: 'user', id: p.userId }, outcome: 'failure', meta, metadata: { reason: `bad_current_password:${reason}`, sessionsRevoked: locked } },
        tx,
      );
    });
    throw new BadRequestException({ error: 'invalid_password', message: 'Password is incorrect' });
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
    const user = await this.reauthenticate(p, current, 'auth.password.change', meta);
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
    const user = await this.reauthenticate(p, password, 'auth.mfa.disable', meta);
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
