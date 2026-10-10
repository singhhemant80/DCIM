import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { provisioningEvents, provisioningJobs, provisioningSteps, type ProvisioningJob } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';

/**
 * Provisioning job runner (worker side).
 *
 * A job is a list of named steps. The runner claims due jobs with a lease
 * (FOR UPDATE SKIP LOCKED), runs steps in order and records each one, so the
 * job's position survives restarts:
 *
 *  - A step returns `done`, or `wait` (poll again later: waiting for the
 *    installer, for a power state…). Waiting releases the lease.
 *  - A step that throws is retried with backoff when it is marked safe to
 *    repeat; a step that is not (it changed something, e.g. a power cycle)
 *    moves the job to `recovery` for an operator decision instead of being
 *    repeated blindly. `PermanentError` fails the job at once.
 *  - A job found `running` with an expired lease was interrupted (worker
 *    crash). It resumes if its current step is safe to repeat, otherwise it
 *    goes to `recovery`.
 *  - Cancellation is honoured between steps; the kind's cleanup runs on
 *    cancel and failure (eject media, clear boot overrides…).
 *  - `completed` is only reached by finishing every step, and the last steps
 *    of each kind verify the outcome.
 */

export class PermanentError extends Error {}

export type StepResult = { done: true; detail?: string } | { wait: number; status?: 'waiting' | 'verifying'; detail?: string };

export interface StepContext {
  job: ProvisioningJob;
  /** Mutable working state; persisted after every step. */
  state: Record<string, unknown>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => Promise<void>;
  /** Extend the lease during long steps. */
  heartbeat: () => Promise<void>;
  /** Persist `state` now (before an action that other parts of the system react to). */
  checkpoint: () => Promise<void>;
  now: () => Date;
  deps: EngineDeps;
}

export interface StepDef {
  name: string;
  /** Running it again cannot do harm (it checks before acting, or only reads). */
  safeToRepeat: boolean;
  maxAttempts?: number;
  run: (ctx: StepContext) => Promise<StepResult>;
}

export interface KindDef {
  steps: (job: ProvisioningJob) => StepDef[];
  /** Best effort, on failure and cancellation. */
  cleanup?: (ctx: StepContext) => Promise<void>;
  /** After the last step succeeded (e.g. record the result in inventory). */
  onCompleted?: (ctx: StepContext) => Promise<Record<string, unknown> | void>;
}

export interface EngineDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  kinds: Record<string, KindDef>;
  now?: () => Date;
  /** Lease length; a heartbeat extends it. */
  leaseMs?: number;
  /** Base for retry backoff (doubles per attempt). */
  retryBaseMs?: number;
  /** Anything else the step implementations need (adapters, public URL…). */
  [k: string]: unknown;
}

const LEASE_MS = 120_000;

export async function addEvent(db: Db, jobId: string, message: string, level: 'info' | 'warn' | 'error' = 'info') {
  await db.insert(provisioningEvents).values({ jobId, message: message.slice(0, 2000), level });
}

/** Claims up to `limit` due jobs. Returns each job with the status it had before (to detect interruptions). */
export async function claimJobs(deps: EngineDeps, limit: number, workerId: string): Promise<{ job: ProvisioningJob; previous: string }[]> {
  const now = (deps.now?.() ?? new Date()).toISOString();
  const lease = new Date((deps.now?.() ?? new Date()).getTime() + (deps.leaseMs ?? LEASE_MS)).toISOString();
  const r = await deps.db.execute<{ id: string; previous: string }>(sql`
    with c as (
      select id, status::text as previous from provisioning_jobs
       where status in ('queued', 'running', 'waiting', 'verifying')
         and next_run_at <= ${now}::timestamptz
         and (lease_until is null or lease_until < ${now}::timestamptz)
       order by next_run_at
       limit ${limit}
       for update skip locked)
    update provisioning_jobs j
       set status = case when j.status = 'queued' then 'running'::job_status else j.status end,
           lease_until = ${lease}::timestamptz, worker_id = ${workerId},
           started_at = coalesce(j.started_at, ${now}::timestamptz)
      from c where j.id = c.id
    returning j.id, c.previous`);
  const out: { job: ProvisioningJob; previous: string }[] = [];
  for (const row of r.rows) {
    const [job] = await deps.db.select().from(provisioningJobs).where(eq(provisioningJobs.id, row.id));
    if (job) out.push({ job, previous: row.previous });
  }
  return out;
}

async function ensureSteps(db: Db, job: ProvisioningJob, steps: StepDef[]) {
  const existing = await db.select({ seq: provisioningSteps.seq }).from(provisioningSteps).where(eq(provisioningSteps.jobId, job.id));
  if (existing.length) return;
  await db
    .insert(provisioningSteps)
    .values(steps.map((s, i) => ({ jobId: job.id, seq: i, name: s.name })))
    .onConflictDoNothing();
}

/** Runs one claimed job as far as it can go now. Never throws. */
export async function runJob(deps: EngineDeps, claimed: { job: ProvisioningJob; previous: string }, workerId: string): Promise<void> {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  let job = claimed.job;
  const kind = deps.kinds[job.kind];
  const state: Record<string, unknown> = { ...(job.state ?? {}) };
  const ctx: StepContext = {
    job,
    state,
    deps,
    now,
    log: (m, level = 'info') => addEvent(db, job.id, m, level),
    heartbeat: async () => {
      await db
        .update(provisioningJobs)
        .set({ leaseUntil: new Date(now().getTime() + (deps.leaseMs ?? LEASE_MS)) })
        .where(and(eq(provisioningJobs.id, job.id), eq(provisioningJobs.workerId, workerId)));
    },
    checkpoint: async () => {
      const r = await db
        .update(provisioningJobs)
        .set({ state })
        .where(and(eq(provisioningJobs.id, job.id), eq(provisioningJobs.workerId, workerId)))
        .returning({ id: provisioningJobs.id });
      if (!r.length) throw new Error('This worker no longer holds the job');
    },
  };
  class LostLease extends Error {}
  /** Every write is fenced by the worker id: a worker that lost the job can't change it. */
  const save = async (patch: Partial<typeof provisioningJobs.$inferInsert>) => {
    const r = await db
      .update(provisioningJobs)
      .set({ ...patch, state })
      .where(and(eq(provisioningJobs.id, job.id), eq(provisioningJobs.workerId, workerId)))
      .returning({ id: provisioningJobs.id });
    if (!r.length) throw new LostLease('This worker no longer holds the job');
  };

  const finish = async (status: 'completed' | 'failed' | 'cancelled', error?: string, result?: Record<string, unknown>) => {
    if (status !== 'completed' && kind?.cleanup) {
      try {
        await kind.cleanup(ctx);
      } catch (e) {
        await ctx.log(`Cleanup did not finish: ${(e as Error).message}`, 'warn');
      }
    }
    await save({ status, error: error?.slice(0, 1000) ?? null, result: result ?? null, finishedAt: now(), leaseUntil: null, bootTokenHash: null, bootMac: null, secretEnc: null });
    const unverified = status === 'completed' && result?.verified === false;
    await ctx.log(
      unverified ? `Completed, but not independently verified: ${String(result?.note ?? '')}` : status === 'completed' ? 'Completed and verified' : status === 'cancelled' ? 'Cancelled' : `Failed: ${error}`,
      status === 'failed' ? 'error' : unverified ? 'warn' : 'info',
    );
  };

  try {
    if (job.workerId !== workerId) return;
    if (!kind) return await finish('failed', `Unknown job kind ${job.kind}`);
    const steps = kind.steps(job);
    await ensureSteps(db, job, steps);

    // Interrupted mid-step by a crash? (A cancelled job goes straight to its cleanup instead.)
    if (claimed.previous === 'running' && !job.cancelRequested) {
      const step = steps[job.currentStep];
      if (step && !step.safeToRepeat) {
        await db.update(provisioningSteps).set({ status: 'failed', error: 'Interrupted (worker stopped) while this step was running', finishedAt: now() }).where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, job.currentStep)));
        await save({ status: 'recovery', leaseUntil: null, error: `Interrupted during “${step.name}”, which is not safe to repeat automatically. Check the server, then retry, skip or fail this step.` });
        await ctx.log(`Interrupted during “${step.name}”; waiting for an operator decision`, 'warn');
        return;
      }
      if (step) await ctx.log(`Resumed “${step.name}” after an interruption`, 'warn');
    }

    for (;;) {
      [job] = await db.select().from(provisioningJobs).where(eq(provisioningJobs.id, job.id)) as [ProvisioningJob];
      ctx.job = job;
      if (job.cancelRequested) {
        const failInstead = state.cancelAs === 'failed';
        return await finish(failInstead ? 'failed' : 'cancelled', failInstead ? String(state.cancelReason ?? 'Stopped by an operator') : undefined);
      }
      if (job.deadlineAt && now() > job.deadlineAt) return await finish('failed', String(state.deadlineMessage ?? 'Timed out'));
      const i = job.currentStep;
      const step = steps[i];
      if (!step) {
        const result = (await kind.onCompleted?.(ctx)) ?? undefined;
        return await finish('completed', undefined, result ?? (state.result as Record<string, unknown> | undefined));
      }
      const [row] = await db.select().from(provisioningSteps).where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, i)));
      const attempt = (row?.attempts ?? 0) + 1;
      await db
        .update(provisioningSteps)
        .set({ status: 'running', attempts: attempt, startedAt: row?.startedAt ?? now(), error: null })
        .where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, i)));
      await save({ status: 'running' });
      let res: StepResult;
      try {
        res = await step.run(ctx);
      } catch (e) {
        const msg = (e as Error)?.message || 'Unknown error';
        const max = step.maxAttempts ?? 3;
        await db.update(provisioningSteps).set({ error: msg.slice(0, 1000) }).where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, i)));
        if (e instanceof PermanentError || (step.safeToRepeat && attempt >= max)) {
          await db.update(provisioningSteps).set({ status: 'failed', finishedAt: now() }).where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, i)));
          return await finish('failed', `${step.name}: ${msg}`);
        }
        if (!step.safeToRepeat) {
          await db.update(provisioningSteps).set({ status: 'failed', finishedAt: now() }).where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, i)));
          await save({ status: 'recovery', leaseUntil: null, error: `“${step.name}” failed and may have partly happened: ${msg}. Check the server, then retry, skip or fail this step.` });
          await ctx.log(`“${step.name}” failed (${msg}); not repeated automatically`, 'warn');
          return;
        }
        const delay = (deps.retryBaseMs ?? 15_000) * 2 ** (attempt - 1);
        await save({ status: 'waiting', leaseUntil: null, nextRunAt: new Date(now().getTime() + delay) });
        await ctx.log(`“${step.name}” failed (attempt ${attempt} of ${max}): ${msg}; retrying in ${Math.round(delay / 1000)} s`, 'warn');
        return;
      }
      if ('wait' in res) {
        if (res.detail) await db.update(provisioningSteps).set({ detail: res.detail.slice(0, 1000) }).where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, i)));
        // Waiting is not an attempt: the step will be polled again.
        await db.update(provisioningSteps).set({ attempts: attempt - 1 }).where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, i)));
        await save({ status: res.status ?? 'waiting', leaseUntil: null, nextRunAt: new Date(now().getTime() + res.wait) });
        return;
      }
      await db
        .update(provisioningSteps)
        .set({ status: 'done', finishedAt: now(), detail: res.detail?.slice(0, 1000) ?? row?.detail ?? null })
        .where(and(eq(provisioningSteps.jobId, job.id), eq(provisioningSteps.seq, i)));
      await save({ currentStep: i + 1 });
      if (res.detail) await ctx.log(`${step.name}: ${res.detail}`);
    }
  } catch (e) {
    if (e instanceof LostLease) {
      deps.logger.warn({ jobId: job.id }, 'provisioning job taken over by another worker; stopping here');
      return;
    }
    // Database trouble or a bug: leave the lease to expire; the next claim resumes or asks for recovery.
    deps.logger.error({ jobId: job.id, err: (e as Error).message }, 'provisioning job crashed');
  }
}

/** Claims and runs due jobs, `concurrency` at a time, and waits (tests and one-shot runs). */
export async function runDueJobs(deps: EngineDeps, opts: { concurrency?: number; workerId?: string } = {}): Promise<number> {
  const workerId = opts.workerId ?? `w-${randomUUID().slice(0, 8)}`;
  const claimed = await claimJobs(deps, opts.concurrency ?? 4, workerId);
  await Promise.all(claimed.map((c) => runJob(deps, c, workerId)));
  return claimed.length;
}

/** The worker's loop: starts due jobs on free slots without waiting for them. */
export function createJobLoop(deps: EngineDeps, concurrency: number): () => Promise<void> {
  const workerId = `w-${randomUUID().slice(0, 8)}`;
  let inflight = 0;
  return async () => {
    const free = concurrency - inflight;
    if (free <= 0) return;
    for (const c of await claimJobs(deps, free, workerId)) {
      inflight++;
      void runJob(deps, c, workerId)
        .catch((e: Error) => deps.logger.error({ jobId: c.job.id, err: e.message }, 'provisioning job crashed'))
        .finally(() => inflight--);
    }
  };
}
