import { eq, sql } from 'drizzle-orm';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, organizations, sessions, users } from '../src/db/schema';
import { LOCKOUT_THRESHOLD } from '../src/auth/auth.service';
import { Client, PASSWORD, csrfFrom, setupTestApp, userId, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => ctx?.close());

describe('login and sessions', () => {
  it('signs in, sets HttpOnly session + CSRF cookies, and returns the profile', async () => {
    const agent = request.agent(ctx.server);
    const res = await agent.post('/api/v1/auth/login').send({ email: ctx.emails.superAdmin.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mfaRequired: false });
    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('cdcim_session='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(cookies.find((c) => c.startsWith('cdcim_csrf='))).not.toMatch(/HttpOnly/i);

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(ctx.emails.superAdmin);
    expect(me.body.permissions).toContain('roles.write');
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|mfaSecret/);
  });

  it('stores only token hashes, never raw session tokens', async () => {
    const agent = request.agent(ctx.server);
    const res = await agent.post('/api/v1/auth/login').send({ email: ctx.emails.noc, password: PASSWORD });
    const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('cdcim_session='))!.split(';')[0]!.split('=')[1]!;
    const rows = await ctx.db.select({ h: sessions.tokenHash }).from(sessions);
    expect(rows.some((r) => r.h === raw)).toBe(false);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.h))).toBe(true);
  });

  it('rejects unauthenticated access with 401', async () => {
    const res = await request(ctx.server).get('/api/v1/customers');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthenticated');
    expect(res.body.requestId).toBeTruthy();
  });

  it('gives the same error for unknown email and wrong password (no account enumeration)', async () => {
    const a = await request(ctx.server).post('/api/v1/auth/login').send({ email: 'nobody@test.example', password: 'whatever-password' });
    const b = await request(ctx.server).post('/api/v1/auth/login').send({ email: ctx.emails.opsAdmin, password: 'wrong-password-here' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.message).toBe(b.body.message);
    await ctx.db.update(users).set({ failedLoginCount: 0 }).where(eq(users.email, ctx.emails.opsAdmin));
  });

  it('requires a valid CSRF token on state-changing requests', async () => {
    const c = await Client.login(ctx.server, ctx.emails.superAdmin);
    const body = { name: 'CSRF Co', code: 'CSRF' };
    expect((await c.agent.post('/api/v1/customers').send(body)).status).toBe(403);
    expect((await c.agent.post('/api/v1/customers').set('X-CSRF-Token', 'forged').send(body)).status).toBe(403);
    // Another session's CSRF token is not valid for this session.
    const other = await Client.login(ctx.server, ctx.emails.superAdmin);
    expect((await c.agent.post('/api/v1/customers').set('X-CSRF-Token', other.csrf).send(body)).status).toBe(403);
    expect((await c.post('/api/v1/customers', body)).status).toBe(201);
  });

  it('logout revokes the session server-side', async () => {
    const c = await Client.login(ctx.server, ctx.emails.noc);
    expect((await c.post('/api/v1/auth/logout')).status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('expires idle sessions', async () => {
    const c = await Client.login(ctx.server, ctx.emails.noc);
    const me = await c.get('/api/v1/auth/me');
    await ctx.db.update(sessions).set({ lastSeenAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(sessions.id, me.body.sessionId));
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
    const [s] = await ctx.db.select().from(sessions).where(eq(sessions.id, me.body.sessionId));
    expect(s!.revokedReason).toBe('idle_timeout');
  });

  it('lets users list and revoke their own sessions but not others', async () => {
    const a = await Client.login(ctx.server, ctx.emails.opsAdmin);
    const b = await Client.login(ctx.server, ctx.emails.opsAdmin);
    const list = await a.get('/api/v1/auth/sessions');
    const bId = (await b.get('/api/v1/auth/me')).body.sessionId;
    expect(list.body.some((s: { id: string }) => s.id === bId)).toBe(true);
    expect((await a.delete(`/api/v1/auth/sessions/${bId}`)).status).toBe(200);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);

    const noc = await Client.login(ctx.server, ctx.emails.noc);
    const nocSession = (await noc.get('/api/v1/auth/me')).body.sessionId;
    expect((await a.delete(`/api/v1/auth/sessions/${nocSession}`)).status).toBe(404);
  });
});

describe('account lockout', () => {
  it(`locks after ${LOCKOUT_THRESHOLD} failures and rejects even the right password while locked`, async () => {
    const email = ctx.emails.globexAdmin;
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      expect((await request(ctx.server).post('/api/v1/auth/login').send({ email, password: 'bad-password-guess' })).status).toBe(401);
    }
    const [u] = await ctx.db.select().from(users).where(eq(users.email, email));
    expect(u!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(401);

    const failures = await ctx.db.select().from(auditEvents).where(sql`${auditEvents.action} = 'auth.login' and ${auditEvents.outcome} = 'failure' and ${auditEvents.actorId} = ${u!.id}`);
    expect(failures.length).toBeGreaterThanOrEqual(LOCKOUT_THRESHOLD + 1);
    expect(failures.some((f) => (f.metadata as { reason?: string }).reason === 'locked')).toBe(true);

    await ctx.db.update(users).set({ lockedUntil: null, failedLoginCount: 0 }).where(eq(users.id, u!.id));
    expect((await request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(200);
  });

  it('refuses disabled accounts', async () => {
    const email = 'temp-disabled@test.example';
    const admin = await Client.login(ctx.server, ctx.emails.superAdmin);
    const roles = (await admin.get('/api/v1/roles')).body as { id: string; systemKey: string }[];
    const created = await admin.post('/api/v1/users', { email, name: 'Temp', password: PASSWORD, userType: 'staff', roleIds: [roles.find((r) => r.systemKey === 'auditor')!.id] });
    expect(created.status).toBe(201);
    const c = await Client.login(ctx.server, email);
    expect((await admin.patch(`/api/v1/users/${created.body.id}`, { status: 'disabled' })).status).toBe(200);
    expect((await c.get('/api/v1/auth/me')).status).toBe(401); // existing session ended
    expect((await request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
  });
});

describe('password change', () => {
  it('requires the current password, enforces policy, and signs out other sessions', async () => {
    const email = ctx.emails.opsAdmin;
    const a = await Client.login(ctx.server, email);
    const b = await Client.login(ctx.server, email);
    expect((await a.post('/api/v1/auth/password', { currentPassword: 'nope', newPassword: 'another-long-passphrase' })).status).toBe(400);
    expect((await a.post('/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    const next = 'brand-new-passphrase-2026';
    expect((await a.post('/api/v1/auth/password', { currentPassword: PASSWORD, newPassword: next })).status).toBe(200);
    expect((await a.get('/api/v1/auth/me')).status).toBe(200);
    expect((await b.get('/api/v1/auth/me')).status).toBe(401);
    // restore for other tests
    expect((await a.post('/api/v1/auth/password', { currentPassword: next, newPassword: PASSWORD })).status).toBe(200);
  });
});

describe('multi-factor authentication', () => {
  let secret: string;
  let recoveryCodes: string[];
  const email = () => ctx.emails.acmeAdmin;

  it('enrolls with a verified TOTP code and stores the secret encrypted', async () => {
    const c = await Client.login(ctx.server, email());
    const setup = await c.post('/api/v1/auth/mfa/setup');
    expect(setup.status).toBe(200);
    secret = setup.body.secret;
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect((await c.post('/api/v1/auth/mfa/enable', { code: '000000' })).status).toBe(400);

    const other = await Client.login(ctx.server, email());
    const enabled = await c.post('/api/v1/auth/mfa/enable', { code: await generate({ secret }) });
    expect(enabled.status).toBe(200);
    recoveryCodes = enabled.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    // Sessions established without MFA are ended; the enrolling one stays.
    expect((await other.get('/api/v1/auth/me')).status).toBe(401);
    expect((await c.get('/api/v1/auth/me')).body.user.mfaEnabled).toBe(true);

    const [u] = await ctx.db.select().from(users).where(eq(users.email, email()));
    expect(u!.mfaSecretEnc).toMatch(/^v1\./);
    expect(u!.mfaSecretEnc).not.toContain(secret);
  });

  it('requires the second factor at login and issues no session before it', async () => {
    const agent = request.agent(ctx.server);
    const res = await agent.post('/api/v1/auth/login').send({ email: email(), password: PASSWORD });
    expect(res.body.mfaRequired).toBe(true);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);

    expect((await agent.post('/api/v1/auth/mfa/verify').send({ challengeToken: res.body.challengeToken, code: '123456' })).status).toBe(401);
    // Codes already used (enrollment step) are rejected as replays.
    const replay = await agent.post('/api/v1/auth/mfa/verify').send({ challengeToken: res.body.challengeToken, code: await generate({ secret }) });
    expect(replay.status).toBe(401);
  });

  it('accepts a recovery code exactly once', async () => {
    const code = recoveryCodes[0]!;
    const login = async () => (await request(ctx.server).post('/api/v1/auth/login').send({ email: email(), password: PASSWORD })).body.challengeToken as string;
    const agent = request.agent(ctx.server);
    const ok = await agent.post('/api/v1/auth/mfa/verify').send({ challengeToken: await login(), code });
    expect(ok.status).toBe(200);
    const c = Client.fromAgent(agent, ok.headers['set-cookie']);
    expect((await c.get('/api/v1/auth/me')).body.user.recoveryCodesRemaining).toBe(9);
    expect((await request(ctx.server).post('/api/v1/auth/mfa/verify').send({ challengeToken: await login(), code })).status).toBe(401);
  });

  it('limits guesses per challenge', async () => {
    const token = (await request(ctx.server).post('/api/v1/auth/login').send({ email: email(), password: PASSWORD })).body.challengeToken;
    for (let i = 0; i < 5; i++) await request(ctx.server).post('/api/v1/auth/mfa/verify').send({ challengeToken: token, code: '111111' });
    const res = await request(ctx.server).post('/api/v1/auth/mfa/verify').send({ challengeToken: token, code: recoveryCodes[1]! });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('mfa_challenge_invalid');
  });

  it('forces staff to enroll when the organization requires MFA', async () => {
    await ctx.db.update(organizations).set({ settings: { ...ctx.org.settings, requireMfaForStaff: true } }).where(eq(organizations.id, ctx.org.id));
    try {
      const c = await Client.login(ctx.server, ctx.emails.noc);
      const me = await c.get('/api/v1/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.mfaEnrollmentRequired).toBe(true);
      const blocked = await c.get('/api/v1/customers');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe('mfa_enrollment_required');
      expect((await c.post('/api/v1/auth/mfa/setup')).status).toBe(200);
    } finally {
      await ctx.db.update(organizations).set({ settings: { ...ctx.org.settings, requireMfaForStaff: false } }).where(eq(organizations.id, ctx.org.id));
    }
  });

  it('admin MFA reset clears enrollment and signs the user out', async () => {
    const admin = await Client.login(ctx.server, ctx.emails.superAdmin);
    const id = await userId(ctx.db, email());
    expect((await admin.post(`/api/v1/users/${id}/reset-mfa`)).status).toBe(200);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, id));
    expect(u!.mfaEnabledAt).toBeNull();
    expect(u!.mfaSecretEnc).toBeNull();
    const res = await request(ctx.server).post('/api/v1/auth/login').send({ email: email(), password: PASSWORD });
    expect(res.body.mfaRequired).toBe(false);
    expect(csrfFrom(res.headers['set-cookie'])).toBeTruthy();
  });
});
