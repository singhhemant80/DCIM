import { BlockList, isIP } from 'node:net';
import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../db/db';
import { osImages, provisioningEvents, provisioningJobs, type OsImage, type ProvisioningJob } from '../db/schema';
import { SecretBox } from '../common/secret-box';
import { hashToken, jobContext } from './contexts';
import { type InstallVars, TemplateError, prefixToNetmask, renderTemplate } from './template';

interface InstallParams {
  hostname: string;
  method: 'redfish_virtual_media' | 'pxe';
  macAddress?: string | null;
  network: { mode: 'dhcp' } | { mode: 'static'; address: string; prefixLength: number; gateway?: string | null; nameservers?: string[] };
  sshKeys?: string[];
}

/** Variables available to install templates and boot arguments. */
export function installVars(job: ProvisioningJob, image: Pick<OsImage, 'name'>, secret: { rootPasswordHash: string | null }, urls: { configUrl: string; callbackUrl: string }): InstallVars {
  const p = job.params as unknown as InstallParams;
  const dot = p.hostname.indexOf('.');
  const st = p.network.mode === 'static' ? p.network : null;
  const v4 = st && isIP(st.address) === 4;
  return {
    hostname: p.hostname,
    shortname: dot > 0 ? p.hostname.slice(0, dot) : p.hostname,
    domain: dot > 0 ? p.hostname.slice(dot + 1) : '',
    networkMode: p.network.mode,
    static: st ? 'yes' : '',
    dhcp: st ? '' : 'yes',
    ip: st?.address ?? '',
    prefix: st ? String(st.prefixLength) : '',
    netmask: st && v4 ? prefixToNetmask(st.prefixLength) : '',
    gateway: st?.gateway ?? '',
    nameservers: (st?.nameservers ?? []).join(' '),
    nameserversCsv: (st?.nameservers ?? []).join(','),
    mac: p.macAddress ?? '',
    rootPasswordHash: secret.rootPasswordHash ?? '',
    sshKeys: (p.sshKeys ?? []).join('\n'),
    sshKeysJson: JSON.stringify(p.sshKeys ?? []),
    callbackUrl: urls.callbackUrl,
    configUrl: urls.configUrl,
    jobId: job.id,
    imageName: image.name,
  };
}

const ACTIVE = ['queued', 'running', 'waiting', 'verifying'] as const;

/**
 * Unauthenticated endpoints used by servers while they install: the iPXE
 * script, the unattended-install file and the installer's completion callback.
 *
 * They are reachable only from the networks in CDCIM_BOOT_ALLOW, only for a
 * job that is still active, and only with the job's random boot token (or,
 * for the boot script and config, the MAC address the job was created for).
 * The token is stored hashed; the root password only ever leaves as a
 * SHA-512 crypt hash inside the rendered file.
 */
@Injectable()
export class BootService {
  private readonly allow = new BlockList();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly secrets: SecretBox,
  ) {
    for (const cidr of cfg.CDCIM_BOOT_ALLOW.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [addr, len] = cidr.split('/');
      const family = isIP(addr ?? '');
      if (!family) continue;
      this.allow.addSubnet(addr!, len === undefined ? (family === 4 ? 32 : 128) : Number(len), family === 4 ? 'ipv4' : 'ipv6');
    }
  }

  checkSource(ip: string | null) {
    const a = ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
    const fam = a ? isIP(a) : 0;
    if (!a || !fam || !this.allow.check(a, fam === 4 ? 'ipv4' : 'ipv6')) throw new ForbiddenException({ error: 'boot_source_denied', message: 'Boot endpoints are not available from this network' });
  }

  private publicUrl() {
    if (!this.cfg.CDCIM_PUBLIC_URL) throw new ServiceUnavailableException({ error: 'public_url_unset', message: 'CDCIM_PUBLIC_URL is not configured' });
    return this.cfg.CDCIM_PUBLIC_URL;
  }

  private async byToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const [j] = await this.db
      .select()
      .from(provisioningJobs)
      .where(and(eq(provisioningJobs.bootTokenHash, hashToken(token)), eq(provisioningJobs.kind, 'os_install'), inArray(provisioningJobs.status, [...ACTIVE])));
    return j ?? null;
  }

  private async byMac(mac: string) {
    const m = mac.trim().toLowerCase().replace(/-/g, ':');
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m)) return null;
    const [j] = await this.db
      .select()
      .from(provisioningJobs)
      .where(and(eq(provisioningJobs.bootMac, m), eq(provisioningJobs.kind, 'os_install'), inArray(provisioningJobs.status, [...ACTIVE])));
    return j ?? null;
  }

  private async load(j: ProvisioningJob) {
    const [img] = await this.db.select().from(osImages).where(eq(osImages.id, j.imageId!));
    if (!img || !j.secretEnc) return null;
    const secret = JSON.parse(this.secrets.decrypt(j.secretEnc, jobContext(j.orgId, j.id))) as { bootToken: string; rootPasswordHash: string | null };
    const base = `${this.publicUrl()}/api/v1/boot`;
    const urls = { configUrl: `${base}/config/${secret.bootToken}`, callbackUrl: `${base}/callback/${secret.bootToken}` };
    return { img, secret, urls, vars: installVars(j, img, secret, urls) };
  }

  private async signal(jobId: string, patch: Record<string, unknown>, message: string, level: 'info' | 'warn' | 'error' = 'info') {
    await this.db.transaction(async (tx) => {
      await tx
        .update(provisioningJobs)
        .set({
          signals: sql`coalesce(${provisioningJobs.signals}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
          // Wake a waiting job so the worker notices promptly.
          nextRunAt: sql`case when ${provisioningJobs.status} = 'waiting' then now() else ${provisioningJobs.nextRunAt} end`,
        })
        .where(eq(provisioningJobs.id, jobId));
      await tx.insert(provisioningEvents).values({ jobId, message, level });
    });
  }

  /** iPXE script. Unknown MAC → exit, so the server falls through to its next boot device. */
  async ipxe(by: { token?: string; mac?: string }, ip: string | null): Promise<string> {
    this.checkSource(ip);
    const j = by.token ? await this.byToken(by.token) : by.mac ? await this.byMac(by.mac) : null;
    if (!j || (j.params as unknown as InstallParams).method !== 'pxe') return '#!ipxe\necho No network install is queued for this server\nexit\n';
    // Only once DCIM has started the server: nothing is handed out for a job that hasn't reached that point.
    if (!(j.state as { bootStartedAt?: string } | null)?.bootStartedAt) return '#!ipxe\necho The installation has not reached the boot step yet\nexit\n';
    // Serve the installer once: a server that network-boots again after installing (common boot order) must not reinstall.
    const sig = (j.signals ?? {}) as { ipxeServedAt?: string; callback?: { status?: string } };
    const callbackMode = (j.params as { verify?: { by?: string } }).verify?.by !== 'tcp';
    if (sig.ipxeServedAt) {
      if (callbackMode && !sig.callback?.status) {
        // Requested twice before the installer reported anything: two machines claim this MAC, or someone fetched the script first. Fail closed.
        await this.signal(j.id, { bootConflict: `The boot script was requested again (from ${ip ?? 'unknown'}) before the installer reported; first served to ${String((sig as { ipxeFrom?: string }).ipxeFrom ?? 'unknown')}` }, `Boot script requested twice before the installer reported (now from ${ip ?? 'unknown'}); stopping the job`, 'error');
      } else {
        await this.signal(j.id, {}, `Boot script requested again by ${ip ?? 'unknown'}; the install was already handed out, so the server was sent to its next boot device`, 'warn');
      }
      return '#!ipxe\necho The installation for this server has already started\nexit\n';
    }
    const l = await this.load(j);
    const files = ((j.params as { files?: { kernelUrl?: string | null; initrdUrl?: string | null } }).files ?? l?.img) as { kernelUrl?: string | null; initrdUrl?: string | null } | undefined;
    if (!l || !files?.kernelUrl || !files.initrdUrl) return '#!ipxe\necho The install image has no kernel/initrd\nexit\n';
    let args = '';
    try {
      args = renderTemplate(l.img.bootArgs ?? '', l.vars);
    } catch (e) {
      if (e instanceof TemplateError) return `#!ipxe\necho Boot arguments are invalid\nexit\n`;
      throw e;
    }
    if (/[\r\n]/.test(args)) return '#!ipxe\necho Boot arguments must be one line\nexit\n';
    await this.signal(j.id, { ipxeServedAt: new Date().toISOString(), ipxeFrom: ip }, `Boot script served to ${ip ?? 'unknown'}`);
    return ['#!ipxe', `echo Crapplet DCIM: installing ${l.img.name} as ${l.vars.hostname}`, `kernel ${files.kernelUrl} initrd=initrd ${args}`.trimEnd(), `initrd --name initrd ${files.initrdUrl}`, 'boot', ''].join('\n');
  }

  /** Rendered unattended-install file (kickstart, preseed or autoinstall user-data). */
  async config(by: { token?: string; mac?: string }, ip: string | null): Promise<{ body: string; kind: string }> {
    this.checkSource(ip);
    const j = by.token ? await this.byToken(by.token) : by.mac ? await this.byMac(by.mac) : null;
    if (!j) throw new NotFoundException({ error: 'not_found', message: 'No active install' });
    // Lookup by MAC hands out the callback token, so it works once per job; installers that need the file again use the token URL inside it.
    if (by.mac && !(j.state as { bootStartedAt?: string } | null)?.bootStartedAt) throw new NotFoundException({ error: 'not_found', message: 'No active install' });
    if (by.mac && (j.signals as { configServedAt?: string } | null)?.configServedAt) {
      const cb = (j.signals as { callback?: unknown } | null)?.callback;
      await this.signal(
        j.id,
        cb ? {} : { bootConflict: `The install configuration was requested again by MAC (from ${ip ?? 'unknown'}) before the installer reported` },
        `Install configuration requested again by MAC from ${ip ?? 'unknown'}; refused (handed out by MAC only once)${cb ? '' : '; stopping the job'}`,
        cb ? 'warn' : 'error',
      );
      throw new NotFoundException({ error: 'not_found', message: 'No active install' });
    }
    const l = await this.load(j);
    if (!l || l.img.templateKind === 'none' || !l.img.template) throw new NotFoundException({ error: 'no_template', message: 'This image has no install template' });
    let body: string;
    try {
      body = renderTemplate(l.img.template, l.vars);
    } catch (e) {
      if (e instanceof TemplateError) {
        await this.signal(j.id, { configError: e.message }, `Install template could not be rendered: ${e.message}`, 'error');
        throw new NotFoundException({ error: 'template_error', message: 'The install template could not be rendered' });
      }
      throw e;
    }
    await this.signal(j.id, { configServedAt: new Date().toISOString() }, `Install configuration served to ${ip ?? 'unknown'}`);
    return { body, kind: l.img.templateKind };
  }

  /** Installer reports progress; only "done" lets the job continue to verification. */
  async callback(token: string, input: { status: 'started' | 'done' | 'failed'; message?: string }, ip: string | null) {
    this.checkSource(ip);
    const j = await this.byToken(token);
    if (!j) throw new NotFoundException({ error: 'not_found', message: 'No active install' });
    const msg = input.message?.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
    await this.signal(
      j.id,
      { callback: { status: input.status, message: msg ?? null, at: new Date().toISOString(), from: ip } },
      `Installer reported ${input.status}${msg ? `: ${msg}` : ''}`,
      input.status === 'failed' ? 'error' : 'info',
    );
    return { ok: true };
  }
}
