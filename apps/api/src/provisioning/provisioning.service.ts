import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dateFilter } from '../common/date-range';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  ACTIVE_JOB_STATUSES,
  POWER_ACTIONS,
  type ControlCredentialInput,
  type GuestAction,
  type DetectedIso,
  type InstallInput,
  type IsoUploadStart,
  type OsImageInput,
  type PxeSettingsInput,
  UPLOAD_CHUNK_BYTES,
  uploadedImageSchema,
  type PowerAction,
  type VirtIntegrationInput,
  guestListQuerySchema,
  guestReinstallSchema,
  type VirtTemplate,
  jobListQuerySchema,
  recoveryDecisionSchema,
} from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { freeBytes, imagePaths } from './iso/store';
import { bootBaseUrl, bootSettingsVersion } from './boot-base';
import {
  controlCredentials,
  customers,
  devices,
  osImages,
  provisioningEvents,
  provisioningJobs,
  provisioningSteps,
  pxeSettings,
  virtGuests,
  virtHosts,
  virtIntegrations,
  type OsImage,
  type ProvisioningJob,
  type VirtIntegration,
} from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { SecretBox } from '../common/secret-box';
import type Redis from 'ioredis';
import { REDIS } from '../redis/redis';
import { VIRT_WATCH_KEY, virtLiveKey } from '../health/worker-heartbeat';
import type { Principal, RequestMeta } from '../auth/principal';
import { controlContext, jobContext, newBootToken, hashToken, virtContext } from './contexts';
import { sha512Crypt } from './crypt';
import { TEMPLATE_VARIABLES, templateVariables } from './template';

const isPg = (e: unknown, code: string, constraint?: string) => {
  const x = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const c = x.cause ?? x;
  return c.code === code && (!constraint || c.constraint === constraint);
};

/**
 * Provisioning: jobs (power actions, OS installs, image checks, VM actions),
 * the OS image library, BMC control credentials and hypervisor integrations.
 *
 * The API only records requests; the worker carries them out step by step.
 * Requests can carry an Idempotency-Key: repeating a request with the same key
 * returns the same job, and reusing a key for a different request is refused.
 * A device or VM has at most one active job. Destructive requests need the
 * target's name typed as confirmation.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Keeps live node loads (CPU, memory) coming every 5 s while a hypervisor page is open (heartbeat every ~10 s). */
  async watchHosts(p: Principal) {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      await this.redis.zadd(VIRT_WATCH_KEY, Date.now() + 20_000, p.orgId);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  private record(p: Principal, meta: RequestMeta, action: string, target: { type: string; id: string | null }, metadata?: Record<string, unknown>, tx?: DbOrTx) {
    return this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: p.customerId, action, target, outcome: 'success', meta, metadata }, tx);
  }

  /* ---------------------------------------------------------------- shared */

  private async device(p: Principal, id: string, opts: { customerAllowed: boolean }) {
    const [d] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.orgId, p.orgId)));
    if (!d) throw new NotFoundException({ error: 'not_found', message: 'Device not found' });
    if (p.userType !== 'staff' && (!opts.customerAllowed || d.customerId !== p.customerId)) throw new NotFoundException({ error: 'not_found', message: 'Device not found' });
    return d;
  }

  private static confirmMatches(confirm: string, names: (string | null | undefined)[]) {
    const c = confirm.trim().toLowerCase();
    return names.some((n) => !!n && n.trim().toLowerCase() === c);
  }

  /** Inserts a job honouring the idempotency key and the one-active-job-per-target rule. */
  private async createJob(
    p: Principal,
    values: Omit<typeof provisioningJobs.$inferInsert, 'orgId' | 'idempotencyKey' | 'requestHash'> & { id?: string },
    idempotencyKey: string | undefined,
    request: unknown,
    meta: RequestMeta,
    auditAction: string,
    auditMeta: Record<string, unknown>,
    /** Runs in the same transaction, only when a new job is created. */
    alsoInTx?: (tx: DbOrTx, job: ProvisioningJob) => Promise<void>,
  ): Promise<{ job: ProvisioningJob; replayed: boolean }> {
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const key = idempotencyKey?.trim() || null;
    if (key && (key.length > 200 || !/^[\x21-\x7e]+$/.test(key))) throw new BadRequestException({ error: 'invalid_idempotency_key', message: 'Idempotency-Key must be up to 200 printable characters' });
    if (key) {
      const [prev] = await this.db
        .select()
        .from(provisioningJobs)
        .where(and(eq(provisioningJobs.orgId, p.orgId), eq(provisioningJobs.idempotencyKey, key)));
      if (prev) {
        if (prev.requestHash !== requestHash) throw new ConflictException({ error: 'idempotency_conflict', message: 'This Idempotency-Key was already used for a different request' });
        return { job: prev, replayed: true };
      }
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [job] = await tx
          .insert(provisioningJobs)
          .values({ ...values, orgId: p.orgId, idempotencyKey: key, requestHash, createdBy: p.email, createdByUserId: p.userId, customerRequest: p.userType !== 'staff' })
          .returning();
        await tx.insert(provisioningEvents).values({ jobId: job!.id, message: `Requested by ${p.email}` });
        if (alsoInTx) await alsoInTx(tx, job!);
        await this.record(
          p,
          meta,
          auditAction,
          { type: values.deviceId ? 'device' : values.guestId ? 'virt_guest' : 'os_image', id: (values.deviceId ?? values.guestId ?? values.imageId ?? null) as string | null },
          { jobId: job!.id, ...auditMeta },
          tx,
        );
        return { job: job!, replayed: false };
      });
    } catch (e) {
      if (isPg(e, '23505', 'provisioning_jobs_idem_uq') && key) {
        const [prev] = await this.db
          .select()
          .from(provisioningJobs)
          .where(and(eq(provisioningJobs.orgId, p.orgId), eq(provisioningJobs.idempotencyKey, key)));
        if (prev && prev.requestHash === requestHash) return { job: prev, replayed: true };
        throw new ConflictException({ error: 'idempotency_conflict', message: 'This Idempotency-Key was already used for a different request' });
      }
      if (isPg(e, '23505', 'provisioning_jobs_mac_active_uq')) throw new ConflictException({ error: 'mac_in_use', message: 'Another active installation uses this MAC address' });
      if (isPg(e, '23505', 'provisioning_jobs_image_verify_active_uq')) throw new ConflictException({ error: 'job_in_progress', message: 'A verification of this image is already running' });
      if (isPg(e, '23505', 'provisioning_jobs_device_active_uq') || isPg(e, '23505', 'provisioning_jobs_guest_active_uq')) {
        const target = values.deviceId ? eq(provisioningJobs.deviceId, values.deviceId) : eq(provisioningJobs.guestId, values.guestId!);
        const [active] = await this.db
          .select({ id: provisioningJobs.id, kind: provisioningJobs.kind })
          .from(provisioningJobs)
          .where(and(target, inArray(provisioningJobs.status, [...ACTIVE_JOB_STATUSES])));
        throw new ConflictException({
          error: 'job_in_progress',
          message: `Another job is still active for this ${values.deviceId ? 'server' : 'VM'}${active ? ` (${active.kind.replace('_', ' ')})` : ''}; wait for it or cancel it`,
          jobId: active?.id,
        });
      }
      throw e;
    }
  }

  /* ---------------------------------------------------------------- jobs */

  private jobScope(p: Principal): SQL {
    if (!p.permissions.has(p.userType === 'staff' ? 'provisioning.read' : 'hardware.control')) throw new ForbiddenException({ error: 'forbidden', message: 'You do not have permission to perform this action' });
    if (p.userType === 'staff') return sql`j.org_id = ${p.orgId}`;
    // Customers see the power and VM actions on their own equipment.
    return sql`j.org_id = ${p.orgId} and j.kind in ('power_action', 'guest_action') and (
      exists (select 1 from devices d where d.id = j.device_id and d.customer_id = ${p.customerId})
      or exists (select 1 from virt_guests g where g.id = j.guest_id and g.customer_id = ${p.customerId}))`;
  }

  async jobs(p: Principal, q: z.infer<typeof jobListQuerySchema>) {
    const conds: SQL[] = [this.jobScope(p)];
    if (q.status === 'active') conds.push(sql`j.status in ('queued','running','waiting','verifying','recovery')`);
    if (q.status === 'finished') conds.push(sql`j.status in ('completed','failed','cancelled')`);
    if (q.kind) conds.push(sql`j.kind = ${q.kind}`);
    if (q.deviceId) conds.push(sql`j.device_id = ${q.deviceId}`);
    conds.push(...dateFilter(sql`j.created_at`, p.orgId, q));
    const where = sql.join(conds, sql` and `);
    const [rows, total] = await Promise.all([
      this.db.execute(sql`
        select j.id, j.kind, j.status, j.device_id, coalesce(d.hostname, d.asset_tag) as device_name, j.guest_id, g.name as guest_name, j.image_id, i.name as image_name,
               j.params, j.current_step, j.error, j.created_by, j.created_at, j.started_at, j.finished_at, j.cancel_requested, (j.result->>'verified')::boolean as verified,
               (select count(*)::int from provisioning_steps s where s.job_id = j.id) as step_count
          from provisioning_jobs j
          left join devices d on d.id = j.device_id left join virt_guests g on g.id = j.guest_id left join os_images i on i.id = j.image_id
         where ${where}
         order by (j.status in ('queued','running','waiting','verifying','recovery')) desc, j.created_at desc
         limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
      this.db.execute<{ n: number }>(sql`select count(*)::int as n from provisioning_jobs j where ${where}`),
    ]);
    return { items: rows.rows.map(ProvisioningService.jobView), page: q.page, pageSize: q.pageSize, total: total.rows[0]?.n ?? 0 };
  }

  private static jobView(r: Record<string, unknown>) {
    const params = { ...((r.params as Record<string, unknown>) ?? {}) };
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      deviceId: r.device_id ?? null,
      deviceName: r.device_name ?? null,
      guestId: r.guest_id ?? null,
      guestName: r.guest_name ?? null,
      imageId: r.image_id ?? null,
      imageName: r.image_name ?? null,
      params,
      currentStep: r.current_step,
      stepCount: r.step_count ?? null,
      error: r.error ?? null,
      cancelRequested: r.cancel_requested,
      /** false: completed, but the outcome could not be observed (see the job log). */
      verified: r.status === 'completed' ? r.verified !== false : null,
      createdBy: r.created_by,
      createdAt: r.created_at,
      startedAt: r.started_at ?? null,
      finishedAt: r.finished_at ?? null,
    };
  }

  async job(p: Principal, id: string) {
    const r = await this.db.execute(sql`
      select j.id, j.kind, j.status, j.device_id, coalesce(d.hostname, d.asset_tag) as device_name, j.guest_id, g.name as guest_name, j.image_id, i.name as image_name,
             j.params, j.current_step, j.error, j.created_by, j.created_at, j.started_at, j.finished_at, j.cancel_requested, (j.result->>'verified')::boolean as verified, j.result, j.deadline_at,
             (select count(*)::int from provisioning_steps s where s.job_id = j.id) as step_count
        from provisioning_jobs j
        left join devices d on d.id = j.device_id left join virt_guests g on g.id = j.guest_id left join os_images i on i.id = j.image_id
       where j.id = ${id} and ${this.jobScope(p)}`);
    const row = r.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'Job not found' });
    const [steps, events] = await Promise.all([
      this.db.select().from(provisioningSteps).where(eq(provisioningSteps.jobId, id)).orderBy(provisioningSteps.seq),
      this.db.select().from(provisioningEvents).where(eq(provisioningEvents.jobId, id)).orderBy(provisioningEvents.id),
    ]);
    return { ...ProvisioningService.jobView(row), result: row.result ?? null, deadlineAt: row.deadline_at ?? null, steps, events };
  }

  /** Cancel: a queued job stops at once; a running one at the next step boundary, after cleanup. */
  /** Interactive install: the operator finished the installer in the console. */
  async markFinished(p: Principal, id: string, meta: RequestMeta) {
    const [j] = await this.db
      .select()
      .from(provisioningJobs)
      .where(and(eq(provisioningJobs.id, id), eq(provisioningJobs.orgId, p.orgId)));
    if (!j || j.kind !== 'os_install') throw new NotFoundException({ error: 'not_found', message: 'Installation not found' });
    if ((j.params as { mode?: string }).mode !== 'interactive') throw new BadRequestException({ error: 'not_interactive', message: 'Only an interactive install is marked finished by hand' });
    if (!['running', 'waiting', 'verifying'].includes(j.status)) throw new ConflictException({ error: 'not_active', message: 'The installation is not running' });
    const patch = { operatorFinished: { by: p.email, at: new Date().toISOString() } };
    await this.db.transaction(async (tx) => {
      await tx
        .update(provisioningJobs)
        .set({ signals: sql`coalesce(${provisioningJobs.signals}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, nextRunAt: sql`case when ${provisioningJobs.status} = 'waiting' then now() else ${provisioningJobs.nextRunAt} end` })
        .where(eq(provisioningJobs.id, id));
      await tx.insert(provisioningEvents).values({ jobId: id, message: `Marked finished by ${p.email}` });
      await this.record(p, meta, 'provisioning.install_marked_finished', { type: 'device', id: j.deviceId }, { jobId: id }, tx);
    });
    return { ok: true };
  }

  async cancel(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [j] = await tx
        .select()
        .from(provisioningJobs)
        .where(and(eq(provisioningJobs.id, id), eq(provisioningJobs.orgId, p.orgId)))
        .for('update');
      if (!j) throw new NotFoundException({ error: 'not_found', message: 'Job not found' });
      if (!ACTIVE_JOB_STATUSES.includes(j.status)) throw new ConflictException({ error: 'job_finished', message: 'The job has already finished' });
      if (j.status === 'queued') {
        await tx.update(provisioningJobs).set({ status: 'cancelled', finishedAt: new Date(), bootTokenHash: null, bootMac: null, secretEnc: null }).where(eq(provisioningJobs.id, id));
        // Nothing ran, so nothing to clean up on the equipment; only the image's status was set up front.
        if (j.kind === 'image_verify' && j.imageId)
          await tx
            .update(osImages)
            .set({ verifyStatus: 'unverified', verifyError: 'Verification was cancelled' })
            .where(and(eq(osImages.id, j.imageId), eq(osImages.verifyStatus, 'verifying')));
      } else {
        // A job waiting for a decision is handed back to the worker so its cleanup runs.
        await tx
          .update(provisioningJobs)
          .set({ cancelRequested: true, nextRunAt: new Date(), ...(j.status === 'recovery' ? { status: 'waiting' as const } : {}) })
          .where(eq(provisioningJobs.id, id));
      }
      await tx.insert(provisioningEvents).values({ jobId: id, message: `Cancellation requested by ${p.email}` });
      await this.record(p, meta, 'provisioning.cancel', { type: 'provisioning_job', id }, { kind: j.kind }, tx);
      return { id, status: j.status === 'queued' ? 'cancelled' : j.status, cancelRequested: j.status !== 'queued' };
    });
  }

  /** Operator decision for a job in `recovery`. */
  async recover(p: Principal, id: string, d: z.infer<typeof recoveryDecisionSchema>, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [j] = await tx
        .select()
        .from(provisioningJobs)
        .where(and(eq(provisioningJobs.id, id), eq(provisioningJobs.orgId, p.orgId)))
        .for('update');
      if (!j) throw new NotFoundException({ error: 'not_found', message: 'Job not found' });
      if (j.status !== 'recovery') throw new ConflictException({ error: 'not_in_recovery', message: 'The job is not waiting for a decision' });
      const base = { status: 'waiting' as const, nextRunAt: new Date(), leaseUntil: null, workerId: null, error: null };
      if (d.decision === 'retry') {
        await tx
          .update(provisioningSteps)
          .set({ status: 'pending', error: null })
          .where(and(eq(provisioningSteps.jobId, id), eq(provisioningSteps.seq, j.currentStep)));
        await tx.update(provisioningJobs).set(base).where(eq(provisioningJobs.id, id));
      } else if (d.decision === 'skip') {
        await tx
          .update(provisioningSteps)
          .set({ status: 'skipped', finishedAt: new Date(), detail: `Skipped by ${p.email}${d.note ? `: ${d.note}` : ''}` })
          .where(and(eq(provisioningSteps.jobId, id), eq(provisioningSteps.seq, j.currentStep)));
        await tx
          .update(provisioningJobs)
          .set({ ...base, currentStep: j.currentStep + 1 })
          .where(eq(provisioningJobs.id, id));
      } else {
        await tx
          .update(provisioningJobs)
          .set({ ...base, cancelRequested: true, state: { ...j.state, cancelAs: 'failed', cancelReason: `Stopped by ${p.email}${d.note ? `: ${d.note}` : ''}` } })
          .where(eq(provisioningJobs.id, id));
      }
      await tx.insert(provisioningEvents).values({ jobId: id, message: `Decision by ${p.email}: ${d.decision}${d.note ? ` (${d.note})` : ''}`, level: 'warn' });
      await this.record(p, meta, 'provisioning.recovery', { type: 'provisioning_job', id }, { decision: d.decision, step: j.currentStep, note: d.note ?? null }, tx);
      return { id, decision: d.decision };
    });
  }

  /* ---------------------------------------------------------------- power actions and control access */

  async controlStatus(p: Principal, deviceId: string) {
    const d = await this.device(p, deviceId, { customerAllowed: true });
    const [c] = await this.db.select().from(controlCredentials).where(eq(controlCredentials.deviceId, deviceId));
    const [active] = await this.db
      .select({ id: provisioningJobs.id, kind: provisioningJobs.kind, status: provisioningJobs.status })
      .from(provisioningJobs)
      .where(and(eq(provisioningJobs.deviceId, deviceId), inArray(provisioningJobs.status, [...ACTIVE_JOB_STATUSES])));
    return {
      deviceId: d.id,
      name: d.hostname ?? d.assetTag,
      configured: !!c,
      /** Actions this BMC can carry out (IPMI has no ACPI restart). */
      actions: c ? POWER_ACTIONS.filter((a) => !(c.kind === 'ipmi' && a === 'graceful_restart')) : [],
      // Customers learn only whether power control is available.
      credential: c && p.userType === 'staff' ? { kind: c.kind, host: c.host, port: c.port, username: c.username, rotatedAt: c.rotatedAt } : null,
      activeJob: active ?? null,
    };
  }

  async putControlCredential(p: Principal, deviceId: string, input: ControlCredentialInput, meta: RequestMeta) {
    const d = await this.device(p, deviceId, { customerAllowed: false });
    const { password, kind, host, port, username, ...params } = input;
    const secretEnc = this.secrets.encrypt(JSON.stringify({ password }), controlContext(p.orgId, d.id, kind, host, port ?? null));
    return this.db.transaction(async (tx) => {
      const values = { kind, host, port: port ?? null, username, params, secretEnc, rotatedAt: new Date(), lastTestAt: null, lastTestOk: null, lastTestMessage: null };
      await tx
        .insert(controlCredentials)
        .values({ deviceId: d.id, orgId: p.orgId, ...values })
        .onConflictDoUpdate({ target: controlCredentials.deviceId, set: values });
      await this.record(p, meta, 'provisioning.control_credential', { type: 'device', id: d.id }, { kind, host, port: port ?? null, username }, tx);
      return { deviceId: d.id, kind, host, port: port ?? null, username, secretConfigured: true };
    });
  }

  async deleteControlCredential(p: Principal, deviceId: string, meta: RequestMeta) {
    await this.device(p, deviceId, { customerAllowed: false });
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(controlCredentials)
        .where(and(eq(controlCredentials.deviceId, deviceId), eq(controlCredentials.orgId, p.orgId)))
        .returning();
      if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'No control credential' });
      await this.record(p, meta, 'provisioning.control_credential_delete', { type: 'device', id: deviceId }, undefined, tx);
      return { ok: true };
    });
  }

  async powerAction(p: Principal, deviceId: string, input: { action: PowerAction; confirm: string }, idem: string | undefined, meta: RequestMeta) {
    const d = await this.device(p, deviceId, { customerAllowed: true });
    if (!ProvisioningService.confirmMatches(input.confirm, [d.hostname, d.assetTag])) throw new BadRequestException({ error: 'confirmation_mismatch', message: `Type the server's name (${d.hostname ?? d.assetTag}) to confirm` });
    const [c] = await this.db.select({ kind: controlCredentials.kind }).from(controlCredentials).where(eq(controlCredentials.deviceId, d.id));
    if (!c) throw new BadRequestException({ error: 'no_control_credential', message: 'Power control is not set up for this server' });
    // IPMI's "soft" is an ACPI shutdown, not a restart: offering it as a restart would leave the server off.
    if (c.kind === 'ipmi' && input.action === 'graceful_restart') throw new BadRequestException({ error: 'action_unsupported', message: 'IPMI has no ACPI restart; use Shut down (ACPI) and then Power on, or Restart (hard reset)' });
    const r = await this.createJob(p, { kind: 'power_action', deviceId: d.id, params: { action: input.action } }, idem, { op: 'power', deviceId, action: input.action }, meta, 'provisioning.power_action', { action: input.action });
    return { ...ProvisioningService.publicJob(r.job), replayed: r.replayed };
  }

  /* ---------------------------------------------------------------- installs */

  async install(p: Principal, input: InstallInput, idem: string | undefined, meta: RequestMeta) {
    const d = await this.device(p, input.deviceId, { customerAllowed: false });
    if (!ProvisioningService.confirmMatches(input.confirm, [d.hostname, d.assetTag])) throw new BadRequestException({ error: 'confirmation_mismatch', message: `Type the server's current name (${d.hostname ?? d.assetTag}) to confirm` });
    const [img] = await this.db
      .select()
      .from(osImages)
      .where(and(eq(osImages.id, input.imageId), eq(osImages.orgId, p.orgId)));
    if (!img) throw new BadRequestException({ error: 'invalid_image', message: 'Image not found' });
    if (!img.enabled) throw new BadRequestException({ error: 'image_disabled', message: 'The image is disabled' });
    if (img.source === 'upload') {
      if (img.uploadStatus !== 'ready') throw new BadRequestException({ error: 'image_not_ready', message: 'The ISO is still being uploaded or prepared' });
      const det = img.detected as unknown as DetectedIso | null;
      if (!det?.methods.includes(input.method)) throw new BadRequestException({ error: 'method_unsupported', message: `${img.name} cannot be installed by ${input.method === 'pxe' ? 'network boot (PXE)' : 'virtual media'}` });
      if (!det.modes[input.method].includes(input.mode))
        throw new BadRequestException({ error: 'mode_unsupported', message: `${img.name} supports only ${det.modes[input.method].join(' or ')} installs by ${input.method === 'pxe' ? 'network boot' : 'virtual media'}` });
      if (input.mode === 'automatic' && img.templateKind === 'none') throw new BadRequestException({ error: 'no_template', message: 'An automatic install needs an install template on the image' });
      if (input.mode === 'automatic' && det.bootKind === 'esxi' && !input.rootPassword) throw new BadRequestException({ error: 'password_required', message: 'ESXi needs a root password' });
    } else {
      if (img.verifyStatus !== 'verified') throw new BadRequestException({ error: 'image_unverified', message: 'Verify the image checksums before installing it' });
      if (input.method === 'redfish_virtual_media' && !img.isoUrl) throw new BadRequestException({ error: 'method_unsupported', message: 'This image has no ISO for virtual media' });
      if (input.method === 'pxe' && !img.kernelUrl) throw new BadRequestException({ error: 'method_unsupported', message: 'This image has no kernel/initrd for PXE' });
    }
    const [c] = await this.db.select({ kind: controlCredentials.kind }).from(controlCredentials).where(eq(controlCredentials.deviceId, d.id));
    if (!c) throw new BadRequestException({ error: 'no_control_credential', message: 'Set up the BMC control credential first' });
    if (input.method === 'redfish_virtual_media' && c.kind !== 'redfish') throw new BadRequestException({ error: 'method_unsupported', message: 'Virtual media needs a Redfish control credential' });
    if (input.network.mode === 'static') {
      if (isIP(input.network.address) === 4 && input.network.prefixLength > 32) throw new BadRequestException({ error: 'invalid_prefix', message: 'An IPv4 prefix length is at most 32' });
      if (input.network.gateway && isIP(input.network.gateway) !== isIP(input.network.address)) throw new BadRequestException({ error: 'invalid_gateway', message: 'The gateway must be the same IP version as the address' });
      // Never configure an address IPAM has given to something else (compared as inet, so any spelling matches).
      const clash = await this.db.execute<{ device_id: string | null }>(sql`
        select device_id from ip_addresses where org_id = ${p.orgId} and vrf_id is null and host(address)::inet = ${input.network.address}::inet and status in ('allocated','reserved')
           and (device_id is distinct from ${d.id})`);
      if (clash.rows.length) throw new ConflictException({ error: 'address_in_use', message: `${input.network.address} is assigned to something else in IPAM` });
      const other = await this.db.execute(sql`
        select 1 from provisioning_jobs where org_id = ${p.orgId} and kind = 'os_install' and status in ('queued','running','waiting','verifying','recovery')
           and device_id <> ${d.id} and params->'network'->>'mode' = 'static' and (params->'network'->>'address')::inet = ${input.network.address}::inet`);
      if (other.rows.length) throw new ConflictException({ error: 'address_in_use', message: `Another active installation is configuring ${input.network.address}` });
    }
    const id = randomUUID();
    const token = newBootToken();
    const secret = { bootToken: token, rootPasswordHash: input.rootPassword ? sha512Crypt(input.rootPassword) : null };
    const { rootPassword: _pw, confirm: _c, wipeAcknowledged: _w, ...rest } = input;
    // The files are pinned at request time; a later edit of the image cannot change what this job installs.
    const params = { ...rest, imageName: img.name, rootPasswordSet: !!input.rootPassword, files: ProvisioningService.fileSnapshot(img) };
    const r = await this.createJob(
      p,
      {
        id,
        kind: 'os_install',
        deviceId: d.id,
        imageId: img.id,
        params,
        secretEnc: this.secrets.encrypt(JSON.stringify(secret), jobContext(p.orgId, id)),
        bootTokenHash: hashToken(token),
        bootMac: input.macAddress ?? null,
        deadlineAt: new Date(Date.now() + input.timeoutMinutes * 60_000),
        state: { deadlineMessage: `The installation did not finish within ${input.timeoutMinutes} minutes` },
      },
      idem,
      { op: 'install', ...rest, rootPassword: input.rootPassword ? createHash('sha256').update(input.rootPassword).digest('hex') : null },
      meta,
      'provisioning.install',
      { imageId: img.id, image: img.name, method: input.method, hostname: input.hostname },
    );
    return { ...ProvisioningService.publicJob(r.job), replayed: r.replayed };
  }

  static fileSnapshot(i: OsImage) {
    return { isoUrl: i.isoUrl, isoSha256: i.isoSha256, kernelUrl: i.kernelUrl, kernelSha256: i.kernelSha256, initrdUrl: i.initrdUrl, initrdSha256: i.initrdSha256 };
  }

  private static publicJob(j: ProvisioningJob) {
    const { secretEnc: _s, bootTokenHash: _b, requestHash: _r, ...rest } = j;
    return rest;
  }

  /* ---------------------------------------------------------------- images */

  static imageView(i: OsImage) {
    return i;
  }

  async images(p: Principal) {
    return this.db.select().from(osImages).where(eq(osImages.orgId, p.orgId)).orderBy(osImages.name);
  }

  private static checkTemplate(input: OsImageInput) {
    const vars = [...templateVariables(input.template ?? ''), ...templateVariables(input.bootArgs ?? '')];
    const unknown = vars.filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v));
    if (unknown.length) throw new BadRequestException({ error: 'invalid_template', message: `Unknown template variable(s): ${unknown.map((v) => `{{${v}}}`).join(', ')}` });
  }

  private static imageValues(input: OsImageInput) {
    return {
      name: input.name,
      family: input.family,
      version: input.version ?? null,
      arch: input.arch,
      isoUrl: input.isoUrl ?? null,
      isoSha256: input.isoSha256 ?? null,
      kernelUrl: input.kernelUrl ?? null,
      kernelSha256: input.kernelSha256 ?? null,
      initrdUrl: input.initrdUrl ?? null,
      initrdSha256: input.initrdSha256 ?? null,
      bootArgs: input.bootArgs ?? null,
      templateKind: input.templateKind,
      template: input.templateKind === 'none' ? null : (input.template ?? null),
      enabled: input.enabled,
      notes: input.notes ?? null,
    };
  }

  async createImage(p: Principal, input: OsImageInput, meta: RequestMeta) {
    ProvisioningService.checkTemplate(input);
    try {
      return await this.db.transaction(async (tx) => {
        const [i] = await tx
          .insert(osImages)
          .values({ ...ProvisioningService.imageValues(input), orgId: p.orgId })
          .returning();
        await this.record(p, meta, 'provisioning.image_create', { type: 'os_image', id: i!.id }, { name: input.name }, tx);
        return i!;
      });
    } catch (e) {
      if (isPg(e, '23505', 'os_images_org_name_uq')) throw new ConflictException({ error: 'duplicate_name', message: 'An image with this name already exists' });
      throw e;
    }
  }

  async updateImage(p: Principal, id: string, input: OsImageInput, meta: RequestMeta) {
    ProvisioningService.checkTemplate(input);
    try {
      return await this.db.transaction(async (tx) => {
        const [cur] = await tx
          .select()
          .from(osImages)
          .where(and(eq(osImages.id, id), eq(osImages.orgId, p.orgId)))
          .for('update');
        if (!cur) throw new NotFoundException({ error: 'not_found', message: 'Image not found' });
        if (cur.source === 'upload') throw new BadRequestException({ error: 'uploaded_image', message: 'An uploaded ISO is edited through its settings, not its file URLs' });
        const v = ProvisioningService.imageValues(input);
        // New files or checksums need a new verification.
        const filesChanged = (['isoUrl', 'isoSha256', 'kernelUrl', 'kernelSha256', 'initrdUrl', 'initrdSha256'] as const).some((k) => v[k] !== cur[k]);
        if (filesChanged) {
          const [busy] = await tx
            .select({ id: provisioningJobs.id })
            .from(provisioningJobs)
            .where(and(eq(provisioningJobs.imageId, id), inArray(provisioningJobs.status, [...ACTIVE_JOB_STATUSES])));
          if (busy) throw new ConflictException({ error: 'in_use', message: 'A job is using this image; its files and checksums can change once it has finished', jobId: busy.id });
        }
        const [i] = await tx
          .update(osImages)
          .set({ ...v, ...(filesChanged ? { verifyStatus: 'unverified' as const, verifiedAt: null, verifyError: null, sizes: {} } : {}) })
          .where(eq(osImages.id, id))
          .returning();
        await this.record(p, meta, 'provisioning.image_update', { type: 'os_image', id }, { name: input.name, filesChanged }, tx);
        return i!;
      });
    } catch (e) {
      if (isPg(e, '23505', 'os_images_org_name_uq')) throw new ConflictException({ error: 'duplicate_name', message: 'An image with this name already exists' });
      throw e;
    }
  }

  async deleteImage(p: Principal, id: string, meta: RequestMeta) {
    return this.db
      .transaction(async (tx) => {
        const [busy] = await tx
          .select({ id: provisioningJobs.id })
          .from(provisioningJobs)
          .where(and(eq(provisioningJobs.imageId, id), inArray(provisioningJobs.status, [...ACTIVE_JOB_STATUSES])));
        if (busy) throw new ConflictException({ error: 'in_use', message: 'A job is using this image' });
        const rows = await tx
          .delete(osImages)
          .where(and(eq(osImages.id, id), eq(osImages.orgId, p.orgId)))
          .returning();
        if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Image not found' });
        await this.record(p, meta, 'provisioning.image_delete', { type: 'os_image', id }, { name: rows[0]!.name }, tx);
        return rows[0]!;
      })
      .then(async (img) => {
        if (img.source === 'upload') await fs.rm(imagePaths(this.cfg.CDCIM_IMAGE_DIR, img.id).dir, { recursive: true, force: true });
        return { ok: true };
      });
  }

  async verifyImage(p: Principal, id: string, idem: string | undefined, meta: RequestMeta) {
    const [img] = await this.db
      .select()
      .from(osImages)
      .where(and(eq(osImages.id, id), eq(osImages.orgId, p.orgId)));
    if (!img) throw new NotFoundException({ error: 'not_found', message: 'Image not found' });
    if (img.source === 'upload') throw new BadRequestException({ error: 'uploaded_image', message: 'Uploaded ISOs are checked when they are prepared; use Prepare again instead' });
    const files = ProvisioningService.fileSnapshot(img);
    const r = await this.createJob(p, { kind: 'image_verify', imageId: id, params: { image: img.name, files } }, idem, { op: 'verify', id, files }, meta, 'provisioning.image_verify', { name: img.name }, async (tx) => {
      await tx.update(osImages).set({ verifyStatus: 'verifying', verifyError: null }).where(eq(osImages.id, id));
    });
    return { ...ProvisioningService.publicJob(r.job), replayed: r.replayed };
  }

  /* ---------------------------------------------------------------- uploaded ISOs */

  private async uploadedImage(p: Principal, id: string) {
    const [img] = await this.db
      .select()
      .from(osImages)
      .where(and(eq(osImages.id, id), eq(osImages.orgId, p.orgId)));
    if (!img || img.source !== 'upload') throw new NotFoundException({ error: 'not_found', message: 'Uploaded image not found' });
    return img;
  }

  /** Starts an ISO upload: checks the name and free disk space, and reserves the file. */
  async startUpload(p: Principal, input: IsoUploadStart, meta: RequestMeta) {
    const base = this.cfg.CDCIM_IMAGE_DIR;
    const free = await freeBytes(base);
    // Room for the ISO plus an extracted copy (RHEL family and ESXi installers read the extracted tree).
    if (free < input.size * 2.05) {
      const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
      throw new BadRequestException({ error: 'disk_full', message: `Not enough disk space: ${gb(input.size * 2.05)} needed (the ISO and an extracted copy), ${gb(free)} free` });
    }
    const id = randomUUID();
    const paths = imagePaths(base, id);
    await fs.mkdir(paths.dir, { recursive: true, mode: 0o750 });
    await fs.writeFile(paths.iso, '');
    try {
      return await this.db.transaction(async (tx) => {
        const [i] = await tx
          .insert(osImages)
          .values({
            id,
            orgId: p.orgId,
            name: input.name,
            family: 'other',
            source: 'upload',
            uploadStatus: 'uploading',
            uploadFileName: input.fileName,
            uploadSize: input.size,
            uploadedBytes: 0,
            expectedSha256: input.expectedSha256 ?? null,
            notes: input.notes ?? null,
            templateKind: 'none',
            verifyStatus: 'unverified',
          })
          .returning();
        await this.record(p, meta, 'provisioning.image_upload', { type: 'os_image', id }, { name: input.name, fileName: input.fileName, size: input.size }, tx);
        return i!;
      });
    } catch (e) {
      await fs.rm(paths.dir, { recursive: true, force: true });
      if (isPg(e, '23505', 'os_images_org_name_uq')) throw new ConflictException({ error: 'duplicate_name', message: 'An image with this name already exists' });
      throw e;
    }
  }

  /**
   * Appends one chunk. The client sends chunks in order with the offset it
   * believes is next; a mismatch (lost response, second tab) gets 409 with the
   * server's offset so the client resumes from there.
   */
  async uploadChunk(p: Principal, id: string, offset: number, length: number, body: Readable) {
    const img = await this.uploadedImage(p, id);
    if (img.uploadStatus !== 'uploading') throw new ConflictException({ error: 'not_uploading', message: 'This upload is already complete' });
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) throw new BadRequestException({ error: 'invalid_chunk', message: 'Upload-Offset and Content-Length are required' });
    if (length > UPLOAD_CHUNK_BYTES * 2) throw new BadRequestException({ error: 'chunk_too_large', message: `Chunks are at most ${(UPLOAD_CHUNK_BYTES * 2) / 1024 ** 2} MiB` });
    if (offset !== img.uploadedBytes) throw new ConflictException({ error: 'offset_mismatch', message: 'Resume from the server’s offset', uploadedBytes: img.uploadedBytes });
    if (offset + length > (img.uploadSize ?? 0)) throw new BadRequestException({ error: 'too_large', message: 'The upload is larger than announced' });
    const iso = imagePaths(this.cfg.CDCIM_IMAGE_DIR, id).iso;
    let n = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        n += chunk.length;
        if (n > length) return cb(new BadRequestException({ error: 'too_large', message: 'The chunk is larger than its Content-Length' }));
        cb(null, chunk);
      },
    });
    await pipeline(body, limit, createWriteStream(iso, { flags: 'r+', start: offset }));
    if (n !== length) throw new BadRequestException({ error: 'incomplete_chunk', message: 'The chunk arrived incomplete; send it again' });
    const r = await this.db
      .update(osImages)
      .set({ uploadedBytes: offset + length })
      .where(and(eq(osImages.id, id), eq(osImages.uploadedBytes, offset), eq(osImages.uploadStatus, 'uploading')))
      .returning({ uploadedBytes: osImages.uploadedBytes });
    if (!r.length) {
      const [cur] = await this.db.select({ uploadedBytes: osImages.uploadedBytes }).from(osImages).where(eq(osImages.id, id));
      throw new ConflictException({ error: 'offset_mismatch', message: 'Resume from the server’s offset', uploadedBytes: cur?.uploadedBytes ?? 0 });
    }
    return { uploadedBytes: r[0]!.uploadedBytes, uploadSize: img.uploadSize };
  }

  /** All bytes are in: queue the preparation (checksum, detection, boot files). */
  async completeUpload(p: Principal, id: string, idem: string | undefined, meta: RequestMeta) {
    const img = await this.uploadedImage(p, id);
    if (img.uploadStatus === 'uploading' && img.uploadedBytes !== img.uploadSize) throw new BadRequestException({ error: 'incomplete', message: `${img.uploadedBytes} of ${img.uploadSize} bytes uploaded` });
    if (img.uploadStatus !== 'uploading' && img.uploadStatus !== 'failed') throw new ConflictException({ error: 'already_complete', message: 'The ISO is already being prepared or is ready' });
    const st = await fs.stat(imagePaths(this.cfg.CDCIM_IMAGE_DIR, id).iso).catch(() => null);
    if (!st || st.size !== img.uploadSize) throw new BadRequestException({ error: 'incomplete', message: 'The file on the server is incomplete; upload it again' });
    const [busy] = await this.db
      .select({ id: provisioningJobs.id })
      .from(provisioningJobs)
      .where(and(eq(provisioningJobs.imageId, id), inArray(provisioningJobs.status, [...ACTIVE_JOB_STATUSES])));
    if (busy) throw new ConflictException({ error: 'job_in_progress', message: 'The ISO is already being prepared', jobId: busy.id });
    const r = await this.createJob(
      p,
      { kind: 'image_process', imageId: id, params: { image: img.name, fileName: img.uploadFileName } },
      idem,
      { op: 'process', id, attempt: img.processError ?? null },
      meta,
      'provisioning.image_process',
      { name: img.name },
      async (tx) => {
        await tx.update(osImages).set({ uploadStatus: 'processing', processError: null, verifyStatus: 'verifying' }).where(eq(osImages.id, id));
      },
    );
    return { ...ProvisioningService.publicJob(r.job), replayed: r.replayed };
  }

  /** Name, template and boot arguments of an uploaded image (its files come from the upload). */
  async updateUploadedImage(p: Principal, id: string, input: z.infer<typeof uploadedImageSchema>, meta: RequestMeta) {
    await this.uploadedImage(p, id);
    const vars = [...templateVariables(input.template ?? ''), ...templateVariables(input.bootArgs ?? '')];
    const unknown = vars.filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v));
    if (unknown.length) throw new BadRequestException({ error: 'invalid_template', message: `Unknown template variable(s): ${unknown.map((v) => `{{${v}}}`).join(', ')}` });
    if (input.templateKind !== 'none' && !input.template?.trim()) throw new BadRequestException({ error: 'invalid_template', message: 'Enter the template' });
    if (input.bootArgs && /[\r\n]/.test(input.bootArgs)) throw new BadRequestException({ error: 'invalid_boot_args', message: 'Boot arguments must be one line' });
    try {
      const [i] = await this.db
        .update(osImages)
        .set({ name: input.name, templateKind: input.templateKind, template: input.templateKind === 'none' ? null : (input.template ?? null), bootArgs: input.bootArgs ?? null, enabled: input.enabled, notes: input.notes ?? null })
        .where(and(eq(osImages.id, id), eq(osImages.orgId, p.orgId)))
        .returning();
      await this.record(p, meta, 'provisioning.image_update', { type: 'os_image', id }, { name: input.name, uploaded: true });
      return i!;
    } catch (e) {
      if (isPg(e, '23505', 'os_images_org_name_uq')) throw new ConflictException({ error: 'duplicate_name', message: 'An image with this name already exists' });
      throw e;
    }
  }

  /* ---------------------------------------------------------------- PXE service */

  async pxe(p: Principal) {
    const [s] = await this.db.select().from(pxeSettings).where(eq(pxeSettings.orgId, p.orgId));
    const active = await this.db.execute<{ n: number }>(sql`
      select count(*)::int as n from provisioning_jobs
       where org_id = ${p.orgId} and kind = 'os_install' and status in ('queued','running','waiting','verifying','recovery') and params->>'method' = 'pxe'`);
    // This server's addresses, to help pick the interface and the address servers reach it at.
    const nics = Object.entries(networkInterfaces())
      .filter(([name]) => name !== 'lo')
      .map(([name, addrs]) => ({ name, addresses: (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.cidr ?? a.address) }))
      .filter((n) => n.addresses.length);
    return {
      settings: s ?? null,
      bootBase: await bootBaseUrl(this.db, p.orgId, this.cfg.CDCIM_PUBLIC_URL),
      activeNetworkInstalls: active.rows[0]?.n ?? 0,
      interfaces: nics,
    };
  }

  async putPxe(p: Principal, input: PxeSettingsInput, meta: RequestMeta) {
    for (const r of input.ranges) {
      const toN = (a: string) => a.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
      const [net, len] = r.network.split('/') as [string, string];
      const mask = Number(len) === 0 ? 0 : (0xffffffff << (32 - Number(len))) >>> 0;
      const inNet = (a: string) => (toN(a) & mask) >>> 0 === (toN(net) & mask) >>> 0;
      if (!inNet(r.start) || !inNet(r.end)) throw new BadRequestException({ error: 'invalid_range', message: `${r.start}–${r.end} is not inside ${r.network}` });
      if (toN(r.start) > toN(r.end)) throw new BadRequestException({ error: 'invalid_range', message: `${r.start} comes after ${r.end}` });
      if (r.gateway && !inNet(r.gateway)) throw new BadRequestException({ error: 'invalid_range', message: `The gateway ${r.gateway} is not inside ${r.network}` });
    }
    const values = {
      enabled: input.enabled,
      mode: input.mode,
      interface: input.interface || null,
      serverAddress: input.serverAddress,
      proxyNetworks: input.proxyNetworks,
      ranges: input.ranges.map((r) => ({ ...r, gateway: r.gateway ?? null })),
      bootBaseUrl: input.bootBaseUrl ?? null,
      allowNetworks: input.allowNetworks,
      appliedAt: null,
      applyError: null,
    };
    const [row] = await this.db
      .insert(pxeSettings)
      .values({ orgId: p.orgId, ...values })
      .onConflictDoUpdate({ target: pxeSettings.orgId, set: values })
      .returning();
    bootSettingsVersion.n++;
    await this.record(p, meta, 'provisioning.pxe_settings', { type: 'pxe_settings', id: null }, { enabled: input.enabled, mode: input.mode, interface: input.interface ?? null, serverAddress: input.serverAddress });
    return row!;
  }

  /* ---------------------------------------------------------------- virtualization */

  static integrationView(i: VirtIntegration) {
    const { secretEnc: _s, ...rest } = i;
    return { ...rest, secretConfigured: true as const };
  }

  async integrations(p: Principal) {
    const rows = await this.db.select().from(virtIntegrations).where(eq(virtIntegrations.orgId, p.orgId)).orderBy(virtIntegrations.name);
    const counts = await this.db.execute<{ integration_id: string; hosts: number; guests: number }>(sql`
      select i.id as integration_id,
             (select count(*)::int from virt_hosts h where h.integration_id = i.id and h.missing_since is null) as hosts,
             (select count(*)::int from virt_guests g where g.integration_id = i.id and g.missing_since is null) as guests
        from virt_integrations i where i.org_id = ${p.orgId}`);
    const by = new Map(counts.rows.map((c) => [c.integration_id, c]));
    return rows.map((i) => ({ ...ProvisioningService.integrationView(i), hosts: by.get(i.id)?.hosts ?? 0, guests: by.get(i.id)?.guests ?? 0 }));
  }

  private static splitIntegration(input: VirtIntegrationInput) {
    if (input.kind === 'proxmox') {
      if (!!input.actionTokenId !== !!input.actionTokenSecret) throw new BadRequestException({ error: 'invalid_integration', message: 'Give both the action token id and its secret, or neither' });
      return {
        params: { tokenId: input.tokenId, actionTokenId: input.actionTokenId ?? null },
        secret: { tokenSecret: input.tokenSecret, actionTokenSecret: input.actionTokenSecret ?? null },
        actionsEnabled: !!input.actionTokenId,
      };
    }
    return { params: {}, secret: { apiKey: input.apiKey, apiPass: input.apiPass }, actionsEnabled: input.actionsEnabled };
  }

  async createIntegration(p: Principal, input: VirtIntegrationInput, meta: RequestMeta) {
    const id = randomUUID();
    const { params, secret, actionsEnabled } = ProvisioningService.splitIntegration(input);
    const secretEnc = this.secrets.encrypt(JSON.stringify(secret), virtContext(p.orgId, id, input.kind, input.url));
    try {
      return await this.db.transaction(async (tx) => {
        const [i] = await tx
          .insert(virtIntegrations)
          .values({ id, orgId: p.orgId, kind: input.kind, name: input.name, url: input.url, verifyTls: input.verifyTls, params, secretEnc, actionsEnabled, enabled: input.enabled, syncMinutes: input.syncMinutes, nextSyncAt: new Date() })
          .returning();
        await this.record(p, meta, 'virt.integration_create', { type: 'virt_integration', id }, { kind: input.kind, name: input.name, url: input.url, actionsEnabled }, tx);
        return ProvisioningService.integrationView(i!);
      });
    } catch (e) {
      if (isPg(e, '23505', 'virt_integrations_org_name_uq')) throw new ConflictException({ error: 'duplicate_name', message: 'An integration with this name already exists' });
      throw e;
    }
  }

  /** Replaces an integration; secrets must be entered again. */
  async updateIntegration(p: Principal, id: string, input: VirtIntegrationInput, meta: RequestMeta) {
    const { params, secret, actionsEnabled } = ProvisioningService.splitIntegration(input);
    const secretEnc = this.secrets.encrypt(JSON.stringify(secret), virtContext(p.orgId, id, input.kind, input.url));
    try {
      return await this.db.transaction(async (tx) => {
        const [cur] = await tx
          .select()
          .from(virtIntegrations)
          .where(and(eq(virtIntegrations.id, id), eq(virtIntegrations.orgId, p.orgId)))
          .for('update');
        if (!cur) throw new NotFoundException({ error: 'not_found', message: 'Integration not found' });
        if (cur.kind !== input.kind) throw new BadRequestException({ error: 'kind_fixed', message: 'The type of an integration cannot change' });
        const [i] = await tx
          .update(virtIntegrations)
          .set({ name: input.name, url: input.url, verifyTls: input.verifyTls, params, secretEnc, actionsEnabled, enabled: input.enabled, syncMinutes: input.syncMinutes, nextSyncAt: new Date(), lastError: null })
          .where(eq(virtIntegrations.id, id))
          .returning();
        await this.record(p, meta, 'virt.integration_update', { type: 'virt_integration', id }, { name: input.name, url: input.url, actionsEnabled, enabled: input.enabled }, tx);
        return ProvisioningService.integrationView(i!);
      });
    } catch (e) {
      if (isPg(e, '23505', 'virt_integrations_org_name_uq')) throw new ConflictException({ error: 'duplicate_name', message: 'An integration with this name already exists' });
      throw e;
    }
  }

  async deleteIntegration(p: Principal, id: string, meta: RequestMeta) {
    return this.db.transaction(async (tx) => {
      const [busy] = await tx
        .execute<{ id: string }>(sql`select j.id from provisioning_jobs j join virt_guests g on g.id = j.guest_id where g.integration_id = ${id} and j.status in ('queued','running','waiting','verifying','recovery') limit 1`)
        .then((r) => r.rows);
      if (busy) throw new ConflictException({ error: 'in_use', message: 'A VM action is still running for this integration' });
      const rows = await tx
        .delete(virtIntegrations)
        .where(and(eq(virtIntegrations.id, id), eq(virtIntegrations.orgId, p.orgId)))
        .returning();
      if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Integration not found' });
      await this.record(p, meta, 'virt.integration_delete', { type: 'virt_integration', id }, { name: rows[0]!.name }, tx);
      return { ok: true };
    });
  }

  async syncNow(p: Principal, id: string, meta: RequestMeta) {
    const rows = await this.db
      .update(virtIntegrations)
      .set({ nextSyncAt: new Date() })
      .where(and(eq(virtIntegrations.id, id), eq(virtIntegrations.orgId, p.orgId)))
      .returning({ id: virtIntegrations.id });
    if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Integration not found' });
    await this.record(p, meta, 'virt.sync_requested', { type: 'virt_integration', id });
    return { ok: true, message: 'The worker will sync within 30 seconds' };
  }

  async hosts(p: Principal, integrationId?: string) {
    const r = await this.db.execute(sql`
      select h.*, i.name as integration_name, i.kind as integration_kind, coalesce(d.hostname, d.asset_tag) as device_name,
             (select count(*)::int from virt_guests g where g.host_id = h.id and g.missing_since is null) as guests
        from virt_hosts h join virt_integrations i on i.id = h.integration_id left join devices d on d.id = h.device_id
       where h.org_id = ${p.orgId} ${integrationId ? sql`and h.integration_id = ${integrationId}` : sql``}
       order by i.name, h.name`);
    // Live readings (every 5 s while watched) replace the ones stored at the last sync when they are fresh.
    const integrationIds = [...new Set((r.rows as Record<string, unknown>[]).map((h) => String(h.integration_id)))];
    const live = new Map<string, { at: string; hosts: Record<string, { cpuPct: number | null; memUsed: number | null; memTotal: number | null }>; error?: string }>();
    try {
      if (integrationIds.length) {
        if (this.redis.status === 'wait') await this.redis.connect();
        const vals = await this.redis.mget(...integrationIds.map(virtLiveKey));
        vals.forEach((v, k) => v && live.set(integrationIds[k]!, JSON.parse(v)));
      }
    } catch {
      /* stored values only */
    }
    return (r.rows as Record<string, unknown>[]).map((h) => {
      const snap = live.get(String(h.integration_id));
      const fresh = snap && Date.now() - new Date(snap.at).getTime() < 20_000 ? snap : null;
      const now = fresh?.hosts[String(h.external_id)];
      return {
        id: h.id,
        integrationId: h.integration_id,
        integrationName: h.integration_name,
        integrationKind: h.integration_kind,
        externalId: h.external_id,
        name: h.name,
        status: h.status,
        cpuPct: h.cpu_pct,
        cpus: h.cpus,
        memUsed: h.mem_used === null ? null : Number(h.mem_used),
        memTotal: h.mem_total === null ? null : Number(h.mem_total),
        uptimeSeconds: h.uptime_seconds === null ? null : Number(h.uptime_seconds),
        deviceId: h.device_id ?? null,
        deviceName: h.device_name ?? null,
        guests: h.guests,
        lastSeenAt: h.last_seen_at,
        missingSince: h.missing_since,
        /** When the CPU / memory below were read live (null: values from the last sync). */
        liveAt: now ? fresh!.at : null,
        liveError: fresh?.error ?? null,
        ...(now ? { cpuPct: now.cpuPct ?? (h.cpu_pct as number | null), memUsed: now.memUsed ?? (h.mem_used === null ? null : Number(h.mem_used)), memTotal: now.memTotal ?? (h.mem_total === null ? null : Number(h.mem_total)) } : {}),
      };
    });
  }

  async mapHost(p: Principal, id: string, deviceId: string | null, meta: RequestMeta) {
    if (deviceId) await this.device(p, deviceId, { customerAllowed: false });
    const rows = await this.db
      .update(virtHosts)
      .set({ deviceId })
      .where(and(eq(virtHosts.id, id), eq(virtHosts.orgId, p.orgId)))
      .returning({ id: virtHosts.id });
    if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Host not found' });
    await this.record(p, meta, 'virt.host_map', { type: 'virt_host', id }, { deviceId });
    return { ok: true };
  }

  async guests(p: Principal, q: z.infer<typeof guestListQuerySchema>) {
    const staff = p.userType === 'staff';
    // Scope (who and where) is shared by the list and the filter counts; the facet filters come on top.
    const scope: SQL[] = [sql`g.org_id = ${p.orgId}`];
    if (!staff) scope.push(p.customerId ? sql`g.customer_id = ${p.customerId}` : sql`false`);
    if (q.integrationId) scope.push(sql`g.integration_id = ${q.integrationId}`);
    if (q.hostId) scope.push(sql`g.host_id = ${q.hostId}`);
    if (q.kind) scope.push(sql`exists (select 1 from virt_integrations k where k.id = g.integration_id and k.kind = ${q.kind})`);
    if (staff && q.customerId) scope.push(q.customerId === 'own' ? sql`g.customer_id is null` : sql`g.customer_id = ${q.customerId}`);
    if (q.q) scope.push(sql`(g.name ilike ${'%' + q.q + '%'} or g.external_id = ${q.q} or ${q.q} = any(g.ip_addresses) or g.os_name ilike ${'%' + q.q + '%'})`);
    const statusCond = !q.status
      ? null
      : q.status === 'missing'
        ? sql`g.missing_since is not null`
        : q.status === 'unknown'
          ? sql`g.missing_since is null and (g.status is null or g.status = 'unknown')`
          : sql`g.missing_since is null and g.status = ${q.status}`;
    const typeCond = q.virtType ? sql`g.virt_type = ${q.virtType}` : null;
    const osCond = q.osName ? (q.osName === 'none' ? sql`g.os_name is null` : sql`g.os_name = ${q.osName}`) : null;
    // Virtualizor's monthly bandwidth against the plan limit (0 = unlimited, never "over").
    if (q.bandwidth) scope.push(sql`g.bw_limit_gb > 0 and g.bw_used_gb >= g.bw_limit_gb * ${q.bandwidth === 'over100' ? 1 : 0.8}`);
    const hours = { '24h': 24, '7d': 168, '30d': 720 }[q.trafficRange];
    // Traffic measured from the routers' flow records (hourly totals) for the VM's addresses.
    const traffic = sql`left join lateral (
          select coalesce(sum(t.in_bytes), 0)::float8 as in_b, coalesce(sum(t.out_bytes), 0)::float8 as out_b
            from ip_traffic_1h t
           where t.org_id = g.org_id and t.bucket >= date_trunc('hour', now()) - make_interval(hours => ${hours})
             and t.address = any(select cdcim_try_inet(x) from unnest(g.ip_addresses) x)) tr on true`;
    const all = (...extra: (SQL | null)[]) => sql.join([...scope, ...extra.filter((x): x is SQL => !!x)], sql` and `);
    const conds = [...scope, ...[statusCond, typeCond, osCond].filter((x): x is SQL => !!x)];
    const dir = q.dir === 'desc' ? sql`desc` : sql`asc`;
    const order = {
      name: sql`g.name ${dir}`,
      status: sql`case when g.missing_since is not null then 'zz' else coalesce(g.status, 'unknown') end ${dir}, g.name`,
      cpus: sql`g.cpus ${dir} nulls last, g.name`,
      memory: sql`g.mem_bytes ${dir} nulls last, g.name`,
      disk: sql`g.disk_bytes ${dir} nulls last, g.name`,
      server: sql`h.name ${dir} nulls last, g.name`,
      customer: sql`c.name ${dir} nulls first, g.name`,
      bandwidth: sql`g.bw_used_gb ${dir} nulls last, g.name`,
      traffic: sql`(tr.in_b + tr.out_b) ${dir}, g.name`,
    }[q.sort];
    // VMs no longer reported always come last, whatever the sort.
    // Counts for the filter controls: each facet counted with the other filters applied, not its own.
    const [statusFacet, typeFacet, osFacet] = await Promise.all([
      this.db.execute<{ k: string; n: number }>(
        sql`select case when g.missing_since is not null then 'missing' else coalesce(nullif(g.status, ''), 'unknown') end as k, count(*)::int as n from virt_guests g where ${all(typeCond, osCond)} group by 1`,
      ),
      this.db.execute<{ k: string; n: number }>(sql`select g.virt_type as k, count(*)::int as n from virt_guests g where ${all(statusCond, osCond)} and g.virt_type is not null group by 1 order by 1`),
      this.db.execute<{ k: string | null; n: number }>(sql`select g.os_name as k, count(*)::int as n from virt_guests g where ${all(statusCond, typeCond)} group by 1 order by 1 nulls last limit 300`),
    ]);
    const where = sql.join(conds, sql` and `);
    const [rows, total] = await Promise.all([
      this.db.execute(sql`
        select g.*, h.name as host_name, i.name as integration_name, i.kind as integration_kind, i.actions_enabled, c.name as customer_name, tr.in_b, tr.out_b,
               (select j.status from provisioning_jobs j where j.guest_id = g.id and j.status in ('queued','running','waiting','verifying','recovery') limit 1) as active_job
          from virt_guests g join virt_integrations i on i.id = g.integration_id left join virt_hosts h on h.id = g.host_id left join customers c on c.id = g.customer_id
          ${traffic}
         where ${where} order by (g.missing_since is not null), ${order} limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
      this.db.execute<{ n: number }>(sql`select count(*)::int as n from virt_guests g where ${where}`),
    ]);
    return {
      items: (rows.rows as Record<string, unknown>[]).map((g) => ({
        id: g.id,
        integrationId: staff ? g.integration_id : null,
        integrationName: staff ? g.integration_name : null,
        integrationKind: g.integration_kind,
        externalId: g.external_id,
        virtType: g.virt_type,
        name: g.name,
        status: g.status,
        cpus: g.cpus,
        memBytes: g.mem_bytes === null ? null : Number(g.mem_bytes),
        diskBytes: g.disk_bytes === null ? null : Number(g.disk_bytes),
        uptimeSeconds: g.uptime_seconds === null ? null : Number(g.uptime_seconds),
        ipAddresses: g.ip_addresses,
        osName: g.os_name ?? null,
        /** As the hypervisor counts it, this billing month (GB). */
        bandwidth: g.bw_used_gb === null && g.bw_limit_gb === null ? null : { usedGb: g.bw_used_gb === null ? null : Number(g.bw_used_gb), limitGb: g.bw_limit_gb === null ? null : Number(g.bw_limit_gb) },
        /** Measured from flow records for the VM's addresses over trafficRange. */
        traffic: { inBytes: Number(g.in_b ?? 0), outBytes: Number(g.out_b ?? 0) },
        hostId: staff ? (g.host_id ?? null) : null,
        hostName: staff ? g.host_name : null,
        customerId: g.customer_id ?? null,
        customerName: staff ? (g.customer_name ?? null) : null,
        actionsEnabled: g.actions_enabled,
        activeJob: g.active_job ?? null,
        lastSeenAt: g.last_seen_at,
        missingSince: g.missing_since,
      })),
      page: q.page,
      pageSize: q.pageSize,
      total: total.rows[0]?.n ?? 0,
      trafficRange: q.trafficRange,
      facets: { status: Object.fromEntries(statusFacet.rows.map((x) => [x.k, x.n])), virtType: typeFacet.rows.map((x) => ({ value: x.k, count: x.n })), osName: osFacet.rows.map((x) => ({ value: x.k ?? 'none', count: x.n })) },
    };
  }

  async assignGuest(p: Principal, id: string, customerId: string | null, meta: RequestMeta) {
    if (customerId) {
      const [c] = await this.db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.orgId, p.orgId)));
      if (!c) throw new BadRequestException({ error: 'invalid_customer', message: 'Customer does not exist' });
    }
    const rows = await this.db
      .update(virtGuests)
      .set({ customerId })
      .where(and(eq(virtGuests.id, id), eq(virtGuests.orgId, p.orgId)))
      .returning({ id: virtGuests.id, name: virtGuests.name });
    // Addresses recorded from the hypervisor for this VM follow its customer (addresses entered by a person are not touched).
    if (rows.length)
      await this.db.execute(sql`update ip_addresses set customer_id = ${customerId}, updated_at = now() where org_id = ${p.orgId} and guest_id = ${id} and source = 'hypervisor' and status <> 'released'`).catch(() => undefined);
    if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'VM not found' });
    await this.record(p, meta, 'virt.guest_assign', { type: 'virt_guest', id }, { customerId, name: rows[0]!.name });
    return { ok: true };
  }

  async guestAction(p: Principal, id: string, input: { action: GuestAction; confirm: string }, idem: string | undefined, meta: RequestMeta) {
    const [g] = await this.db
      .select()
      .from(virtGuests)
      .where(and(eq(virtGuests.id, id), eq(virtGuests.orgId, p.orgId)));
    if (!g || (p.userType !== 'staff' && g.customerId !== p.customerId)) throw new NotFoundException({ error: 'not_found', message: 'VM not found' });
    if (g.missingSince) throw new ConflictException({ error: 'vm_missing', message: 'The hypervisor no longer reports this VM' });
    const [i] = await this.db.select().from(virtIntegrations).where(eq(virtIntegrations.id, g.integrationId));
    if (!i?.enabled || !i.actionsEnabled) throw new ForbiddenException({ error: 'actions_disabled', message: 'VM actions are not enabled for this hypervisor' });
    // Virtualizor's suspend/unsuspend is the panel's administrative suspension (e.g. for non-payment), not a VM pause.
    if (i.kind === 'virtualizor' && (input.action === 'suspend' || input.action === 'resume'))
      throw new BadRequestException({ error: 'action_unsupported', message: 'Suspend and resume are administrative actions in Virtualizor; use the panel' });
    if (!ProvisioningService.confirmMatches(input.confirm, [g.name, g.externalId])) throw new BadRequestException({ error: 'confirmation_mismatch', message: `Type the VM's name (${g.name}) to confirm` });
    const r = await this.createJob(p, { kind: 'guest_action', guestId: g.id, params: { action: input.action, vm: g.name } }, idem, { op: 'guest', id, action: input.action }, meta, 'virt.guest_action', { action: input.action, vm: g.name });
    return { ...ProvisioningService.publicJob(r.job), replayed: r.replayed };
  }

  /** A staff member's view of one VM plus its integration, for reinstalls. */
  private async reinstallTarget(p: Principal, id: string) {
    if (p.userType !== 'staff') throw new ForbiddenException({ error: 'forbidden', message: 'Only staff can reinstall VMs' });
    const [g] = await this.db
      .select()
      .from(virtGuests)
      .where(and(eq(virtGuests.id, id), eq(virtGuests.orgId, p.orgId)));
    if (!g) throw new NotFoundException({ error: 'not_found', message: 'VM not found' });
    const [i] = await this.db.select().from(virtIntegrations).where(eq(virtIntegrations.id, g.integrationId));
    if (!i) throw new NotFoundException({ error: 'not_found', message: 'VM not found' });
    return { g, i };
  }

  /**
   * OS templates this VM can be reinstalled with: the hypervisor's installed
   * templates from the last sync, those for the VM's virtualization type first.
   */
  async guestTemplates(p: Principal, id: string) {
    const { g, i } = await this.reinstallTarget(p, id);
    const all = (i.templates ?? []) as VirtTemplate[];
    const t = (g.virtType ?? '').toLowerCase();
    const matching = all.filter((x) => (x.type ?? '').toLowerCase() === t);
    return {
      supported: i.kind === 'virtualizor',
      actionsEnabled: i.enabled && i.actionsEnabled,
      currentOs: g.osName,
      synced: i.templates !== null,
      // When the panel's template types don't name this VM's type, all are offered and the panel decides.
      items: matching.length ? matching : all,
      matchedType: matching.length > 0,
    };
  }

  async reinstallGuest(p: Principal, id: string, input: z.infer<typeof guestReinstallSchema>, idem: string | undefined, meta: RequestMeta) {
    const { g, i } = await this.reinstallTarget(p, id);
    if (i.kind !== 'virtualizor') throw new BadRequestException({ error: 'action_unsupported', message: 'Reinstall is offered for Virtualizor VMs' });
    if (g.missingSince) throw new ConflictException({ error: 'vm_missing', message: 'The hypervisor no longer reports this VM' });
    if (!i.enabled || !i.actionsEnabled) throw new ForbiddenException({ error: 'actions_disabled', message: 'VM actions are not enabled for this hypervisor' });
    const tpl = ((i.templates ?? []) as VirtTemplate[]).find((x) => x.osid === input.osid);
    if (!tpl) throw new BadRequestException({ error: 'invalid_template', message: 'That OS template is not installed on the hypervisor (as of the last sync)' });
    if (!ProvisioningService.confirmMatches(input.confirm, [g.name, g.externalId])) throw new BadRequestException({ error: 'confirmation_mismatch', message: `Type the VM's name (${g.name}) to confirm` });
    const jobId = randomUUID();
    const params = { osid: tpl.osid, osName: tpl.name, vm: g.name, osBefore: g.osName, formatPrimaryOnly: input.formatPrimaryOnly };
    const r = await this.createJob(
      p,
      { id: jobId, kind: 'guest_reinstall', guestId: g.id, params, secretEnc: this.secrets.encrypt(JSON.stringify({ password: input.password }), jobContext(p.orgId, jobId)) },
      idem,
      // Same request = same template and password; only a hash of the password is compared.
      { op: 'reinstall', id, osid: tpl.osid, formatPrimaryOnly: input.formatPrimaryOnly, password: createHash('sha256').update(input.password).digest('hex') },
      meta,
      'virt.guest_reinstall',
      { vm: g.name, os: tpl.name, osBefore: g.osName },
    );
    return { ...ProvisioningService.publicJob(r.job), replayed: r.replayed };
  }

  async summary(p: Principal) {
    const r = await this.db.execute<{ status: string; n: number }>(sql`
      select case when status = 'completed' and (result->>'verified')::boolean is false then 'unverified' else status::text end as status, count(*)::int as n
        from provisioning_jobs where org_id = ${p.orgId} and (status in ('queued','running','waiting','verifying','recovery') or finished_at > now() - interval '7 days') group by 1`);
    const by = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
    return { active: ['queued', 'running', 'waiting', 'verifying'].reduce((a, k) => a + (by[k] ?? 0), 0), recovery: by.recovery ?? 0, completed7d: by.completed ?? 0, unverified7d: by.unverified ?? 0, failed7d: by.failed ?? 0 };
  }
}
