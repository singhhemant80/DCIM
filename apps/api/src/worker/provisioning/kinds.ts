import { createHash } from 'node:crypto';
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { eq, sql } from 'drizzle-orm';
import { POWER_ACTION_LABELS, GUEST_ACTION_LABELS, type GuestAction, type PowerAction } from '@crapplet/shared';
import { controlCredentials, deviceEvents, devices, osImages, virtGuests, virtHosts, virtIntegrations, type ControlCredential, type OsImage, type VirtIntegration } from '../../db/schema';
import type { AdapterTarget } from '../../network/discovery/types';
import { AuditService } from '../../audit/audit.service';
import { controlContext, GUEST_TARGET_STATUS, virtContext } from '../../provisioning/contexts';
import { redact } from '../processor';
import { PermanentError, type EngineDeps, type KindDef, type StepContext, type StepDef } from './engine';
import { ipmiControl, redfishControl, type BmcControl } from './bmc';
import { proxmoxClient, virtualizorClient, type VirtClient } from './virt';

export interface ProvisioningDeps extends EngineDeps {
  publicUrl?: string;
  /** Overridable in tests. */
  makeBmc?: (cred: ControlCredential, target: AdapterTarget) => BmcControl;
  makeVirt?: (i: VirtIntegration, secret: Record<string, unknown>) => VirtClient;
  tcpCheck?: (host: string, port: number) => Promise<boolean>;
  /** Poll intervals (shortened in tests). */
  pollMs?: number;
  /** Allow image URLs on loopback/link-local addresses (CDCIM_IMAGE_ALLOW_LOCAL). */
  imageAllowLocal?: boolean;
}

const D = (ctx: StepContext) => ctx.deps as ProvisioningDeps;
const poll = (ctx: StepContext, ms: number) => D(ctx).pollMs ?? ms;

/* ------------------------------------------------------------------ BMC access */

async function bmcFor(ctx: StepContext): Promise<{ bmc: BmcControl; kind: 'redfish' | 'ipmi'; scrub: (m: string) => string }> {
  const deps = D(ctx);
  if (!ctx.job.deviceId) throw new PermanentError('The job has no device');
  const [cred] = await deps.db.select().from(controlCredentials).where(eq(controlCredentials.deviceId, ctx.job.deviceId));
  if (!cred) throw new PermanentError('No control credential is stored for this device (Server Provisioning needs a BMC account that can change power and boot settings)');
  let secret: Record<string, unknown>;
  try {
    secret = JSON.parse(deps.secrets.decrypt(cred.secretEnc, controlContext(cred.orgId, cred.deviceId, cred.kind, cred.host, cred.port))) as Record<string, unknown>;
  } catch {
    throw new PermanentError('The stored control credential could not be decrypted; enter it again');
  }
  const target: AdapterTarget = { host: cred.host, port: cred.port, username: cred.username, params: cred.params, secret: secret as AdapterTarget['secret'] };
  const bmc = deps.makeBmc ? deps.makeBmc(cred, target) : cred.kind === 'redfish' ? redfishControl(target) : ipmiControl(target);
  // Every BMC error leaving this module is scrubbed of the secret.
  const scrub = (m: string) => redact(m, secret);
  const wrapped = Object.fromEntries(
    Object.entries(bmc).map(([k, fn]) => [
      k,
      async (...a: unknown[]) => {
        try {
          return await (fn as (...x: unknown[]) => Promise<unknown>)(...a);
        } catch (e) {
          const msg = scrub((e as Error)?.message || 'BMC error');
          throw e instanceof PermanentError ? new PermanentError(msg) : new Error(msg);
        }
      },
    ]),
  ) as unknown as BmcControl;
  return { bmc: wrapped, kind: cred.kind, scrub };
}

const expectedState = (a: PowerAction) => (a === 'off' || a === 'graceful_shutdown' ? 'off' : 'on');

/* ------------------------------------------------------------------ power action */

export const powerActionKind: KindDef = {
  steps: (job) => {
    const action = String(job.params.action) as PowerAction;
    const repeatable = action === 'on' || action === 'off' || action === 'graceful_shutdown';
    return [
      {
        name: 'Check BMC access',
        safeToRepeat: true,
        run: async (ctx) => {
          const { bmc } = await bmcFor(ctx);
          ctx.state.initial = await bmc.powerState();
          // A failed read is retried (this step is safe to repeat) rather than silently treated as "no marker".
          if (bmc.bootMarker) ctx.state.bootMarker = await bmc.bootMarker();
          return { done: true, detail: `Power is ${String(ctx.state.initial)}` };
        },
      },
      {
        name: POWER_ACTION_LABELS[action] ?? action,
        safeToRepeat: repeatable,
        run: async (ctx) => {
          const { bmc } = await bmcFor(ctx);
          const now = await bmc.powerState();
          if ((action === 'on' && now === 'on') || ((action === 'off' || action === 'graceful_shutdown') && now === 'off')) return { done: true, detail: `Already ${now}; nothing sent` };
          if ((action === 'restart' || action === 'graceful_restart') && now === 'off') throw new PermanentError('The server is off; power it on instead of restarting');
          await bmc.power(action);
          ctx.state.sentAt = ctx.now().toISOString();
          return { done: true, detail: 'Sent to the BMC' };
        },
      },
      {
        name: 'Verify power state',
        safeToRepeat: true,
        run: async (ctx) => {
          const { bmc } = await bmcFor(ctx);
          const want = expectedState(action);
          const limitMs = action.startsWith('graceful') ? 300_000 : 120_000;
          ctx.state.verifyFrom ??= ctx.now().toISOString();
          const s = await bmc.powerState();
          const reset = ['restart', 'graceful_restart', 'power_cycle'].includes(action) && ctx.state.initial === 'on';
          if (s === want && reset && ctx.state.bootMarker) {
            // The BMC reports boots: success means a new boot was seen, not just "still on".
            const now = bmc.bootMarker ? await bmc.bootMarker().catch(() => null) : null;
            if (now && now !== ctx.state.bootMarker) return { done: true, detail: `The server booted again (${now}) and is on` };
          } else if (s === want) {
            if (!reset) return { done: true, detail: `The BMC reports the server ${s}` };
            // Without a boot marker a reset cannot be observed from the power state (it stays "on"). Say so; never call it verified.
            ctx.state.unverified = 'this BMC does not report boots, so the restart itself could not be observed; the server is on';
            return { done: true, detail: 'The BMC accepted the reset and reports the server on; the restart itself could not be observed' };
          }
          if (ctx.now().getTime() - new Date(String(ctx.state.verifyFrom)).getTime() > limitMs)
            throw new PermanentError(
              (s === want && reset ? `The BMC reported no new boot within ${limitMs / 1000} s (the server is still on)` : `The server did not reach “${want}” within ${limitMs / 1000} s (BMC says ${s})`) +
                (action.startsWith('graceful') ? '; the operating system may have ignored the ACPI request' : ''),
            );
          return { wait: poll(ctx, 5000), status: 'verifying', detail: `Waiting for ${want} (now ${s})` };
        },
      },
    ];
  },
  async onCompleted(ctx) {
    return ctx.state.unverified ? { verified: false, note: String(ctx.state.unverified) } : { verified: true };
  },
};

/* ------------------------------------------------------------------ OS install */

/** Files pinned when the job was created (older jobs fall back to the image row). */
type Files = Pick<OsImage, 'isoUrl' | 'isoSha256' | 'kernelUrl' | 'kernelSha256' | 'initrdUrl' | 'initrdSha256'>;
const filesOf = (ctx: StepContext, img: OsImage): Files => (ctx.job.params.files as Files | undefined) ?? img;

async function imageOf(ctx: StepContext): Promise<OsImage> {
  if (!ctx.job.imageId) throw new PermanentError('The image was deleted');
  const [img] = await D(ctx).db.select().from(osImages).where(eq(osImages.id, ctx.job.imageId));
  if (!img) throw new PermanentError('The image was deleted');
  return img;
}

function defaultTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 5000 });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('timeout', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(false));
  });
}

export const osInstallKind: KindDef = {
  steps: (job) => {
    const p = job.params as { method: 'redfish_virtual_media' | 'pxe'; verify: { by: 'callback' | 'tcp'; port?: number }; network: { mode: string; address?: string } };
    const vm = p.method === 'redfish_virtual_media';
    const steps: StepDef[] = [
      {
        name: 'Check image and settings',
        safeToRepeat: true,
        run: async (ctx) => {
          const img = await imageOf(ctx);
          if (!img.enabled) throw new PermanentError('The image is disabled');
          if (img.verifyStatus !== 'verified') throw new PermanentError(`The image is not verified (status: ${img.verifyStatus}); run its checksum verification first`);
          const f = filesOf(ctx, img);
          if ((Object.keys(f) as (keyof Files)[]).some((k) => f[k] !== img[k])) throw new PermanentError('The image’s files changed after this job was requested; request the installation again');
          if (vm && !f.isoUrl) throw new PermanentError('The image has no ISO for virtual media');
          if (!vm && (!f.kernelUrl || !f.initrdUrl)) throw new PermanentError('The image has no kernel and initrd for PXE');
          if ((!vm || img.templateKind !== 'none') && !D(ctx).publicUrl) throw new PermanentError('CDCIM_PUBLIC_URL is not set, so the installer has no address to fetch its configuration from');
          return { done: true, detail: `${img.name} (${vm ? 'ISO' : 'kernel + initrd'}), checksums verified` };
        },
      },
      {
        name: 'Check BMC access',
        safeToRepeat: true,
        run: async (ctx) => {
          const { bmc, kind } = await bmcFor(ctx);
          if (vm && kind !== 'redfish') throw new PermanentError('Virtual media needs a Redfish control credential');
          ctx.state.initialPower = await bmc.powerState();
          return { done: true, detail: `Power is ${String(ctx.state.initialPower)}` };
        },
      },
    ];
    if (vm) {
      steps.push(
        {
          name: 'Eject inserted media',
          safeToRepeat: true,
          run: async (ctx) => {
            const { bmc } = await bmcFor(ctx);
            const cur = await bmc.insertedMedia!();
            if (cur) await bmc.ejectMedia!();
            return { done: true, detail: cur ? 'Ejected the previous image' : 'Nothing inserted' };
          },
        },
        {
          name: 'Insert the ISO',
          safeToRepeat: true,
          run: async (ctx) => {
            const { bmc } = await bmcFor(ctx);
            const iso = filesOf(ctx, await imageOf(ctx)).isoUrl!;
            // Flag first: if the insert half-happens and the step fails, cleanup still ejects.
            ctx.state.mediaInserted = true;
            if ((await bmc.insertedMedia!()) !== iso) await bmc.insertMedia!(iso);
            if ((await bmc.insertedMedia!()) !== iso) throw new Error('The BMC did not report the ISO as inserted');
            return { done: true, detail: 'Virtual CD inserted' };
          },
        },
        {
          name: 'Set one-time boot from virtual CD',
          safeToRepeat: true,
          run: async (ctx) => {
            const { bmc } = await bmcFor(ctx);
            ctx.state.bootOverride = true;
            await bmc.setBootOnce('cd');
            if ((await bmc.bootOverride()) !== 'cd') throw new Error('The BMC did not keep the boot override');
            return { done: true };
          },
        },
      );
    } else {
      steps.push({
        name: 'Set one-time network boot',
        safeToRepeat: true,
        run: async (ctx) => {
          const { bmc } = await bmcFor(ctx);
          ctx.state.bootOverride = true;
          await bmc.setBootOnce('pxe');
          if ((await bmc.bootOverride()) !== 'pxe') throw new Error('The BMC did not keep the boot override');
          return { done: true };
        },
      });
    }
    steps.push({
      name: 'Start the server',
      // Restarting twice would interrupt the installer.
      safeToRepeat: false,
      run: async (ctx) => {
        const { bmc } = await bmcFor(ctx);
        const s = await bmc.powerState();
        // Powered off, the previous system can't be what answers a TCP check later.
        if (s === 'off') ctx.state.portWasDown = true;
        // Recorded before the BMC call: the boot endpoints hand out nothing until this is set, and a crash
        // right after the call must not leave a booting server without its install configuration.
        ctx.state.bootStartedAt = ctx.now().toISOString();
        await ctx.checkpoint();
        await bmc.power(s === 'off' ? 'on' : 'restart');
        return { done: true, detail: s === 'off' ? 'Powered on' : 'Restarted' };
      },
    });
    if (!vm) {
      steps.push({
        name: 'Wait for network boot',
        safeToRepeat: true,
        run: async (ctx) => {
          if (ctx.job.signals?.bootConflict) throw new PermanentError(String(ctx.job.signals.bootConflict));
          const served = ctx.job.signals?.ipxeServedAt;
          if (served) return { done: true, detail: `Boot script fetched at ${String(served)}` };
          if (ctx.now().getTime() - new Date(String(ctx.state.bootStartedAt)).getTime() > 20 * 60_000)
            throw new PermanentError('The server never fetched its boot script within 20 minutes; check that DHCP chainloads iPXE to /api/v1/boot/ipxe and that the boot NIC is the one given');
          return { wait: poll(ctx, 15_000), detail: 'Waiting for the server to fetch its iPXE script' };
        },
      });
    }
    steps.push({
      name: 'Wait for the installer',
      safeToRepeat: true,
      run: async (ctx) => {
        if (ctx.job.signals?.bootConflict) throw new PermanentError(String(ctx.job.signals.bootConflict));
        const configError = ctx.job.signals?.configError;
        if (configError) throw new PermanentError(`The install template could not be rendered: ${String(configError)}`);
        // Proof that the server actually booted from the install media: the BMC consumed the one-time override.
        if (!ctx.state.overrideConsumed) {
          const { bmc } = await bmcFor(ctx);
          if (await bmc.bootOverride()) return { wait: poll(ctx, 15_000), detail: 'Waiting for the server to boot the install media (one-time boot still pending)' };
          ctx.state.overrideConsumed = ctx.now().toISOString();
        }
        if (p.verify.by === 'callback') {
          const cb = ctx.job.signals?.callback as { status?: string; message?: string } | undefined;
          if (cb?.status === 'done') return { done: true, detail: 'The installer reported completion' };
          if (cb?.status === 'failed') throw new PermanentError(`The installer reported a failure${cb.message ? `: ${cb.message}` : ''}`);
          return { wait: poll(ctx, 30_000), detail: cb?.status === 'started' ? 'Installing (the installer has checked in)' : 'Waiting for the installer to report' };
        }
        const ok = await (D(ctx).tcpCheck ?? defaultTcp)(p.network.address!, p.verify.port ?? 22);
        // The old system may answer on the same address until the installer takes over: count only an answer after the port was seen closed.
        if (!ok) ctx.state.portWasDown = true;
        if (ok && ctx.state.portWasDown) return { done: true, detail: `${p.network.address}:${p.verify.port ?? 22} answers again after the install` };
        return { wait: poll(ctx, 30_000), detail: ok ? `${p.network.address}:${p.verify.port ?? 22} still answers (previous system); waiting for the installer to take over` : `Waiting for ${p.network.address}:${p.verify.port ?? 22} to answer` };
      },
    });
    if (vm) {
      steps.push({
        name: 'Eject the ISO',
        safeToRepeat: true,
        run: async (ctx) => {
          const { bmc } = await bmcFor(ctx);
          await bmc.ejectMedia!();
          ctx.state.mediaInserted = false;
          return { done: true };
        },
      });
    }
    steps.push({
      name: 'Verify the installed system',
      safeToRepeat: true,
      run: async (ctx) => {
        const { bmc } = await bmcFor(ctx);
        ctx.state.verifyFrom ??= ctx.now().toISOString();
        const problems: string[] = [];
        if ((await bmc.powerState()) !== 'on') problems.push('the server is not on');
        const override = await bmc.bootOverride();
        if (override) {
          await bmc.clearBootOverride();
          problems.push(`a one-time ${override} boot was still pending (cleared)`);
        }
        if (vm && (await bmc.insertedMedia!())) problems.push('the ISO is still inserted');
        if (p.verify.by === 'tcp' && !(await (D(ctx).tcpCheck ?? defaultTcp)(p.network.address!, p.verify.port ?? 22))) problems.push(`${p.network.address}:${p.verify.port ?? 22} does not answer`);
        if (!problems.length) return { done: true, detail: `Power on, no boot override${vm ? ', ISO ejected' : ''}${p.verify.by === 'callback' ? ', installer reported success' : `, ${p.network.address}:${p.verify.port ?? 22} answers`}` };
        if (ctx.now().getTime() - new Date(String(ctx.state.verifyFrom)).getTime() > 10 * 60_000) throw new PermanentError(`Verification failed: ${problems.join('; ')}`);
        return { wait: poll(ctx, 10_000), status: 'verifying', detail: problems.join('; ') };
      },
    });
    return steps;
  },
  async cleanup(ctx) {
    const { bmc } = await bmcFor(ctx);
    if (ctx.state.mediaInserted && bmc.ejectMedia) {
      await bmc.ejectMedia();
      await ctx.log('Ejected the ISO');
    }
    if (ctx.state.bootOverride) {
      await bmc.clearBootOverride();
      await ctx.log('Cleared the one-time boot override');
    }
  },
  async onCompleted(ctx) {
    const img = await imageOf(ctx);
    const host = String(ctx.job.params.hostname);
    const os = img.version && !img.name.includes(img.version) ? `${img.name} ${img.version}` : img.name;
    // Inventory follows the verified result.
    await D(ctx).db.transaction(async (tx) => {
      await tx.update(devices).set({ hostname: host, os }).where(eq(devices.id, ctx.job.deviceId!));
      // Idempotent: a worker that stopped after this point repeats it on resume.
      const seen = await tx.execute(sql`select 1 from device_events where device_id = ${ctx.job.deviceId} and kind = 'os_installed' and data->>'jobId' = ${ctx.job.id}`);
      if (seen.rows.length) return;
      await tx.insert(deviceEvents).values({
        orgId: ctx.job.orgId,
        deviceId: ctx.job.deviceId!,
        actorId: ctx.job.createdByUserId,
        actorLabel: ctx.job.createdBy,
        kind: 'os_installed',
        summary: `${os} installed as ${host} (verified)`,
        data: { jobId: ctx.job.id, method: String(ctx.job.params.method) },
      });
    });
    const [already] = (await D(ctx).db.execute(sql`select 1 from audit_events where action = 'provisioning.install_completed' and metadata->>'jobId' = ${ctx.job.id} limit 1`)).rows;
    if (!already) await new AuditService(D(ctx).db).record({ orgId: ctx.job.orgId, actor: { type: 'system', label: 'provisioning worker' }, action: 'provisioning.install_completed', target: { type: 'device', id: ctx.job.deviceId }, outcome: 'success', metadata: { jobId: ctx.job.id, hostname: host, os } });
    return { hostname: host, os };
  },
};

/* ------------------------------------------------------------------ image verification */

/**
 * Image files usually sit on a mirror inside the datacenter, so private ranges
 * are allowed. Loopback, link-local (including cloud metadata at
 * 169.254.169.254), unspecified and multicast addresses are refused unless the
 * worker sets CDCIM_IMAGE_ALLOW_LOCAL=true. Redirects are followed by hand so
 * every hop is checked.
 */
export function isLocalOrMetadata(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isLocalOrMetadata(x.slice(7));
    return x === '::' || x === '::1' || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

async function checkImageHost(deps: ProvisioningDeps, url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PermanentError(`Unsupported URL scheme ${url.protocol}`);
  if (deps.imageAllowLocal) return;
  const h = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [h] : (await dnsLookup(h, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`Cannot resolve ${h}`);
  if (addrs.some(isLocalOrMetadata)) throw new PermanentError(`${h} resolves to a loopback, link-local or metadata address; set CDCIM_IMAGE_ALLOW_LOCAL=true on the worker if the mirror really is local`);
}

async function hashUrl(ctx: StepContext, url: string): Promise<{ sha256: string; size: number }> {
  const deps = D(ctx);
  const ctrl = new AbortController();
  // No data for 2 minutes: give up (the step is retried) instead of holding the job.
  let stall = setTimeout(() => ctrl.abort(new Error('The download stalled (no data for 2 minutes)')), 120_000);
  const beat = setInterval(() => void ctx.heartbeat().catch(() => undefined), 20_000);
  try {
    let current = new URL(url);
    let res: Response | null = null;
    for (let hop = 0; hop <= 5; hop++) {
      await checkImageHost(deps, current);
      res = await fetch(current, { redirect: 'manual', signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current);
        res = null;
        continue;
      }
      break;
    }
    if (!res) throw new PermanentError('Too many redirects');
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${current.host}`);
    const h = createHash('sha256');
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(new Error('The download stalled (no data for 2 minutes)')), 120_000);
      size += value.length;
      if (size > 30 * 1024 ** 3) throw new PermanentError('File larger than 30 GB');
      h.update(value);
    }
    return { sha256: h.digest('hex'), size };
  } catch (e) {
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof Error) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(stall);
    clearInterval(beat);
  }
}

export const imageVerifyKind: KindDef = {
  steps: () => {
    const file = (label: string, urlKey: 'isoUrl' | 'kernelUrl' | 'initrdUrl', shaKey: 'isoSha256' | 'kernelSha256' | 'initrdSha256'): StepDef => ({
      name: `Download and check the ${label}`,
      safeToRepeat: true,
      maxAttempts: 2,
      run: async (ctx) => {
        const img = await imageOf(ctx);
        const f = filesOf(ctx, img);
        const url = f[urlKey];
        if (!url) return { done: true, detail: 'Not used by this image' };
        const r = await hashUrl(ctx, url);
        (ctx.state.sizes as Record<string, number> | undefined) ?? (ctx.state.sizes = {});
        (ctx.state.sizes as Record<string, number>)[label] = r.size;
        if (r.sha256 !== f[shaKey]) {
          await D(ctx).db.update(osImages).set({ verifyStatus: 'mismatch', verifyError: `${label}: expected ${f[shaKey]}, got ${r.sha256}` }).where(sql`${osImages.id} = ${img.id} and ${osImages.verifyStatus} = 'verifying'`);
          ctx.state.mismatch = true;
          throw new PermanentError(`The ${label} does not match its checksum (got ${r.sha256})`);
        }
        return { done: true, detail: `${(r.size / 1024 ** 2).toFixed(1)} MiB, SHA-256 matches` };
      },
    });
    return [
      file('ISO', 'isoUrl', 'isoSha256'),
      file('kernel', 'kernelUrl', 'kernelSha256'),
      file('initrd', 'initrdUrl', 'initrdSha256'),
      {
        name: 'Mark the image verified',
        safeToRepeat: true,
        run: async (ctx) => {
          // Only the files that were checked: an image edited meanwhile stays unverified.
          const f = filesOf(ctx, await imageOf(ctx));
          const r = await D(ctx).db.execute(sql`
            update os_images set verify_status = 'verified', verified_at = ${ctx.now().toISOString()}::timestamptz, verify_error = null, sizes = ${JSON.stringify(ctx.state.sizes ?? {})}::jsonb
             where id = ${ctx.job.imageId} and verify_status = 'verifying'
               and iso_url is not distinct from ${f.isoUrl} and iso_sha256 is not distinct from ${f.isoSha256}
               and kernel_url is not distinct from ${f.kernelUrl} and kernel_sha256 is not distinct from ${f.kernelSha256}
               and initrd_url is not distinct from ${f.initrdUrl} and initrd_sha256 is not distinct from ${f.initrdSha256}
            returning id`);
          if (!r.rows.length) throw new PermanentError('The image changed while it was being verified; verify it again');
          return { done: true };
        },
      },
    ];
  },
  async cleanup(ctx) {
    if (!ctx.state.mismatch && ctx.job.imageId) await D(ctx).db.update(osImages).set({ verifyStatus: 'error', verifyError: ctx.job.error ?? 'Verification did not finish' }).where(sql`${osImages.id} = ${ctx.job.imageId} and ${osImages.verifyStatus} = 'verifying'`);
  },
};

/* ------------------------------------------------------------------ hypervisors */

export function virtClientFor(deps: ProvisioningDeps, i: VirtIntegration): VirtClient {
  let secret: Record<string, unknown>;
  try {
    secret = JSON.parse(deps.secrets.decrypt(i.secretEnc, virtContext(i.orgId, i.id, i.kind, i.url))) as Record<string, unknown>;
  } catch {
    throw new PermanentError('The stored API credentials could not be decrypted; enter them again');
  }
  if (deps.makeVirt) return deps.makeVirt(i, secret);
  const p = i.params as Record<string, string | null>;
  return i.kind === 'proxmox'
    ? proxmoxClient({ url: i.url, verifyTls: i.verifyTls, tokenId: String(p.tokenId), tokenSecret: String(secret.tokenSecret), actionTokenId: p.actionTokenId ?? null, actionTokenSecret: (secret.actionTokenSecret as string | null) ?? null })
    : virtualizorClient({ url: i.url, verifyTls: i.verifyTls, apiKey: String(secret.apiKey), apiPass: String(secret.apiPass), actionsEnabled: i.actionsEnabled });
}

async function guestOf(ctx: StepContext) {
  if (!ctx.job.guestId) throw new PermanentError('The VM no longer exists in inventory');
  const [g] = await D(ctx).db.select().from(virtGuests).where(eq(virtGuests.id, ctx.job.guestId));
  if (!g) throw new PermanentError('The VM no longer exists in inventory');
  const [i] = await D(ctx).db.select().from(virtIntegrations).where(eq(virtIntegrations.id, g.integrationId));
  if (!i || !i.enabled) throw new PermanentError('The hypervisor integration is disabled or deleted');
  const [h] = g.hostId ? await D(ctx).db.select().from(virtHosts).where(eq(virtHosts.id, g.hostId)) : [];
  return { client: virtClientFor(D(ctx), i), ref: { externalId: g.externalId, hostExternalId: h?.externalId ?? null, virtType: g.virtType } };
}

export const guestActionKind: KindDef = {
  steps: (job) => {
    const action = String(job.params.action) as GuestAction;
    const want = GUEST_TARGET_STATUS[action];
    return [
      {
        name: 'Check the VM',
        safeToRepeat: true,
        run: async (ctx) => {
          const { client, ref } = await guestOf(ctx);
          ctx.state.initial = await client.guestStatus(ref);
          if (action === 'reboot' && client.guestUptime) {
            ctx.state.uptimeBefore = await client.guestUptime(ref);
            ctx.state.uptimeReadAt = Date.now();
          }
          return { done: true, detail: `The VM is ${String(ctx.state.initial)}` };
        },
      },
      {
        name: GUEST_ACTION_LABELS[action] ?? action,
        safeToRepeat: action !== 'reboot',
        run: async (ctx) => {
          const { client, ref } = await guestOf(ctx);
          const now = await client.guestStatus(ref);
          if (action !== 'reboot' && now === want) return { done: true, detail: `Already ${now}; nothing sent` };
          if (action === 'reboot' && now !== 'running') throw new PermanentError(`The VM is ${now}; start it instead of rebooting`);
          await client.guestAction(ref, action);
          return { done: true, detail: 'Sent to the hypervisor' };
        },
      },
      {
        name: 'Verify the VM state',
        safeToRepeat: true,
        run: async (ctx) => {
          const { client, ref } = await guestOf(ctx);
          ctx.state.verifyFrom ??= ctx.now().toISOString();
          const s = await client.guestStatus(ref);
          if (s === want && action === 'reboot') {
            // "running" before and after: a reboot is seen only as an uptime that started over.
            const before = typeof ctx.state.uptimeBefore === 'number' ? ctx.state.uptimeBefore : null;
            const after = before !== null && client.guestUptime ? await client.guestUptime(ref).catch(() => null) : null;
            // Without a restart the uptime keeps counting (before + elapsed wall time); allow a few seconds of skew.
            const elapsed = (Date.now() - Number(ctx.state.uptimeReadAt ?? Date.now())) / 1000;
            if (before !== null && after !== null && after < before + elapsed - 5) {
              await D(ctx).db.update(virtGuests).set({ status: s, uptimeSeconds: after }).where(eq(virtGuests.id, ctx.job.guestId!));
              return { done: true, detail: `The VM restarted (uptime ${after} s) and is running` };
            }
            if (before === null) {
              ctx.state.unverified = 'the hypervisor does not report VM uptime, so the reboot itself could not be observed; the VM is running';
              return { done: true, detail: 'The hypervisor accepted the reboot and reports the VM running; the reboot itself could not be observed' };
            }
          } else if (s === want) {
            await D(ctx).db.update(virtGuests).set({ status: s }).where(eq(virtGuests.id, ctx.job.guestId!));
            return { done: true, detail: `The hypervisor reports the VM ${s}` };
          }
          const limit = action === 'shutdown' ? 300_000 : 180_000;
          if (ctx.now().getTime() - new Date(String(ctx.state.verifyFrom)).getTime() > limit) throw new PermanentError(s === want ? `No restart of the VM was seen within ${limit / 1000} s (its uptime did not start over)` : `The VM did not reach “${want}” within ${limit / 1000} s (it is ${s})`);
          return { wait: poll(ctx, 5000), status: 'verifying', detail: `Waiting for ${want} (now ${s})` };
        },
      },
    ];
  },
  async onCompleted(ctx) {
    return ctx.state.unverified ? { verified: false, note: String(ctx.state.unverified) } : { verified: true };
  },
};

export const PROVISIONING_KINDS: Record<string, KindDef> = { power_action: powerActionKind, os_install: osInstallKind, image_verify: imageVerifyKind, guest_action: guestActionKind };

/* ------------------------------------------------------------------ inventory sync (periodic, read-only) */

export async function syncDueIntegrations(deps: ProvisioningDeps, opts: { force?: string } = {}): Promise<number> {
  const due = await deps.db.execute<{ id: string }>(sql`
    update virt_integrations set next_sync_at = now() + make_interval(mins => sync_minutes)
     where id in (select id from virt_integrations where enabled and ${opts.force ? sql`id = ${opts.force}` : sql`next_sync_at <= now()`} for update skip locked)
    returning id`);
  for (const { id } of due.rows) {
    const [i] = await deps.db.select().from(virtIntegrations).where(eq(virtIntegrations.id, id));
    if (!i) continue;
    try {
      const inv = await virtClientFor(deps, i).inventory();
      const started = new Date();
      await deps.db.transaction(async (tx) => {
        const hostIds = new Map<string, string>();
        for (const h of inv.hosts) {
          const [row] = await tx
            .insert(virtHosts)
            .values({ orgId: i.orgId, integrationId: i.id, ...h, lastSeenAt: started, missingSince: null })
            .onConflictDoUpdate({ target: [virtHosts.integrationId, virtHosts.externalId], set: { ...h, lastSeenAt: started, missingSince: null } })
            .returning({ id: virtHosts.id });
          hostIds.set(h.externalId, row!.id);
        }
        // Hosts are linked to DCIM devices only by an operator (no guessing from names).
        for (const g of inv.guests) {
          const { hostExternalId, ...rest } = g;
          const hostId = hostExternalId ? (hostIds.get(hostExternalId) ?? null) : null;
          await tx
            .insert(virtGuests)
            .values({ orgId: i.orgId, integrationId: i.id, hostId, ...rest, lastSeenAt: started, missingSince: null })
            .onConflictDoUpdate({ target: [virtGuests.integrationId, virtGuests.externalId], set: { hostId, ...rest, lastSeenAt: started, missingSince: null } });
        }
        // Gone from the hypervisor: kept (with their customer assignment) and marked missing, never deleted silently.
        await tx.execute(sql`update virt_guests set missing_since = coalesce(missing_since, now()) where integration_id = ${i.id} and (last_seen_at is null or last_seen_at < ${started.toISOString()}::timestamptz)`);
        await tx.execute(sql`update virt_hosts set missing_since = coalesce(missing_since, now()) where integration_id = ${i.id} and (last_seen_at is null or last_seen_at < ${started.toISOString()}::timestamptz)`);
        await tx.update(virtIntegrations).set({ lastSyncAt: started, lastSyncOk: true, lastError: null }).where(eq(virtIntegrations.id, i.id));
      });
    } catch (e) {
      await deps.db
        .update(virtIntegrations)
        .set({ lastSyncAt: new Date(), lastSyncOk: false, lastError: ((e as { cause?: Error })?.cause?.message || (e as Error)?.message || 'Sync failed').slice(0, 500) })
        .where(eq(virtIntegrations.id, i.id));
      deps.logger.warn({ integrationId: i.id, err: (e as { cause?: Error })?.cause?.message ?? (e as Error).message }, 'hypervisor sync failed');
    }
  }
  return due.rows.length;
}
