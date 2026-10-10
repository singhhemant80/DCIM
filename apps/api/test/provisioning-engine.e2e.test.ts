/**
 * Phase 6: the provisioning job state machine against PostgreSQL, with
 * stand-in job kinds so every path (wait, retry, permanent failure, crash
 * mid-step, recovery decisions, cancellation, deadline) is exercised.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { provisioningEvents, provisioningJobs, provisioningSteps } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { claimJobs, PermanentError, runDueJobs, runJob, type EngineDeps, type KindDef } from '../src/worker/provisioning/engine';
import { setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
const calls: string[] = [];
let behaviour: Record<string, () => Promise<unknown>> = {};
const clock = { t: Date.now() };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

const step = (name: string, safeToRepeat: boolean, maxAttempts = 3) => ({
  name,
  safeToRepeat,
  maxAttempts,
  run: async () => {
    calls.push(name);
    const b = behaviour[name];
    const r = b ? await b() : undefined;
    return (r as { done: true } | { wait: number }) ?? { done: true as const };
  },
});
const kinds: Record<string, KindDef> = {
  image_verify: {
    steps: () => [step('check', true), step('act', false), step('verify', true)],
    cleanup: async () => void calls.push('cleanup'),
    onCompleted: async () => ({ ok: true }),
  },
};
const deps = (): EngineDeps => ({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, kinds, now: () => new Date(clock.t), retryBaseMs: 1000 });
async function newJob(extra: Partial<typeof provisioningJobs.$inferInsert> = {}) {
  const [j] = await ctx.db.insert(provisioningJobs).values({ orgId: ctx.org.id, kind: 'image_verify', nextRunAt: new Date(clock.t), ...extra }).returning();
  return j!;
}
const get = async (id: string) => (await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.id, id)))[0]!;
const steps = async (id: string) => (await ctx.db.select().from(provisioningSteps).where(eq(provisioningSteps.jobId, id))).sort((a, b) => a.seq - b.seq);
const tick = (ms: number) => (clock.t += ms);

beforeAll(async () => {
  ctx = await setupTestApp();
});
afterAll(async () => {
  await ctx?.close();
});
beforeEach(async () => {
  calls.length = 0;
  behaviour = {};
  await ctx.db.delete(provisioningJobs);
});

describe('provisioning job engine', () => {
  it('runs every step in order and completes only after the last (verification) step', async () => {
    const j = await newJob();
    await runDueJobs(deps());
    expect(calls).toEqual(['check', 'act', 'verify']);
    const done = await get(j.id);
    expect(done).toMatchObject({ status: 'completed', currentStep: 3, result: { ok: true } });
    expect((await steps(j.id)).map((s) => [s.name, s.status, s.attempts])).toEqual([
      ['check', 'done', 1],
      ['act', 'done', 1],
      ['verify', 'done', 1],
    ]);
  });

  it('a waiting step releases the job and is polled again later without counting attempts', async () => {
    let polls = 0;
    behaviour.verify = async () => (++polls < 3 ? { wait: 5000, status: 'verifying' } : { done: true });
    const j = await newJob();
    await runDueJobs(deps());
    expect(await get(j.id)).toMatchObject({ status: 'verifying', leaseUntil: null });
    expect(await runDueJobs(deps())).toBe(0); // not due yet
    tick(5000);
    await runDueJobs(deps());
    tick(5000);
    await runDueJobs(deps());
    expect((await get(j.id)).status).toBe('completed');
    expect(calls.filter((c) => c === 'act')).toHaveLength(1); // earlier steps never re-run
    expect((await steps(j.id))[2]!.attempts).toBe(1);
  });

  it('retries a failing safe step with backoff, then fails and cleans up', async () => {
    behaviour.check = async () => {
      throw new Error('BMC timed out');
    };
    const j = await newJob();
    await runDueJobs(deps());
    let s = await get(j.id);
    expect(s.status).toBe('waiting');
    expect(s.nextRunAt.getTime()).toBe(clock.t + 1000);
    tick(1000);
    await runDueJobs(deps());
    expect((await get(j.id)).nextRunAt.getTime()).toBe(clock.t + 2000); // doubled
    tick(2000);
    await runDueJobs(deps());
    s = await get(j.id);
    expect(s.status).toBe('failed');
    expect(s.error).toBe('check: BMC timed out');
    expect(calls.filter((c) => c === 'check')).toHaveLength(3);
    expect(calls).toContain('cleanup');
    expect(calls).not.toContain('act');
  });

  it('a permanent error fails at once', async () => {
    behaviour.check = async () => {
      throw new PermanentError('Image not verified');
    };
    const j = await newJob();
    await runDueJobs(deps());
    expect(await get(j.id)).toMatchObject({ status: 'failed', error: 'check: Image not verified' });
  });

  it('a failing step that is not safe to repeat waits for a decision instead of being retried', async () => {
    behaviour.act = async () => {
      throw new Error('Connection reset during reset request');
    };
    const j = await newJob();
    await runDueJobs(deps());
    const s = await get(j.id);
    expect(s.status).toBe('recovery');
    expect(s.error).toMatch(/may have partly happened/);
    tick(60_000);
    expect(await runDueJobs(deps())).toBe(0); // recovery jobs are never picked up automatically
    expect(calls.filter((c) => c === 'act')).toHaveLength(1);
  });

  it('resumes a job interrupted in a safe step, and stops one interrupted in an unsafe step', async () => {
    // Simulate a worker that died while running step 0 (safe) and step 1 (unsafe).
    const a = await newJob({ status: 'running', currentStep: 0, leaseUntil: new Date(clock.t - 1000), workerId: 'dead' });
    const b = await newJob({ status: 'running', currentStep: 1, leaseUntil: new Date(clock.t - 1000), workerId: 'dead' });
    // A live lease is left alone.
    const c = await newJob({ status: 'running', currentStep: 1, leaseUntil: new Date(clock.t + 60_000), workerId: 'alive' });
    await runDueJobs(deps());
    expect((await get(a.id)).status).toBe('completed');
    const rb = await get(b.id);
    expect(rb.status).toBe('recovery');
    expect(rb.error).toMatch(/Interrupted during “act”/);
    expect((await get(c.id)).status).toBe('running');
    const ev = await ctx.db.select().from(provisioningEvents).where(eq(provisioningEvents.jobId, a.id));
    expect(ev.some((e) => /Resumed “check” after an interruption/.test(e.message))).toBe(true);
  });

  it('two workers never run the same job', async () => {
    const j = await newJob();
    const [x, y] = await Promise.all([claimJobs(deps(), 5, 'w1'), claimJobs(deps(), 5, 'w2')]);
    expect(x.length + y.length).toBe(1);
    // The loser can't write to it either: updates are fenced by the worker id.
    const winner = x.length ? 'w1' : 'w2';
    const loser = winner === 'w1' ? 'w2' : 'w1';
    await runJob(deps(), { job: (await get(j.id)) as never, previous: 'queued' }, loser);
    expect((await get(j.id)).currentStep).toBe(0);
    expect(calls).toEqual([]);
  });

  it('cancellation stops between steps and runs the cleanup', async () => {
    behaviour.verify = async () => ({ wait: 5000 });
    const j = await newJob();
    await runDueJobs(deps());
    await ctx.db.update(provisioningJobs).set({ cancelRequested: true, nextRunAt: new Date(clock.t) }).where(eq(provisioningJobs.id, j.id));
    await runDueJobs(deps());
    expect((await get(j.id)).status).toBe('cancelled');
    expect(calls.at(-1)).toBe('cleanup');
  });

  it('fails a job that passes its deadline while waiting', async () => {
    behaviour.verify = async () => ({ wait: 60_000 });
    const j = await newJob({ deadlineAt: new Date(clock.t + 90_000), state: { deadlineMessage: 'The installer did not report back in time' } });
    await runDueJobs(deps());
    tick(60_000);
    await runDueJobs(deps());
    tick(60_000);
    await runDueJobs(deps());
    expect(await get(j.id)).toMatchObject({ status: 'failed', error: 'The installer did not report back in time' });
    expect(calls).toContain('cleanup');
  });

  it('keeps only one active job per device', async () => {
    const [d] = (
      await ctx.db.execute<{ id: string }>(sql`
        with m as (insert into manufacturers (org_id, name) values (${ctx.org.id}, 'X') returning id),
             dm as (insert into device_models (org_id, manufacturer_id, name, category, u_height, full_depth) select ${ctx.org.id}, m.id, 'M', 'server', 1, true from m returning id)
        insert into devices (org_id, model_id, category, u_height, full_depth, asset_tag) select ${ctx.org.id}, dm.id, 'server', 1, true, 'J1' from dm returning id`)
    ).rows;
    await newJob({ deviceId: d!.id });
    await expect(newJob({ deviceId: d!.id })).rejects.toThrow();
  });
});
