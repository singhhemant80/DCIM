import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { provisioningJobs, pxeSettings } from '../../db/schema';
import { pxeDesiredSchema, type PxeDesired } from '../../provisioning/pxe/render';

/**
 * Keeps the PXE service in step with NexoraDC: writes the desired state
 * (settings + MACs of servers whose network install is active) for the root
 * helper to apply, and copies the helper's status back to the settings row
 * shown in the UI. One organization's settings drive the service (the first
 * enabled one); a second enabled organization is reported, not merged.
 */
export interface PxeLoopDeps {
  db: Db;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  pxeDir: string;
  outDir: string;
  publicUrl?: string | null;
}

const ACTIVE = ['queued', 'running', 'waiting', 'verifying', 'recovery'] as const;

export async function buildDesired(db: Db, publicUrl?: string | null): Promise<{ desired: PxeDesired; orgId: string | null; extraOrgs: number }> {
  const rows = (await db.select().from(pxeSettings).orderBy(pxeSettings.orgId)).filter((r) => r.enabled);
  const s = rows[0];
  if (!s) return { desired: { version: 1, enabled: false, mode: 'proxy', interface: null, serverAddress: '0.0.0.0', proxyNetworks: [], ranges: [], bootBase: 'http://0.0.0.0', macs: [] }, orgId: null, extraOrgs: 0 };
  const jobs = await db
    .select({ mac: provisioningJobs.bootMac })
    .from(provisioningJobs)
    .where(and(eq(provisioningJobs.orgId, s.orgId), eq(provisioningJobs.kind, 'os_install'), inArray(provisioningJobs.status, [...ACTIVE]), isNotNull(provisioningJobs.bootMac), sql`${provisioningJobs.params}->>'method' = 'pxe'`));
  // iPXE has no HTTPS in NexoraDC's build: boot traffic uses http:// on the same host (nginx serves /api/v1/boot on port 80).
  const base = (s.bootBaseUrl || publicUrl || `http://${s.serverAddress}`).replace(/^https:/, 'http:').replace(/\/$/, '');
  const desired: PxeDesired = {
    version: 1,
    enabled: true,
    mode: s.mode as PxeDesired['mode'],
    interface: s.interface ?? null,
    serverAddress: s.serverAddress,
    proxyNetworks: (s.proxyNetworks ?? []).filter((c) => c.includes('.')),
    ranges: (s.ranges ?? []).map((r) => ({ network: r.network, start: r.start, end: r.end, gateway: r.gateway ?? null, dns: r.dns ?? [] })),
    bootBase: base,
    macs: jobs.map((j) => j.mac!).filter(Boolean),
  };
  return { desired, orgId: s.orgId, extraOrgs: rows.length - 1 };
}

export interface PxeStatus {
  at?: string;
  ok?: boolean;
  error?: string | null;
  macs?: string[];
  mode?: string;
}

/** The PXE helper's last report (null when it has not run yet). */
export async function readPxeStatus(outDir: string | undefined): Promise<PxeStatus | null> {
  if (!outDir) return null;
  return fs
    .readFile(join(outDir, 'status.json'), 'utf8')
    .then((t) => JSON.parse(t) as PxeStatus)
    .catch(() => null);
}

export function createPxeLoop(deps: PxeLoopDeps) {
  let last = '';
  let lastStatus = '';
  return async function tick() {
    const { desired, orgId, extraOrgs } = await buildDesired(deps.db, deps.publicUrl);
    const check = pxeDesiredSchema.safeParse(desired);
    if (!check.success) {
      if (orgId) await deps.db.update(pxeSettings).set({ applyError: `The settings cannot be applied (${check.error.issues.map((i) => i.path.join('.')).join(', ')})` }).where(eq(pxeSettings.orgId, orgId));
      return;
    }
    const body = JSON.stringify(desired, null, 2);
    if (body !== last) {
      await fs.mkdir(deps.pxeDir, { recursive: true });
      const file = join(deps.pxeDir, 'desired.json');
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, body, { mode: 0o644 });
      await fs.rename(tmp, file);
      last = body;
    }
    if (!orgId) return;
    // The helper's report (written as root into its own directory).
    const st = await readPxeStatus(deps.outDir);
    const error = !st
      ? 'Waiting for the PXE service helper (crapplet-dcim-pxe-apply) to apply the settings; if this stays, re-run the NexoraDC installer'
      : st.ok === false
        ? (st.error ?? 'The PXE service is not running')
        : extraOrgs > 0
          ? 'Another organization also enabled the PXE service; only one set of settings is used'
          : null;
    const key = `${orgId}|${st?.at ?? ''}|${error ?? ''}`;
    if (key === lastStatus) return;
    lastStatus = key;
    await deps.db
      .update(pxeSettings)
      .set({ appliedAt: st?.at ? new Date(st.at) : null, applyError: error })
      .where(eq(pxeSettings.orgId, orgId));
  };
}
