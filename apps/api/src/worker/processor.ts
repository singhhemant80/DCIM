import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { CredentialKind } from '@crapplet/shared';
import type { Db } from '../db/db';
import { deviceCredentials, discoveryRuns, type DiscoveryChanges } from '../db/schema';
import type { SecretBox } from '../common/secret-box';
import { credentialContext, type Adapter, type AdapterTarget, type DiscoveryResult } from '../network/discovery/types';
import { snmpAdapter } from './adapters/snmp';
import { routerOsAdapter } from './adapters/routeros';
import { fortiOsAdapter } from './adapters/fortios';
import { nxApiAdapter } from './adapters/nxapi';
import { routerOsApiAdapter } from './adapters/routeros-api';
import { redfishAdapter } from './adapters/redfish';
import { ipmiAdapter } from './adapters/ipmi';

export interface WorkerDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  adapters?: Partial<Record<CredentialKind, Adapter>>;
  /** Hard ceiling for one run, on top of the per-request timeouts. */
  runTimeoutMs?: number;
  /** Computes how a finished discovery differs from inventory (stored on the run to flag the device). */
  changes?: (orgId: string, deviceId: string, result: DiscoveryResult) => Promise<DiscoveryChanges>;
}

export function defaultAdapters(): Record<CredentialKind, Adapter> {
  return {
    snmp_v2c: snmpAdapter('snmp_v2c'),
    snmp_v3: snmpAdapter('snmp_v3'),
    routeros_rest: routerOsAdapter(),
    fortios_rest: fortiOsAdapter(),
    nxapi: nxApiAdapter(),
    routeros_api: routerOsApiAdapter(),
    redfish: redfishAdapter(),
    ipmi: ipmiAdapter(),
  };
}

/** Removes any secret value that might have been echoed back in an error message. */
export function redact(message: string, secret: Record<string, unknown>): string {
  let m = message;
  for (const v of Object.values(secret)) {
    if (typeof v === 'string' && v.length >= 3) m = m.split(v).join('[redacted]');
  }
  return m.slice(0, 500);
}

/**
 * Executes one discovery run. Called by the BullMQ worker (and directly by
 * tests). This is the only code that decrypts device credentials; the
 * decrypted values live only in this function's scope and are never logged.
 */
export async function processRun(deps: WorkerDeps, runId: string): Promise<void> {
  const { db } = deps;
  // Claim the run atomically; a duplicate delivery finds it no longer queued.
  const [run] = await db
    .update(discoveryRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(discoveryRuns.id, runId), eq(discoveryRuns.status, 'queued')))
    .returning();
  if (!run) return;
  let secret: Record<string, unknown> = {};
  const finish = async (status: 'succeeded' | 'failed', patch: { result?: Record<string, unknown>; error?: string; changes?: DiscoveryChanges | null }) => {
    // A run the API already declared stale stays failed.
    await db
      .update(discoveryRuns)
      .set({ status, finishedAt: new Date(), result: patch.result ?? null, error: patch.error ?? null, changes: patch.changes ?? null })
      .where(and(eq(discoveryRuns.id, run.id), eq(discoveryRuns.status, 'running')));
  };
  try {
    const [cred] = await db.select().from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, run.deviceId), eq(deviceCredentials.kind, run.credentialKind)));
    if (!cred) return await finish('failed', { error: 'The credential was removed before the run started' });
    // Only the host saved together with the secret is ever contacted (it is bound into the ciphertext).
    const host = cred.host;
    if (!host) return await finish('failed', { error: 'The credential has no stored host; enter it again' });
    try {
      secret = JSON.parse(deps.secrets.decrypt(cred.secretEnc, credentialContext(cred.orgId, cred.deviceId, cred.kind, host, cred.port))) as Record<string, unknown>;
    } catch {
      return await finish('failed', { error: 'The stored credential could not be decrypted (its host or port was changed, or the encryption key changed). Enter it again.' });
    }
    const adapter = (deps.adapters ?? defaultAdapters())[run.credentialKind];
    if (!adapter) return await finish('failed', { error: `No adapter for ${run.credentialKind}` });
    const target: AdapterTarget = { host, port: cred.port, username: cred.username, params: cred.params, secret: secret as AdapterTarget['secret'] };
    const limit = deps.runTimeoutMs ?? 120_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`Run exceeded ${Math.round(limit / 1000)} s`)), limit)));
    try {
      if (run.mode === 'test') {
        const r = await Promise.race([adapter.test(target), timeout]);
        await db.update(deviceCredentials).set({ lastTestAt: new Date(), lastTestOk: r.ok, lastTestMessage: redact(r.message, secret) }).where(eq(deviceCredentials.id, cred.id));
        await finish(r.ok ? 'succeeded' : 'failed', { result: { ...r, message: redact(r.message, secret) } as unknown as Record<string, unknown>, error: r.ok ? undefined : redact(r.message, secret) });
      } else {
        const r = await Promise.race([adapter.discover(target), timeout]);
        r.warnings = r.warnings.map((w) => redact(w, secret));
        await db.update(deviceCredentials).set({ lastTestAt: new Date(), lastTestOk: true, lastTestMessage: `Discovery collected ${r.interfaces.length} interfaces` }).where(eq(deviceCredentials.id, cred.id));
        let changes: DiscoveryChanges | null = null;
        try {
          changes = deps.changes ? await deps.changes(run.orgId, run.deviceId, r) : null;
        } catch (e) {
          deps.logger.warn({ runId: run.id, err: (e as Error).message }, 'could not compute discovery changes');
        }
        await finish('succeeded', { result: r as unknown as Record<string, unknown>, changes });
      }
      deps.logger.info({ runId: run.id, deviceId: run.deviceId, kind: run.credentialKind, mode: run.mode }, 'discovery run finished');
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const message = redact((err as Error)?.message || 'Unknown error', secret);
    deps.logger.warn({ runId: run.id, deviceId: run.deviceId, kind: run.credentialKind, err: message }, 'discovery run failed');
    await db.update(deviceCredentials).set({ lastTestAt: new Date(), lastTestOk: false, lastTestMessage: message }).where(and(eq(deviceCredentials.deviceId, run.deviceId), eq(deviceCredentials.kind, run.credentialKind)));
    await finish('failed', { error: message });
  } finally {
    secret = {};
  }
}

/** Marks runs that were in flight when a worker died as failed (called on worker start). */
export async function failOrphanedRuns(db: Db): Promise<number> {
  const res = await db.update(discoveryRuns).set({ status: 'failed', finishedAt: new Date(), error: 'The worker restarted while this run was in progress' }).where(sql`${discoveryRuns.status} = 'running'`).returning({ id: discoveryRuns.id });
  return res.length;
}
