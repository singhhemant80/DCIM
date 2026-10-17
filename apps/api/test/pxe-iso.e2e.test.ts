/**
 * ISO uploads and PXE: upload in chunks (resume on offset mismatch), the
 * worker's preparation (checksum, OS detection, boot files), network installs
 * from uploaded ISOs (automatic and interactive), virtual media from an
 * uploaded ISO, token-scoped install files with Range support, and the PXE
 * service configuration (rendered for dnsmasq, checked with `dnsmasq --test`,
 * applied by the root helper with --no-systemctl).
 *
 * Simulated: the BMC (Redfish), the booting server (HTTP requests made the way
 * iPXE and the installers make them) and the Debian mirror. The ISOs are small
 * test images with the real layouts, built with xorriso.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { osImages, provisioningJobs } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { runDueJobs } from '../src/worker/provisioning/engine';
import { PROVISIONING_KINDS, type ProvisioningDeps } from '../src/worker/provisioning/kinds';
import { redfishControl } from '../src/worker/provisioning/bmc';
import { buildDesired } from '../src/worker/pxe/desired';
import { renderDnsmasq, renderHosts, renderNexoraIpxe } from '../src/provisioning/pxe/render';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startControlRedfish, type ControlRedfish } from './simulators/provisioning-devices';
import { buildIso, debianIso, esxiIso, haveIsoTools, proxmoxIso, rockyIso, ubuntuIso, windowsIso, type TestIso } from './simulators/isos';

const tools = haveIsoTools();
let ctx: TestContext;
let admin: Client;
let noc: Client;
let bmc: ControlRedfish;
const imageDir = mkdtempSync(join(tmpdir(), 'cdcim-images-'));
const pxeOutDir = mkdtempSync(join(tmpdir(), 'cdcim-pxe-out-'));
const P = '/api/v1/provisioning';
const D = '/api/v1/dcim';
const BASE = 'http://127.0.0.1:8080';
const BMC_PASS = 'bmc-ctl-pass-5521';
const ROOT_PW = 'Root-Install-Pass-9902';
const clock = { t: Date.now() };
const pending: Promise<unknown>[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const mirror: Record<string, Buffer> = {};
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

const deps = (): ProvisioningDeps =>
  ({
    db: ctx.db,
    secrets: ctx.app.get(SecretBox),
    logger: silent,
    kinds: PROVISIONING_KINDS,
    now: () => new Date(clock.t),
    retryBaseMs: 1000,
    publicUrl: BASE,
    pollMs: 1000,
    imageDir,
    pxeOutDir,
    makeBmc: (_cred: unknown, target: Parameters<typeof redfishControl>[0]) => redfishControl(target),
    // The Debian mirror.
    fetchImpl: (async (url: string | URL) => {
      const u = String(url);
      const body = Object.entries(mirror).find(([k]) => u.endsWith(k))?.[1];
      return body ? new Response(new Uint8Array(body), { status: 200 }) : new Response('not found', { status: 404 });
    }) as typeof fetch,
  }) as unknown as ProvisioningDeps;

const job = async (id: string) => (await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.id, id)))[0]!;
async function drive(id: string, until?: (j: Awaited<ReturnType<typeof job>>) => boolean) {
  for (let i = 0; i < 300; i++) {
    // What the worker's PXE loop and the root helper do: report which MACs the PXE service answers.
    const { desired } = await buildDesired(ctx.db, BASE);
    writeFileSync(join(pxeOutDir, 'status.json'), JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), ok: true, mode: desired.mode, macs: desired.enabled && desired.mode !== 'external' ? desired.macs : [] }));
    await runDueJobs(deps());
    while (pending.length) await pending.shift();
    const j = await job(id);
    if (['completed', 'failed', 'cancelled', 'recovery'].includes(j.status) || until?.(j)) return j;
    clock.t += 5000;
  }
  throw new Error('job did not settle');
}

/** Uploads an ISO in chunks of `chunk` bytes through the API and prepares it. */
async function upload(name: string, iso: TestIso, chunk = 400_000, extra: object = {}) {
  const data = readFileSync(iso.path);
  const img = await ok(admin.post(`${P}/images/upload`, { name, fileName: `${name.replace(/\W+/g, '-')}.iso`, size: data.length, ...extra }));
  for (let off = 0; off < data.length; off += chunk) {
    const part = data.subarray(off, off + chunk);
    await ok(admin.agent.put(`${P}/images/${img.id}/upload`).set('X-CSRF-Token', admin.csrf).set('Upload-Offset', String(off)).set('Content-Type', 'application/octet-stream').send(part));
  }
  const j = await ok(admin.post(`${P}/images/${img.id}/upload/complete`, {}));
  const done = await drive(j.id);
  const [row] = await ctx.db.select().from(osImages).where(eq(osImages.id, img.id));
  return { id: img.id as string, job: done, row: row!, data };
}

const boot = (path: string) => request(ctx.server).get(path.startsWith('http') ? new URL(path).pathname + new URL(path).search : path);
/** Raw bytes whatever the content type. */
const binary = (res: import('node:http').IncomingMessage, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe.skipIf(!tools)('ISO uploads and PXE installs', () => {
  beforeAll(async () => {
    // Loopback is not allowed by default; the PXE settings add it below.
    ctx = await setupTestApp({ CDCIM_PUBLIC_URL: BASE, CDCIM_BOOT_ALLOW: '10.0.0.0/8', CDCIM_IMAGE_DIR: imageDir });
    admin = await Client.login(ctx.server, ctx.emails.superAdmin);
    noc = await Client.login(ctx.server, ctx.emails.noc);
    bmc = await startControlRedfish('dcim-ctl', BMC_PASS);
    const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell' }))).id;
    const model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'R640', category: 'server', uHeight: 1, fullDepth: true }))).id;
    ids.srv = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'PXE-01', hostname: 'pxe-01', initialState: 'inventory' }))).id;
    await ok(admin.put(`${P}/devices/${ids.srv}/control`, { kind: 'redfish', host: '127.0.0.1', port: bmc.port, username: 'dcim-ctl', password: BMC_PASS, scheme: 'http' }));
  });

  afterAll(async () => {
    await bmc?.close();
    await ctx?.close();
  });

  const reset = () => {
    bmc.state.power = 'On';
    bmc.state.override = { enabled: 'Disabled', target: 'None' };
    bmc.state.media = { image: null, inserted: false };
    bmc.state.boots.length = 0;
    bmc.state.resets.length = 0;
    bmc.onBoot(() => undefined);
  };
  const install = (body: object) =>
    admin.post(`${P}/installs`, {
      deviceId: ids.srv,
      method: 'pxe',
      mode: 'automatic',
      hostname: 'node-01.example.net',
      macAddress: '52:54:00:10:20:30',
      network: { mode: 'dhcp' },
      rootPassword: ROOT_PW,
      sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ops@example'],
      confirm: 'PXE-01',
      wipeAcknowledged: true,
      ...body,
    });

  it('uploads resume from the server offset; only staff with provisioning.execute upload', async () => {
    const iso = ubuntuIso();
    const data = readFileSync(iso.path);
    expect((await noc.post(`${P}/images/upload`, { name: 'x', fileName: 'x.iso', size: data.length })).status).toBe(403);
    const img = await ok(admin.post(`${P}/images/upload`, { name: 'Resume test', fileName: 'u.iso', size: data.length }));
    const put = (off: number, part: Buffer) => admin.agent.put(`${P}/images/${img.id}/upload`).set('X-CSRF-Token', admin.csrf).set('Upload-Offset', String(off)).set('Content-Type', 'application/octet-stream').send(part);
    await ok(put(0, data.subarray(0, 500_000)));
    // A lost response: the client resends from an old offset and learns where to continue.
    const stale = await put(0, data.subarray(0, 500_000));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'offset_mismatch', uploadedBytes: 500_000 });
    expect((await admin.post(`${P}/images/${img.id}/upload/complete`, {})).body.error).toBe('incomplete');
    await ok(put(500_000, data.subarray(500_000)));
    expect((await put(data.length, Buffer.from('x'))).body.error).toBe('too_large');
    await ok(admin.delete(`${P}/images/${img.id}`));
    expect(existsSync(join(imageDir, img.id))).toBe(false);
  });

  it('prepares an Ubuntu ISO: SHA-256, detection, kernel/initrd, default autoinstall template', async () => {
    const iso = ubuntuIso();
    const u = await upload('Ubuntu 24.04', iso, 300_000, { expectedSha256: sha(readFileSync(iso.path)) });
    expect(u.job.status).toBe('completed');
    expect(u.row).toMatchObject({ uploadStatus: 'ready', bootKind: 'ubuntu', family: 'ubuntu', version: '24.04.1', verifyStatus: 'verified', templateKind: 'autoinstall', isoSha256: sha(u.data) });
    expect(u.row.detected).toMatchObject({
      label: 'Ubuntu-Server 24.04.1 LTS "Noble Numbat" - Release amd64',
      codename: 'Noble Numbat',
      methods: ['pxe', 'redfish_virtual_media'],
      modes: { pxe: ['automatic', 'interactive'], redfish_virtual_media: ['interactive'] },
    });
    expect(readFileSync(join(imageDir, u.id, 'boot', 'kernel')).equals(iso.files['casper/vmlinuz']!)).toBe(true);
    expect(readFileSync(join(imageDir, u.id, 'boot', 'initrd')).equals(iso.files['casper/initrd']!)).toBe(true);
    ids.ubuntu = u;
  });

  it('a wrong expected SHA-256 fails the preparation with the real checksum', async () => {
    const iso = buildIso('BAD', { 'README.TXT': 'x' });
    const r = await upload('Wrong checksum', iso, 2_000_000, { expectedSha256: 'a'.repeat(64) });
    expect(r.job.status).toBe('failed');
    expect(r.row).toMatchObject({ uploadStatus: 'failed' });
    expect(r.row.processError).toContain(sha(r.data));
  });

  it('boot endpoints are closed until the PXE settings allow the network', async () => {
    expect((await request(ctx.server).get('/api/v1/boot/ipxe?mac=52:54:00:10:20:30')).status).toBe(403);
    const bad = await admin.put(`${P}/pxe`, { enabled: true, mode: 'dhcp', serverAddress: '10.20.0.5', ranges: [{ network: '10.20.0.0/24', start: '10.20.1.10', end: '10.20.0.50', dns: [] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/not inside 10\.20\.0\.0\/24/);
    // https is refused: network boot cannot check certificates.
    expect((await admin.put(`${P}/pxe`, { enabled: true, mode: 'proxy', serverAddress: '10.20.0.5', proxyNetworks: ['10.20.0.0/24'], bootBaseUrl: 'https://dcim.example.com' })).status).toBe(400);
    await ok(admin.put(`${P}/pxe`, { enabled: true, mode: 'proxy', interface: 'eth0', serverAddress: '10.20.0.5', proxyNetworks: ['10.20.0.0/24'], bootBaseUrl: BASE, allowNetworks: ['127.0.0.0/8'] }));
    const view = await ok(admin.get(`${P}/pxe`));
    expect(view).toMatchObject({ settings: { enabled: true, mode: 'proxy' }, bootBase: BASE });
    expect(Array.isArray(view.interfaces)).toBe(true);
    expect((await request(ctx.server).get('/api/v1/boot/ipxe?mac=52:54:00:10:20:30')).text).toMatch(/No network install is queued/);
  });

  it('automatic Ubuntu network install: one-time PXE boot, iPXE script, files under the job token, autoinstall, callback', async () => {
    reset();
    const mac = '52:54:00:10:20:30';
    const seen: Record<string, string> = {};
    bmc.onBoot((src) => {
      if (src !== 'Pxe') return;
      pending.push(
        (async () => {
          const script = (await boot(`/api/v1/boot/ipxe?mac=${mac}`)).text;
          seen.script = script;
          const kernelUrl = /^kernel (\S+)/m.exec(script)![1]!;
          const initrdUrl = /^initrd --name initrd (\S+)/m.exec(script)![1]!;
          seen.kernel = (await boot(kernelUrl).buffer(true)).body.toString('base64');
          seen.initrd = (await boot(initrdUrl).buffer(true)).body.toString('base64');
          // casper fetches the ISO (url=); BMCs and some installers use ranges.
          const isoUrl = /url=(\S+)/.exec(script)![1]!;
          const part = await boot(isoUrl).set('Range', 'bytes=32768-32867').buffer(true).parse(binary);
          seen.rangeStatus = String(part.status);
          seen.rangeHeader = String(part.headers['content-range']);
          seen.range = part.body.toString('base64');
          const s = /ds=nocloud-net;s=(\S+)/.exec(script)![1]!;
          seen.userData = (await boot(`${s}user-data`)).text;
          seen.metaStatus = String((await boot(`${s}meta-data`)).status);
          const cb = /'(http:\/\/\S+\/api\/v1\/boot\/callback\/[\w-]+)'/.exec(seen.userData)![1]!;
          await request(ctx.server).post(new URL(cb).pathname).send({ status: 'started' }).expect(200);
          await request(ctx.server).post(new URL(cb).pathname).send({ status: 'done' }).expect(200);
        })(),
      );
    });
    const j = await ok(install({ imageId: ids.ubuntu.id }));
    // The PXE service learns the MAC while the install is active.
    const during = await buildDesired(ctx.db, BASE);
    expect(during.desired).toMatchObject({ enabled: true, mode: 'proxy', macs: [mac], bootBase: BASE });
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
    expect(bmc.state.boots).toEqual(['Pxe']);
    const token = /\/files\/([\w-]+)\/kernel/.exec(seen.script!)![1]!;
    expect(seen.script).toContain(
      `kernel ${BASE}/api/v1/boot/files/${token}/kernel initrd=initrd ip=dhcp url=${BASE}/api/v1/boot/files/${token}/iso cloud-config-url=/dev/null fsck.mode=skip autoinstall ds=nocloud-net;s=${BASE}/api/v1/boot/config/${token}/`,
    );
    expect(Buffer.from(seen.kernel!, 'base64').equals(readFileSync(join(imageDir, ids.ubuntu.id, 'boot', 'kernel')))).toBe(true);
    expect(seen.rangeStatus).toBe('206');
    expect(seen.rangeHeader).toBe(`bytes 32768-32867/${ids.ubuntu.data.length}`);
    expect(Buffer.from(seen.range!, 'base64').equals(ids.ubuntu.data.subarray(32768, 32868))).toBe(true);
    // The rendered autoinstall: host, NIC, hashed password, keys; no template syntax or plain password.
    expect(seen.userData).toContain('autoinstall:');
    expect(seen.userData).toContain('fqdn: node-01.example.net');
    expect(seen.userData).toContain('macaddress: "52:54:00:10:20:30"');
    expect(seen.userData).toMatch(/hashed_passwd: "\$6\$/);
    expect(seen.userData).toContain('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ops@example');
    expect(seen.userData).not.toContain(ROOT_PW);
    expect(seen.userData).not.toContain('{{');
    expect(seen.metaStatus).toBe('200');
    // After the job the token opens nothing, and the PXE service forgets the MAC.
    expect((await boot(`/api/v1/boot/files/${token}/kernel`)).status).toBe(404);
    expect((await buildDesired(ctx.db, BASE)).desired.macs).toEqual([]);
  });

  it('Rocky: tree served for inst.repo (case-insensitive), interactive install waits for "Mark finished"', async () => {
    reset();
    const r = await upload('Rocky 9.4', rockyIso());
    expect(r.row).toMatchObject({ bootKind: 'rhel', version: '9.4', templateKind: 'kickstart' });
    expect(r.row.detected).toMatchObject({ label: 'Rocky Linux 9.4', arch: 'x86_64' });
    const seen: Record<string, string> = {};
    bmc.onBoot((src) => {
      if (src !== 'Pxe') return;
      pending.push(
        (async () => {
          seen.script = (await boot('/api/v1/boot/ipxe?mac=52:54:00:10:20:31')).text;
          const repo = /inst\.repo=(\S+)/.exec(seen.script)![1]!;
          seen.treeinfo = (await boot(`${repo}.treeinfo`)).text;
          seen.rpm = String((await boot(`${repo}baseos/packages/B/BASH-5.1.8-9.el9.x86_64.rpm`).buffer(true)).body.length);
          seen.escape = String((await boot(`${repo}../boot/kernel`)).status);
        })(),
      );
    });
    const j = await ok(install({ imageId: r.id, mode: 'interactive', macAddress: '52:54:00:10:20:31', rootPassword: null }));
    const waiting = await drive(j.id, (x) => x.status === 'waiting' && !!(x.signals as { ipxeServedAt?: string } | null)?.ipxeServedAt && bmc.state.override.enabled === 'Disabled');
    expect(waiting.status).toBe('waiting');
    expect(seen.script).toMatch(/inst\.repo=\S+\/tree\/ ip=dhcp$/m);
    expect(seen.script).not.toContain('inst.ks=');
    expect(seen.treeinfo).toContain('name = Rocky Linux');
    expect(seen.rpm).toBe('20000');
    expect(seen.escape).toBe('404');
    // An interactive install has no install configuration.
    const token = /\/files\/([\w-]+)\//.exec(seen.script!)![1]!;
    expect((await boot(`/api/v1/boot/config/${token}`)).status).toBe(404);
    expect((await admin.post(`${P}/jobs/${j.id}/finish`, {})).status).toBe(200);
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
    const ev = await ctx.db.execute<{ summary: string }>(sql`select summary from device_events where kind = 'os_installed' and data->>'jobId' = ${j.id}`);
    expect(ev.rows[0]!.summary).toMatch(/installed interactively \(marked finished by .*; not verified\)/);
  });

  it('Windows: virtual media only; the BMC mounts the uploaded ISO from NexoraDC, ejected after "Mark finished"', async () => {
    reset();
    const w = await upload('Windows Server 2022', windowsIso(), 2_000_000);
    expect(w.row).toMatchObject({ bootKind: 'windows', templateKind: 'none' });
    expect(w.row.detected).toMatchObject({ methods: ['redfish_virtual_media'] });
    expect((await install({ imageId: w.id })).body.error).toBe('method_unsupported');
    expect((await install({ imageId: w.id, method: 'redfish_virtual_media', mode: 'automatic' })).body.error).toBe('mode_unsupported');
    const j = await ok(install({ imageId: w.id, method: 'redfish_virtual_media', mode: 'interactive', macAddress: null }));
    const waiting = await drive(j.id, (x) => x.status === 'waiting' && bmc.state.boots.length > 0 && bmc.state.override.enabled === 'Disabled');
    expect(waiting.status).toBe('waiting');
    expect(bmc.state.boots).toEqual(['Cd']);
    const url = bmc.state.media.image!;
    expect(url).toMatch(new RegExp(`^${BASE}/api/v1/boot/files/[\\w-]+/iso$`));
    const head = await request(ctx.server).head(new URL(url).pathname);
    expect(head.headers['content-length']).toBe(String(w.data.length));
    expect(head.headers['accept-ranges']).toBe('bytes');
    await ok(admin.post(`${P}/jobs/${j.id}/finish`, {}));
    expect((await drive(j.id)).status).toBe('completed');
    expect(bmc.state.media).toEqual({ image: null, inserted: false });
  });

  it('Proxmox: interactive only; the initrd is served with the ISO appended as a cpio archive', async () => {
    reset();
    const iso = proxmoxIso();
    const px = await upload('Proxmox VE 8.2', iso);
    expect(px.row).toMatchObject({ bootKind: 'proxmox', version: '8.2', templateKind: 'none' });
    expect((await install({ imageId: px.id })).body.error).toBe('mode_unsupported');
    const seen: Record<string, Buffer | string> = {};
    bmc.onBoot((src) => {
      if (src !== 'Pxe') return;
      pending.push(
        (async () => {
          seen.script = (await boot('/api/v1/boot/ipxe?mac=52:54:00:10:20:32')).text;
          seen.initrd = (await boot(/^initrd --name initrd (\S+)/m.exec(seen.script)![1]!).buffer(true)).body as Buffer;
        })(),
      );
    });
    const j = await ok(install({ imageId: px.id, mode: 'interactive', macAddress: '52:54:00:10:20:32' }));
    await drive(j.id, (x) => !!(x.signals as { ipxeServedAt?: string } | null)?.ipxeServedAt && pending.length === 0 && !!seen.initrd);
    expect(seen.script).toContain('ramdisk_size=16777216 rw quiet splash=silent');
    const body = seen.initrd as Buffer;
    const orig = iso.files['boot/initrd.img']!;
    expect(body.subarray(0, orig.length).equals(orig)).toBe(true);
    // The appended part is a valid cpio archive holding proxmox.iso, byte for byte.
    const dir = mkdtempSync(join(tmpdir(), 'cdcim-cpio-'));
    const start = orig.length + ((4 - (orig.length % 4)) % 4);
    writeFileSync(join(dir, 'tail.cpio'), body.subarray(start));
    execFileSync('bsdtar', ['-xf', join(dir, 'tail.cpio'), '-C', dir]);
    expect(readFileSync(join(dir, 'proxmox.iso')).equals(px.data)).toBe(true);
    await ok(admin.post(`${P}/jobs/${j.id}/cancel`, {}));
    await drive(j.id);
  });

  it('ESXi: UEFI chain to the installer and a boot.cfg rewritten for HTTP (upper-case ISO names found)', async () => {
    reset();
    const ex = await upload('ESXi 8.0U2', esxiIso());
    expect(ex.row).toMatchObject({ bootKind: 'esxi', templateKind: 'esxi' });
    expect(ex.row.detected).toMatchObject({ uefiOnly: true, label: 'ESXI-8.0U2-22380479-STANDARD' });
    expect((await install({ imageId: ex.id, rootPassword: null, macAddress: '52:54:00:10:20:33' })).body.error).toBe('password_required');
    const seen: Record<string, string> = {};
    bmc.onBoot((src) => {
      if (src !== 'Pxe') return;
      pending.push(
        (async () => {
          seen.script = (await boot('/api/v1/boot/ipxe?mac=52:54:00:10:20:33')).text;
          const [, efi, cfg] = /chain (\S+) -c (\S+)/.exec(seen.script)!;
          seen.efi = String((await boot(efi!).buffer(true)).status);
          seen.cfg = (await boot(cfg!)).text;
          const tree = /prefix=(\S+)/.exec(seen.cfg)![1]!;
          seen.module = String((await boot(`${tree}jumpstrt.gz`).buffer(true)).status);
          seen.ks = (await boot(/ks=(\S+)/.exec(seen.cfg)![1]!)).text;
        })(),
      );
    });
    const j = await ok(install({ imageId: ex.id, macAddress: '52:54:00:10:20:33', network: { mode: 'static', address: '10.20.0.40', prefixLength: 24, gateway: '10.20.0.1', nameservers: ['1.1.1.1'] } }));
    await drive(j.id, () => !!seen.ks);
    expect(seen.script).toContain('iseq ${platform} efi || goto bios');
    expect(seen.efi).toBe('200');
    expect(seen.cfg).toMatch(/^kernel=b\.b00$/m);
    expect(seen.cfg).toMatch(/^modules=jumpstrt\.gz --- useropts\.gz --- features\.gz$/m);
    expect(seen.cfg).toMatch(/^kernelopt=runweasel ks=\S+ netdevice=52:54:00:10:20:33 bootproto=dhcp$/m);
    expect(seen.cfg).not.toContain('cdromBoot');
    expect(seen.module).toBe('200');
    expect(seen.ks).toContain('network --bootproto=static --device=52:54:00:10:20:33 --ip=10.20.0.40 --netmask=255.255.255.0 --gateway=10.20.0.1 --nameserver=1.1.1.1 --hostname=node-01.example.net');
    expect(seen.ks).toMatch(/rootpw --iscrypted \$6\$/);
    await ok(admin.post(`${P}/jobs/${j.id}/cancel`, {}));
    await drive(j.id);
  });

  it('Debian: netboot installer from the mirror, checked against SHA256SUMS; static address on the kernel line', async () => {
    reset();
    const linux = Buffer.from('debian-netboot-linux');
    const initrd = Buffer.from('debian-netboot-initrd');
    const base = '/dists/bookworm/main/installer-amd64/current/images';
    mirror[`${base}/netboot/debian-installer/amd64/linux`] = linux;
    mirror[`${base}/netboot/debian-installer/amd64/initrd.gz`] = initrd;
    mirror[`${base}/SHA256SUMS`] = Buffer.from(`${sha(linux)}  ./netboot/debian-installer/amd64/linux\n${sha(initrd)}  ./netboot/debian-installer/amd64/initrd.gz\n`);
    const deb = await upload('Debian 12', debianIso());
    expect(deb.row).toMatchObject({ bootKind: 'debian', version: '12.7.0', templateKind: 'preseed' });
    expect(deb.row.detected).toMatchObject({ codename: 'bookworm', netbootSource: `https://deb.debian.org/debian${base}/netboot/debian-installer/amd64/` });
    expect(readFileSync(join(imageDir, deb.id, 'boot', 'kernel')).equals(linux)).toBe(true);
    const seen: Record<string, string> = {};
    bmc.onBoot((src) => {
      if (src === 'Pxe') pending.push((async () => (seen.script = (await boot('/api/v1/boot/ipxe?mac=52:54:00:10:20:34')).text))());
    });
    const j = await ok(install({ imageId: deb.id, macAddress: '52:54:00:10:20:34', network: { mode: 'static', address: '10.20.0.41', prefixLength: 24, gateway: '10.20.0.1', nameservers: ['9.9.9.9', '1.1.1.1'] } }));
    await drive(j.id, () => !!seen.script);
    expect(seen.script).toMatch(
      /auto=true priority=critical url=\S+\/config\/[\w-]+ netcfg\/choose_interface=auto netcfg\/get_hostname=node-01 netcfg\/get_domain=example\.net netcfg\/disable_autoconfig=true netcfg\/get_ipaddress=10\.20\.0\.41 netcfg\/get_netmask=255\.255\.255\.0 netcfg\/get_gateway=10\.20\.0\.1 netcfg\/get_nameservers=9\.9\.9\.9 netcfg\/confirm_static=true/,
    );
    await ok(admin.post(`${P}/jobs/${j.id}/cancel`, {}));
    await drive(j.id);
    // A mirror file that does not match its checksum fails the preparation.
    mirror[`${base}/netboot/debian-installer/amd64/linux`] = Buffer.from('tampered');
    const bad = await upload('Debian 12 again', debianIso());
    expect(bad.row).toMatchObject({ uploadStatus: 'failed' });
    expect(bad.row.processError).toMatch(/do not match the mirror’s SHA256SUMS/);
  });

  it('dnsmasq configuration: proxy and DHCP modes pass dnsmasq --test; only active MACs are answered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdcim-pxe-'));
    const paths = { hostsDir: join(dir, 'hosts'), tftpRoot: join(dir, 'tftp'), user: 'nobody', group: 'nogroup' };
    const proxy = { version: 1 as const, enabled: true, mode: 'proxy' as const, interface: 'eth0', serverAddress: '10.20.0.5', proxyNetworks: ['10.20.0.0/24'], ranges: [], bootBase: 'http://10.20.0.5', macs: ['52:54:00:aa:bb:cc'] };
    const conf = renderDnsmasq(proxy, paths);
    expect(conf).toContain('dhcp-ignore=tag:!nexora');
    expect(conf).toContain('dhcp-range=10.20.0.0,proxy,255.255.255.0');
    expect(conf).toContain('port=0');
    expect(renderHosts(proxy)).toContain('52:54:00:aa:bb:cc,set:nexora');
    expect(renderNexoraIpxe(proxy)).toContain('chain http://10.20.0.5/api/v1/boot/ipxe?mac=${netX/mac} || exit');
    const dhcp = { ...proxy, mode: 'dhcp' as const, interface: null, ranges: [{ network: '163.52.252.0/24', start: '163.52.252.200', end: '163.52.252.220', gateway: '163.52.252.1', dns: ['1.1.1.1'] }] };
    const conf2 = renderDnsmasq(dhcp, paths);
    expect(conf2).toContain('dhcp-range=set:r0,163.52.252.200,163.52.252.220,255.255.255.0,15m');
    expect(conf2).toContain('dhcp-boot=tag:efi64,snponly.efi,,10.20.0.5');
    let haveDnsmasq = true;
    try {
      execFileSync('dnsmasq', ['--version'], { stdio: 'ignore' });
    } catch {
      haveDnsmasq = false;
    }
    if (haveDnsmasq)
      for (const c of [conf, conf2, renderDnsmasq({ ...proxy, mode: 'external' }, paths)]) {
        const f = join(dir, 'test.conf');
        writeFileSync(f, c);
        expect(execFileSync('dnsmasq', ['--test', `--conf-file=${f}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toBe('');
      }
  });

  it('the root helper renders only validated settings; anything unexpected is rejected without echoing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdcim-apply-'));
    const out = join(dir, 'out');
    const desired = join(dir, 'desired.json');
    const me = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim();
    const run = () => {
      try {
        execFileSync('npx', ['tsx', 'src/cli/pxe-apply.ts', '--desired', desired, '--out', out, '--ipxe', '../../deploy/pxe/ipxe', '--owner', me, '--no-systemctl'], { stdio: 'ignore' });
      } catch {
        /* exit code checked through status.json */
      }
      return JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'));
    };
    const good = { version: 1, enabled: true, mode: 'proxy', interface: null, serverAddress: '10.20.0.5', proxyNetworks: ['10.20.0.0/24'], ranges: [], bootBase: 'http://10.20.0.5', macs: ['52:54:00:aa:bb:cc'] };
    writeFileSync(desired, JSON.stringify(good));
    expect(run()).toMatchObject({ ok: true, enabled: true, activeMacs: 1 });
    expect(readFileSync(join(out, 'tftp', 'undionly.0')).equals(readFileSync('../../deploy/pxe/ipxe/undionly.kpxe'))).toBe(true);
    expect(readFileSync(join(out, 'hosts', 'active'), 'utf8')).toContain('52:54:00:aa:bb:cc,set:nexora');
    expect(readFileSync(join(out, 'tftp', 'nexora.ipxe'), 'utf8')).toContain('chain http://10.20.0.5/api/v1/boot/ipxe');
    // A directive smuggled into a field, or an extra field, never reaches dnsmasq.
    writeFileSync(desired, JSON.stringify({ ...good, interface: 'eth0\ndhcp-script=/tmp/x' }));
    const st = run();
    expect(st).toMatchObject({ ok: false });
    expect(st.error).toMatch(/rejected \(interface\)/);
    expect(st.error).not.toContain('dhcp-script');
    writeFileSync(desired, JSON.stringify({ ...good, extra: 'conf-dir=/etc' }));
    expect(run()).toMatchObject({ ok: false });
    expect(readFileSync(join(out, 'dnsmasq.conf'), 'utf8')).not.toContain('dhcp-script');
  });
});
