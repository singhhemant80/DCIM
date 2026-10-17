import { promises as fs } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { DB, type Db } from '../db/db';
import { osImages, provisioningEvents, provisioningJobs, pxeSettings, type OsImage, type ProvisioningJob } from '../db/schema';
import type { BootKind, InstallMode } from '@crapplet/shared';
import { addCidrs, bootBaseUrl, bootSettingsVersion } from './boot-base';
import { bootScript, esxiBootCfg, RecipeError } from './iso/recipes';
import { imagePaths, resolveInTree } from './iso/store';
import { cpioDataPadding, cpioFileHeader, cpioTrailer } from './iso/cpio';
import type { Segment } from './iso/serve';
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
    sshKeysBase64: Buffer.from((p.sshKeys ?? []).map((k) => `${k}\n`).join('')).toString('base64'),
    noPassword: secret.rootPasswordHash ? '' : 'yes',
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
  private allow: { list: BlockList; at: number; v: number } | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly secrets: SecretBox,
  ) {}

  /** CDCIM_BOOT_ALLOW plus the networks allowed in the PXE settings (re-read every 30 s). */
  private async allowList(): Promise<BlockList> {
    if (this.allow && this.allow.v === bootSettingsVersion.n && Date.now() - this.allow.at < 30_000) return this.allow.list;
    const list = new BlockList();
    addCidrs(
      list,
      this.cfg.CDCIM_BOOT_ALLOW.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const rows = await this.db.select({ nets: pxeSettings.allowNetworks, proxy: pxeSettings.proxyNetworks, ranges: pxeSettings.ranges }).from(pxeSettings);
    for (const r of rows) addCidrs(list, [...(r.nets ?? []), ...(r.proxy ?? []), ...(r.ranges ?? []).map((x) => x.network)]);
    this.allow = { list, at: Date.now(), v: bootSettingsVersion.n };
    return list;
  }

  async checkSource(ip: string | null) {
    const a = ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
    const fam = a ? isIP(a) : 0;
    if (!a || !fam || !(await this.allowList()).check(a, fam === 4 ? 'ipv4' : 'ipv6'))
      throw new ForbiddenException({ error: 'boot_source_denied', message: 'Boot endpoints are not available from this network (add it under OS & Images → PXE service → Allowed networks)' });
  }

  private async baseFor(orgId: string) {
    const b = await bootBaseUrl(this.db, orgId, this.cfg.CDCIM_PUBLIC_URL);
    if (!b) throw new ServiceUnavailableException({ error: 'public_url_unset', message: 'No boot URL: set it under OS & Images → PXE service, or set CDCIM_PUBLIC_URL' });
    return b;
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
    const base = `${await this.baseFor(j.orgId)}/api/v1/boot`;
    const urls = { configUrl: `${base}/config/${secret.bootToken}`, callbackUrl: `${base}/callback/${secret.bootToken}`, files: `${base}/files/${secret.bootToken}` };
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
    await this.checkSource(ip);
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
        await this.signal(
          j.id,
          { bootConflict: `The boot script was requested again (from ${ip ?? 'unknown'}) before the installer reported; first served to ${String((sig as { ipxeFrom?: string }).ipxeFrom ?? 'unknown')}` },
          `Boot script requested twice before the installer reported (now from ${ip ?? 'unknown'}); stopping the job`,
          'error',
        );
      } else {
        await this.signal(j.id, {}, `Boot script requested again by ${ip ?? 'unknown'}; the install was already handed out, so the server was sent to its next boot device`, 'warn');
      }
      return '#!ipxe\necho The installation for this server has already started\nexit\n';
    }
    const l = await this.load(j);
    if (l?.img.source === 'upload') {
      const mode = ((j.params as { mode?: InstallMode }).mode ?? 'automatic') as InstallMode;
      let script: string;
      try {
        const extra = l.img.bootArgs ? renderTemplate(l.img.bootArgs, l.vars) : '';
        script = bootScript({ kind: (l.img.bootKind ?? 'unknown') as BootKind, mode, files: l.urls.files, configUrl: l.urls.configUrl, vars: l.vars, extraArgs: extra, label: l.img.name });
      } catch (e) {
        if (e instanceof TemplateError || e instanceof RecipeError) return `#!ipxe\necho NexoraDC: ${e.message.replace(/[\r\n$]/g, ' ')}\nsleep 10\nexit\n`;
        throw e;
      }
      await this.signal(j.id, { ipxeServedAt: new Date().toISOString(), ipxeFrom: ip }, `Boot script served to ${ip ?? 'unknown'} (${mode} install of ${l.img.name})`);
      return script;
    }
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
    return ['#!ipxe', `echo NexoraDC: installing ${l.img.name} as ${l.vars.hostname}`, `kernel ${files.kernelUrl} initrd=initrd ${args}`.trimEnd(), `initrd --name initrd ${files.initrdUrl}`, 'boot', ''].join('\n');
  }

  /** Rendered unattended-install file (kickstart, preseed or autoinstall user-data). */
  async config(by: { token?: string; mac?: string }, ip: string | null): Promise<{ body: string; kind: string }> {
    await this.checkSource(ip);
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
    if ((j.params as { mode?: string }).mode === 'interactive') throw new NotFoundException({ error: 'no_template', message: 'An interactive install has no install configuration' });
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

  /**
   * Install files of an uploaded ISO, for the job holding `token`: the ISO
   * itself (virtual media, Ubuntu's url=), the kernel and initrd, the Proxmox
   * initrd with the ISO appended, ESXi's rewritten boot.cfg, and the extracted
   * tree (RHEL inst.repo, ESXi modules; case-insensitive lookup).
   */
  async files(token: string, path: string, ip: string | null): Promise<{ segments: Segment[]; contentType: string }> {
    await this.checkSource(ip);
    const j = await this.byToken(token);
    if (!j?.imageId) throw new NotFoundException({ error: 'not_found', message: 'No active install' });
    const [img] = await this.db.select().from(osImages).where(eq(osImages.id, j.imageId));
    if (!img || img.source !== 'upload' || img.uploadStatus !== 'ready') throw new NotFoundException({ error: 'not_found', message: 'No files for this install' });
    const p = imagePaths(this.cfg.CDCIM_IMAGE_DIR, img.id);
    const file = async (f: string) => {
      const st = await fs.stat(f).catch(() => null);
      if (!st?.isFile()) throw new NotFoundException({ error: 'not_found', message: 'File not found' });
      return { file: f, size: st.size };
    };
    const bin = 'application/octet-stream';
    if (path === 'iso') {
      // The first request marks the job: the BMC or installer started fetching the install media.
      if (!(j.signals as { mediaFetchedAt?: string } | null)?.mediaFetchedAt) await this.signal(j.id, { mediaFetchedAt: new Date().toISOString(), mediaFrom: ip }, `Install media requested by ${ip ?? 'unknown'}`);
      return { segments: [await file(p.iso)], contentType: 'application/x-iso9660-image' };
    }
    if (path === 'kernel' || path === 'initrd') return { segments: [await file(path === 'kernel' ? p.kernel : p.initrd)], contentType: bin };
    if (path === 'proxmox-initrd' && img.bootKind === 'proxmox') {
      const initrd = await file(p.initrd);
      const iso = await file(p.iso);
      const pad = (4 - (initrd.size % 4)) % 4;
      return {
        segments: [initrd, { data: Buffer.alloc(pad) }, { data: cpioFileHeader('proxmox.iso', iso.size) }, iso, { data: cpioDataPadding(iso.size) }, { data: cpioTrailer() }],
        contentType: bin,
      };
    }
    if (path === 'esxi-boot.cfg' && img.bootKind === 'esxi') {
      const cfgFile = await resolveInTree(p.tree, 'boot.cfg');
      if (!cfgFile) throw new NotFoundException({ error: 'not_found', message: 'boot.cfg not found' });
      const l = await this.load(j);
      if (!l) throw new NotFoundException({ error: 'not_found', message: 'No active install' });
      const mode = ((j.params as { mode?: InstallMode }).mode ?? 'automatic') as InstallMode;
      let extra = '';
      try {
        extra = img.bootArgs ? renderTemplate(img.bootArgs, l.vars) : '';
      } catch {
        extra = '';
      }
      const body = esxiBootCfg(await fs.readFile(cfgFile, 'utf8'), { files: l.urls.files, mode, configUrl: l.urls.configUrl, mac: l.vars.mac, extraArgs: extra.replace(/[\r\n]/g, ' ') });
      return { segments: [{ data: Buffer.from(body) }], contentType: 'text/plain; charset=utf-8' };
    }
    if (path.startsWith('tree/')) {
      const f = await resolveInTree(p.tree, path.slice(5));
      if (!f) throw new NotFoundException({ error: 'not_found', message: 'File not found' });
      return { segments: [await file(f)], contentType: /\.(cfg|txt|xml|treeinfo)$/i.test(f) ? 'text/plain; charset=utf-8' : bin };
    }
    throw new NotFoundException({ error: 'not_found', message: 'File not found' });
  }

  /** Installer reports progress; only "done" lets the job continue to verification. */
  async callback(token: string, input: { status: 'started' | 'done' | 'failed'; message?: string }, ip: string | null) {
    await this.checkSource(ip);
    const j = await this.byToken(token);
    if (!j) throw new NotFoundException({ error: 'not_found', message: 'No active install' });
    const msg = input.message?.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
    await this.signal(j.id, { callback: { status: input.status, message: msg ?? null, at: new Date().toISOString(), from: ip } }, `Installer reported ${input.status}${msg ? `: ${msg}` : ''}`, input.status === 'failed' ? 'error' : 'info');
    return { ok: true };
  }
}
