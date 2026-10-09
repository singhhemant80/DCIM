/**
 * Regression tests for defects found in the Phase 1 independent security review.
 * Each test reproduces the original attack and asserts it now fails.
 */
import { and, eq, sql } from 'drizzle-orm';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditEvents, users } from '../src/db/schema';
import { LOCKOUT_THRESHOLD } from '../src/auth/auth.service';
import { Client, PASSWORD, setupTestApp, userId, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let roleIds: Record<string, string>;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  const roles = (await admin.get('/api/v1/roles')).body as { id: string; systemKey: string | null }[];
  roleIds = Object.fromEntries(roles.filter((r) => r.systemKey).map((r) => [r.systemKey!, r.id]));
});
afterAll(async () => ctx?.close());

const unlock = (email: string) => ctx.db.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.email, email));

async function makeUser(email: string, role: string) {
  const res = await admin.post('/api/v1/users', { email, name: email.split('@')[0], password: PASSWORD, userType: 'staff', roleIds: [roleIds[role]] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('lockout under concurrency', () => {
  it('a burst of parallel guesses cannot exceed the threshold, and a correct password inside the burst is refused once locked', async () => {
    const email = ctx.emails.noc;
    const wrong = Array.from({ length: 30 }, () => request(ctx.server).post('/api/v1/auth/login').send({ email, password: 'definitely-wrong-guess' }));
    const right = request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const results = await Promise.all([...wrong, right]);
    const [u] = await ctx.db.select().from(users).where(eq(users.email, email));
    // Every wrong guess evaluated before the lock increments the counter by one; guesses after the lock are rejected without counting.
    expect(u!.failedLoginCount).toBeLessThanOrEqual(LOCKOUT_THRESHOLD);
    expect(u!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    // The correct password either landed before the lock (then the counter would have been reset) or was refused.
    const rightRes = results[results.length - 1]!;
    if (rightRes.status === 200) expect(u!.failedLoginCount).toBeLessThan(LOCKOUT_THRESHOLD);
    else expect(rightRes.status).toBe(401);
    // While locked, the right password never works.
    expect((await request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
    await unlock(email);
  });
});

describe('MFA guessing across fresh challenges', () => {
  let secret = '';
  it('failed codes count toward account lockout, so new challenges do not reset the budget', async () => {
    const email = ctx.emails.acmeAdmin;
    const c = await Client.login(ctx.server, email);
    secret = (await c.post('/api/v1/auth/mfa/setup')).body.secret;
    expect((await c.post('/api/v1/auth/mfa/enable', { code: await generate({ secret }) })).status).toBe(200);

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      const login = await request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD });
      expect(login.body.mfaRequired).toBe(true);
      expect((await request(ctx.server).post('/api/v1/auth/mfa/verify').send({ challengeToken: login.body.challengeToken, code: '000000' })).status).toBe(401);
    }
    const [u] = await ctx.db.select().from(users).where(eq(users.email, email));
    expect(u!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect((await request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
    await unlock(email);
  });

  it('the password step alone does not clear the counter; a successful second factor does', async () => {
    const email = ctx.emails.acmeAdmin;
    await ctx.db.update(users).set({ failedLoginCount: 3 }).where(eq(users.email, email));
    const login = await request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(login.body.mfaRequired).toBe(true);
    const [u1] = await ctx.db.select().from(users).where(eq(users.email, email));
    expect(u1!.failedLoginCount).toBe(3);
    // The enrollment code consumed the current 30 s step; wait for the next one so the code is not a replay.
    const nextStep = (u1!.mfaLastTimeStep! + 1) * 30_000;
    if (Date.now() < nextStep) await new Promise((r) => setTimeout(r, nextStep - Date.now() + 250));
    const ok = await request(ctx.server).post('/api/v1/auth/mfa/verify').send({ challengeToken: login.body.challengeToken, code: await generate({ secret }) });
    expect(ok.status).toBe(200);
    const [u2] = await ctx.db.select().from(users).where(eq(users.email, email));
    expect(u2!.failedLoginCount).toBe(0);
  }, 45_000);
});

describe('super administrator coverage', () => {
  it('two super admins disabling each other concurrently cannot leave zero', async () => {
    const s2Id = await makeUser('root-b@test.example', 'super_admin');
    const s1Id = await userId(ctx.db, ctx.emails.superAdmin);
    const s2 = await Client.login(ctx.server, 'root-b@test.example');
    // Make the original admin the only other super admin path: disable each other at once.
    const [a, b] = await Promise.all([admin.patch(`/api/v1/users/${s2Id}`, { status: 'disabled' }), s2.patch(`/api/v1/users/${s1Id}`, { status: 'disabled' })]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).not.toEqual([200, 200]);
    const n = ((
      await ctx.db.execute(sql`select count(distinct u.id)::int as n from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id where u.status = 'active' and r.system_key = 'super_admin'`)
    ).rows as { n: number }[])[0]!.n;
    expect(n).toBeGreaterThanOrEqual(1);
    // Restore whichever admin was disabled.
    await ctx.db.update(users).set({ status: 'active' }).where(eq(users.id, s1Id));
    admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  });

  it('an operations admin cannot re-enable or rename a more privileged user', async () => {
    const targetId = await makeUser('departed-root@test.example', 'super_admin');
    expect((await admin.patch(`/api/v1/users/${targetId}`, { status: 'disabled' })).status).toBe(200);
    const ops = await Client.login(ctx.server, ctx.emails.opsAdmin);
    expect((await ops.patch(`/api/v1/users/${targetId}`, { status: 'active' })).status).toBe(403);
    expect((await ops.patch(`/api/v1/users/${targetId}`, { name: 'Renamed' })).status).toBe(403);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, targetId));
    expect(u!.status).toBe('disabled');
  });
});

describe('re-authentication inside a session', () => {
  it('wrong passwords on MFA disable / password change are audited, count toward lockout, and end all sessions at the threshold', async () => {
    const email = 'reauth@test.example';
    const id = await makeUser(email, 'auditor');
    const c = await Client.login(ctx.server, email);
    for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
      expect((await c.post('/api/v1/auth/mfa/disable', { password: 'guess-guess-guess' })).status).toBe(400);
    }
    expect((await c.post('/api/v1/auth/password', { currentPassword: 'guess-guess-guess', newPassword: 'another-long-passphrase' })).status).toBe(400);
    const failures = await ctx.db.select().from(auditEvents).where(and(eq(auditEvents.actorId, id), eq(auditEvents.outcome, 'failure')));
    expect(failures.length).toBe(LOCKOUT_THRESHOLD);
    expect((await c.get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(ctx.server).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(401);
  });
});

describe('information exposure', () => {
  it('readiness never returns raw dependency errors', async () => {
    const res = await request(ctx.server).get('/api/v1/health/ready');
    for (const check of Object.values(res.body.checks ?? res.body) as { error?: string }[]) {
      if (check && typeof check === 'object' && 'error' in check) expect(check.error).toBe('unavailable');
    }
  });

  it('revoking your own session is audited in the same transaction', async () => {
    const a = await Client.login(ctx.server, ctx.emails.opsAdmin);
    const b = await Client.login(ctx.server, ctx.emails.opsAdmin);
    const bId = (await b.get('/api/v1/auth/me')).body.sessionId;
    expect((await a.delete(`/api/v1/auth/sessions/${bId}`)).status).toBe(200);
    const rows = await ctx.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'auth.session.revoke'), eq(auditEvents.targetId, bId)));
    expect(rows).toHaveLength(1);
  });
});
