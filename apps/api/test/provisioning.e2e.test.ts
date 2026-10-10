/**
 * Phase 6: provisioning end to end — the API, the worker's job kinds and the
 * public boot endpoints against simulated BMCs (Redfish with power, boot
 * override and virtual media; a stand-in ipmitool), an image mirror, and
 * Proxmox VE / Virtualizor APIs. The worker runs in-process on a controllable
 * clock so waits, timeouts and deadlines are exercised without sleeping.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents, controlCredentials, devices, ipAddresses, osImages, provisioningJobs, provisioningSteps, virtGuests } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { runDueJobs } from '../src/worker/provisioning/engine';
import { PROVISIONING_KINDS, syncDueIntegrations, type ProvisioningDeps } from '../src/worker/provisioning/kinds';
import { redfishControl } from '../src/worker/provisioning/bmc';
import { BootService } from '../src/provisioning/boot.service';
import { Client, setupTestApp, type TestContext } from './helpers';
import { fakeIpmitoolControl, startControlRedfish, startFileServer, startProxmox, startVirtualizor, type ControlRedfish, type MockProxmox, type MockVirtualizor } from './simulators/provisioning-devices';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let globex: Client;
let bmc: ControlRedfish;
let bmc2: ControlRedfish;
let bmc3: ControlRedfish;
let files: Awaited<ReturnType<typeof startFileServer>>;
let pve: MockProxmox;
let vz: MockVirtualizor;
let ipmi: ReturnType<typeof fakeIpmitoolControl>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ids: Record<string, any> = {};
const D = '/api/v1/dcim';
const P = '/api/v1/provisioning';
const V = '/api/v1/virtualization';
const PUBLIC_URL = 'http://127.0.0.1:8080';
const BMC_PASS = 'bmc-ctl-pass-9931';
const ROOT_PW = 'Root-Install-Pass-4471';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const clock = { t: Date.now() };
const hooks: { powerFail?: boolean; tcpUp?: boolean } = {};
const pending: Promise<unknown>[] = [];

const ISO = Buffer.from('fake-iso-'.repeat(5000));
const KERNEL = Buffer.from('fake-vmlinuz-'.repeat(1000));
const INITRD = Buffer.from('fake-initrd-'.repeat(2000));
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const KICKSTART = [
  'text',
  'network --device={{mac}} {{#if static}}--bootproto=static --ip={{ip}} --netmask={{netmask}} --gateway={{gateway}} --nameserver={{nameserversCsv}}{{/if}}{{#if dhcp}}--bootproto=dhcp{{/if}} --hostname={{hostname}}',
  'rootpw --iscrypted {{rootPasswordHash}}',
  'sshkey --username=root "{{sshKeys}}"',
  '%post',
  'curl -fsS -X POST -H "Content-Type: application/json" -d \'{"status":"done"}\' {{callbackUrl}}',
  '%end',
].join('\n');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

const deps = (): ProvisioningDeps => ({
  db: ctx.db,
  secrets: ctx.app.get(SecretBox),
  logger: silent,
  kinds: PROVISIONING_KINDS,
  now: () => new Date(clock.t),
  retryBaseMs: 1000,
  publicUrl: PUBLIC_URL,
  pollMs: 1000,
  imageAllowLocal: true,
  tcpCheck: async () => !!hooks.tcpUp,
  makeBmc: (cred, target) => {
    const real = redfishControl(target);
    return {
      ...real,
      power: async (a) => {
        if (hooks.powerFail) throw new Error('socket hang up');
        return real.power(a);
      },
    };
  },
});
const ipmiDeps = (): ProvisioningDeps => ({ ...deps(), makeBmc: undefined });

const job = async (id: string) => (await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.id, id)))[0]!;
const stepsOf = async (id: string) => (await ctx.db.select().from(provisioningSteps).where(eq(provisioningSteps.jobId, id))).sort((a, b) => a.seq - b.seq);

/** Runs the worker until the job finishes or needs a decision, advancing the clock between passes. */
async function drive(id: string, opts: { stepMs?: number; max?: number; until?: (j: Awaited<ReturnType<typeof job>>) => boolean; d?: ProvisioningDeps } = {}) {
  for (let i = 0; i < (opts.max ?? 400); i++) {
    await runDueJobs(opts.d ?? deps());
    while (pending.length) await pending.shift();
    const j = await job(id);
    if (['completed', 'failed', 'cancelled', 'recovery'].includes(j.status) || opts.until?.(j)) return j;
    clock.t += opts.stepMs ?? 2000;
  }
  throw new Error('job did not settle');
}

/** What a real installer does: fetch the config by MAC, then report through the callback URL it contains. */
function installer(mac: string, outcome: 'done' | 'failed' | null = 'done') {
  return async () => {
    const cfg = await request(ctx.server).get(`/api/v1/boot/config?mac=${mac}`);
    ids.lastConfig = cfg.text;
    if (cfg.status !== 200 || !outcome) return;
    const cb = /(http:\/\/\S+\/api\/v1\/boot\/callback\/[\w-]+)/.exec(cfg.text)![1]!;
    await request(ctx.server).post(new URL(cb).pathname).send({ status: 'started' }).expect(200);
    await request(ctx.server).post(new URL(cb).pathname).send({ status: outcome, message: outcome === 'failed' ? 'anaconda: no disks found' : undefined }).expect(200);
  };
}

async function resetBmc(b: ControlRedfish, power: 'On' | 'Off' = 'Off') {
  b.state.power = power;
  b.state.override = { enabled: 'Disabled', target: 'None' };
  b.state.media = { image: null, inserted: false };
  b.state.boots.length = 0;
  b.state.resets.length = 0;
  b.onBoot(() => undefined);
}

beforeAll(async () => {
  // The test server is reached over loopback, which production does not allow by default.
  ctx = await setupTestApp({ CDCIM_PUBLIC_URL: PUBLIC_URL, CDCIM_BOOT_ALLOW: '10.0.0.0/8,192.168.0.0/16,127.0.0.0/8' });
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  globex = await Client.login(ctx.server, ctx.emails.globexAdmin);
  bmc = await startControlRedfish('dcim-ctl', BMC_PASS);
  bmc2 = await startControlRedfish('dcim-ctl', BMC_PASS, { ignoreGraceful: true, initialPower: 'On' });
  bmc3 = await startControlRedfish('dcim-ctl', BMC_PASS, { noBootProgress: true, initialPower: 'On' });
  files = await startFileServer({ '/el9.iso': ISO, '/vmlinuz': KERNEL, '/initrd.img': INITRD, '/bad.iso': Buffer.from('tampered') });
  pve = await startProxmox({ id: 'dcim@pve!read', secret: 'pve-read-secret-1' }, { id: 'dcim@pve!ops', secret: 'pve-ops-secret-2' });
  vz = await startVirtualizor('VZKEY123', 'vz-api-pass-77');
  ipmi = fakeIpmitoolControl('ipmi-ctl-pw', { power: 'off' });
  process.env.IPMITOOL_PATH = ipmi.path;

  const mfr = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: mfr, name: 'R650', category: 'server', uHeight: 1, fullDepth: true }))).id;
  const dev = async (tag: string, extra: object = {}) => (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: tag, hostname: tag.toLowerCase(), initialState: 'inventory', ...extra }))).id as string;
  ids.s1 = await dev('SRV-01', { customerId: ctx.customers.acme }); // Redfish
  ids.s2 = await dev('SRV-02'); // Redfish, OS ignores ACPI
  ids.s3 = await dev('SRV-03'); // IPMI
  ids.s4 = await dev('SRV-04'); // no control credential
  ids.pve1 = await dev('PVE1');
  ids.s5 = await dev('SRV-05'); // Redfish without BootProgress
});

afterAll(async () => {
  await bmc?.close();
  await bmc2?.close();
  await bmc3?.close();
  await files?.close();
  await pve?.close();
  await vz?.close();
  await ctx?.close();
});

beforeEach(() => {
  hooks.powerFail = false;
  hooks.tcpUp = false;
});

describe('control credentials', () => {
  it('are staff-only, write-only and encrypted', async () => {
    const body = { kind: 'redfish', host: '127.0.0.1', port: bmc.port, username: 'dcim-ctl', password: BMC_PASS, scheme: 'http' };
    expect((await noc.put(`${P}/devices/${ids.s1}/control`, body)).status).toBe(403);
    expect((await acme.put(`${P}/devices/${ids.s1}/control`, body)).status).toBe(403);
    const r = await ok(admin.put(`${P}/devices/${ids.s1}/control`, body));
    expect(JSON.stringify(r)).not.toContain(BMC_PASS);
    await ok(admin.put(`${P}/devices/${ids.s2}/control`, { ...body, port: bmc2.port }));
    await ok(admin.put(`${P}/devices/${ids.s3}/control`, { kind: 'ipmi', host: '127.0.0.1', username: 'dcim-ctl', password: 'ipmi-ctl-pw' }));
    await ok(admin.put(`${P}/devices/${ids.s5}/control`, { ...body, port: bmc3.port }));
    const [row] = await ctx.db.select().from(controlCredentials).where(eq(controlCredentials.deviceId, ids.s1));
    expect(row!.secretEnc).not.toContain(BMC_PASS);

    const staffView = await ok(admin.get(`${P}/devices/${ids.s1}/control`));
    expect(staffView).toMatchObject({ configured: true, credential: { kind: 'redfish', username: 'dcim-ctl' } });
    expect(JSON.stringify(staffView)).not.toContain(BMC_PASS);
    // The customer learns only that power control exists for its server.
    expect(await ok(acme.get(`${P}/devices/${ids.s1}/control`))).toMatchObject({ configured: true, credential: null });
    expect((await globex.get(`${P}/devices/${ids.s1}/control`)).status).toBe(404);
    expect((await acme.get(`${P}/devices/${ids.s2}/control`)).status).toBe(404);
  });
});

describe('power actions', () => {
  it('need the typed server name and a control credential', async () => {
    expect((await admin.post(`${P}/devices/${ids.s1}/power-actions`, { action: 'on', confirm: 'srv-02' })).body.error).toBe('confirmation_mismatch');
    expect((await admin.post(`${P}/devices/${ids.s4}/power-actions`, { action: 'on', confirm: 'srv-04' })).body.error).toBe('no_control_credential');
    expect((await noc.post(`${P}/devices/${ids.s1}/power-actions`, { action: 'on', confirm: 'srv-01' })).status).toBe(403);
  });

  it('a customer powers on its own server; the job completes only once the BMC reports On', async () => {
    await resetBmc(bmc, 'Off');
    const j = await ok(acme.post(`${P}/devices/${ids.s1}/power-actions`, { action: 'on', confirm: 'SRV-01' }));
    expect(j.status).toBe('queued');
    expect(j).not.toHaveProperty('secretEnc');
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
    expect(bmc.state.power).toBe('On');
    expect(bmc.state.resets).toEqual(['On']);
    expect((await stepsOf(j.id)).map((s) => [s.name, s.status])).toEqual([
      ['Check BMC access', 'done'],
      ['Power on', 'done'],
      ['Verify power state', 'done'],
    ]);
    // The customer can follow its own job; another customer cannot see it.
    expect((await ok(acme.get(`${P}/jobs/${j.id}`))).status).toBe('completed');
    expect((await globex.get(`${P}/jobs/${j.id}`)).status).toBe(404);
    expect((await ok(acme.get(`${P}/jobs`))).items.map((x: { id: string }) => x.id)).toEqual([j.id]);
    expect((await ok(globex.get(`${P}/jobs`))).items).toEqual([]);
    expect((await globex.post(`${P}/devices/${ids.s1}/power-actions`, { action: 'off', confirm: 'srv-01' })).status).toBe(404);
  });

  it('is idempotent per Idempotency-Key and allows one active job per server', async () => {
    await resetBmc(bmc, 'On');
    const send = (body: object, key?: string) => {
      const r = admin.agent.post(`${P}/devices/${ids.s1}/power-actions`).set('X-CSRF-Token', admin.csrf);
      return (key ? r.set('Idempotency-Key', key) : r).send(body);
    };
    const a = await ok(send({ action: 'off', confirm: 'srv-01' }, 'key-off-1'));
    const b = await ok(send({ action: 'off', confirm: 'srv-01' }, 'key-off-1'));
    expect(b.id).toBe(a.id);
    expect(b.replayed).toBe(true);
    expect((await send({ action: 'restart', confirm: 'srv-01' }, 'key-off-1')).status).toBe(409);
    const busy = await send({ action: 'restart', confirm: 'srv-01' }, 'key-restart-1');
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ error: 'job_in_progress', jobId: a.id });
    expect((await drive(a.id)).status).toBe('completed');
    expect(bmc.state.power).toBe('Off');
    // Nothing was sent twice.
    expect(bmc.state.resets).toEqual(['ForceOff']);
  });

  it('a repeated "on" for a server already on sends nothing and still verifies', async () => {
    await resetBmc(bmc, 'On');
    const j = await ok(admin.post(`${P}/devices/${ids.s1}/power-actions`, { action: 'on', confirm: 'srv-01' }));
    expect((await drive(j.id)).status).toBe('completed');
    expect(bmc.state.resets).toEqual([]);
    expect((await stepsOf(j.id))[1]!.detail).toMatch(/Already on; nothing sent/);
  });

  it('retries a safe step after transient BMC errors', async () => {
    await resetBmc(bmc, 'Off');
    const j = await ok(admin.post(`${P}/devices/${ids.s1}/power-actions`, { action: 'on', confirm: 'srv-01' }));
    bmc.failNext(1);
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
    expect((await stepsOf(j.id))[0]!.attempts).toBe(2);
    expect(bmc.state.resets).toEqual(['On']);
  });

  it('a graceful shutdown the OS ignores fails after its time limit instead of claiming success', async () => {
    await resetBmc(bmc2, 'On');
    const j = await ok(admin.post(`${P}/devices/${ids.s2}/power-actions`, { action: 'graceful_shutdown', confirm: 'srv-02' }));
    const done = await drive(j.id, { stepMs: 30_000 });
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/did not reach “off” within 300 s.*ignored the ACPI request/);
    expect(bmc2.state.power).toBe('On');
    // Never escalated to a hard power-off on its own.
    expect(bmc2.state.resets).toEqual(['GracefulShutdown']);
  });

  it('a graceful restart the OS ignores is not reported as done just because the server is on', async () => {
    await resetBmc(bmc2, 'On');
    const j = await ok(admin.post(`${P}/devices/${ids.s2}/power-actions`, { action: 'graceful_restart', confirm: 'srv-02' }));
    const done = await drive(j.id, { stepMs: 30_000 });
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/reported no new boot within 300 s.*ignored the ACPI request/);
    expect(bmc2.state.resets).toEqual(['GracefulRestart']);
  });

  it('an unsafe step that fails mid-way waits for a decision, not a blind retry', async () => {
    await resetBmc(bmc, 'On');
    hooks.powerFail = true;
    const j = await ok(admin.post(`${P}/devices/${ids.s1}/power-actions`, { action: 'restart', confirm: 'srv-01' }));
    const r = await drive(j.id);
    expect(r.status).toBe('recovery');
    expect((await stepsOf(j.id))[1]).toMatchObject({ name: 'Restart (hard reset)', status: 'failed', attempts: 1 });
    expect((await noc.post(`${P}/jobs/${j.id}/recovery`, { decision: 'retry' })).status).toBe(403);
    hooks.powerFail = false;
    await ok(admin.post(`${P}/jobs/${j.id}/recovery`, { decision: 'retry', note: 'checked BMC log, reset was not received' }));
    expect((await drive(j.id)).status).toBe('completed');
    expect(bmc.state.resets).toEqual(['ForceRestart']);
    // The restart is confirmed by a new boot reported by the BMC, not by "still on".
    expect((await stepsOf(j.id))[2]!.detail).toMatch(/booted again/);
    expect((await admin.post(`${P}/jobs/${j.id}/recovery`, { decision: 'retry' })).status).toBe(409);
  });

  it('a restart on a BMC that does not report boots completes but is marked not verified', async () => {
    const j = await ok(admin.post(`${P}/devices/${ids.s5}/power-actions`, { action: 'restart', confirm: 'srv-05' }));
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
    expect(done.result).toMatchObject({ verified: false });
    const detail = await ok(admin.get(`${P}/jobs/${j.id}`));
    expect(detail.events.map((e: { message: string }) => e.message).join('\n')).toMatch(/Completed, but not independently verified/);
  });

  it('IPMI offers no ACPI restart (its "soft" would leave the server off)', async () => {
    const r = await admin.post(`${P}/devices/${ids.s3}/power-actions`, { action: 'graceful_restart', confirm: 'srv-03' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('action_unsupported');
  });

  it('runs through IPMI with the password only in the environment', async () => {
    const j = await ok(admin.post(`${P}/devices/${ids.s3}/power-actions`, { action: 'on', confirm: 'srv-03' }));
    expect((await drive(j.id, { d: ipmiDeps() })).status).toBe('completed');
    expect(ipmi.state().power).toBe('on');
    const argv = readFileSync(ipmi.argsFile, 'utf8');
    expect(argv).toContain('"power","on"');
    expect(argv).not.toContain('ipmi-ctl-pw');
  });
});

describe('OS images', () => {
  it('rejects unknown template variables', async () => {
    const r = await admin.post(`${P}/images`, { name: 'Bad', family: 'rhel', isoUrl: files.url('/el9.iso'), isoSha256: sha(ISO), templateKind: 'kickstart', template: 'rootpw {{rootPassword}}' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/\{\{rootPassword\}\}/);
  });

  it('must be verified by checksum before use, and a mismatch is reported', async () => {
    const img = await ok(
      admin.post(`${P}/images`, {
        name: 'AlmaLinux 9.4',
        family: 'rhel',
        version: '9.4',
        isoUrl: files.url('/el9.iso'),
        isoSha256: sha(ISO),
        kernelUrl: files.url('/vmlinuz'),
        kernelSha256: sha(KERNEL),
        initrdUrl: files.url('/initrd.img'),
        initrdSha256: sha(INITRD),
        bootArgs: 'inst.ks={{configUrl}} ip=dhcp inst.text',
        templateKind: 'kickstart',
        template: KICKSTART,
      }),
    );
    ids.img = img.id;
    expect(img.verifyStatus).toBe('unverified');
    expect((await noc.post(`${P}/images/${img.id}/verify`)).status).toBe(403);
    const v = await ok(admin.post(`${P}/images/${img.id}/verify`));
    expect((await ok(admin.get(`${P}/images`))).find((x: { id: string }) => x.id === img.id).verifyStatus).toBe('verifying');
    expect((await drive(v.id)).status).toBe('completed');
    const [after] = await ctx.db.select().from(osImages).where(eq(osImages.id, img.id));
    expect(after).toMatchObject({ verifyStatus: 'verified', sizes: { ISO: ISO.length, kernel: KERNEL.length, initrd: INITRD.length } });

    const bad = await ok(admin.post(`${P}/images`, { name: 'Tampered', family: 'other', isoUrl: files.url('/bad.iso'), isoSha256: sha(ISO) }));
    const bv = await ok(admin.post(`${P}/images/${bad.id}/verify`));
    const bj = await drive(bv.id);
    expect(bj.status).toBe('failed');
    expect(bj.error).toMatch(/does not match its checksum/);
    const [b2] = await ctx.db.select().from(osImages).where(eq(osImages.id, bad.id));
    expect(b2!.verifyStatus).toBe('mismatch');
    ids.badImg = bad.id;

    // A queued verification that is cancelled leaves the image unverified, not stuck in "verifying".
    const q = await ok(admin.post(`${P}/images/${bad.id}/verify`));
    expect((await admin.post(`${P}/images/${bad.id}/verify`)).status).toBe(409); // one verification at a time
    // Files can't change under a running job.
    expect((await admin.put(`${P}/images/${bad.id}`, { name: 'Tampered', family: 'other', isoUrl: files.url('/el9.iso'), isoSha256: sha(ISO) })).body.error).toBe('in_use');
    await ok(admin.post(`${P}/jobs/${q.id}/cancel`));
    const [b3] = await ctx.db.select().from(osImages).where(eq(osImages.id, bad.id));
    expect(b3!.verifyStatus).toBe('unverified');

    // Changing a checksum needs a new verification.
    const copy = { ...after!, isoSha256: sha('other') };
    const upd = await ok(admin.put(`${P}/images/${bad.id}`, { name: 'Tampered', family: 'other', isoUrl: copy.isoUrl, isoSha256: copy.isoSha256 }));
    expect(upd.verifyStatus).toBe('unverified');
  });
});

describe('image downloads', () => {
  it('refuse loopback and metadata addresses unless the worker allows local mirrors', async () => {
    const img = await ok(admin.post(`${P}/images`, { name: 'Local mirror', family: 'other', isoUrl: files.url('/el9.iso'), isoSha256: sha(ISO) }));
    const hits = files.hits.length;
    const j = await ok(admin.post(`${P}/images/${img.id}/verify`));
    const done = await drive(j.id, { d: { ...deps(), imageAllowLocal: false } });
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/loopback, link-local or metadata address/);
    expect(files.hits.length).toBe(hits); // nothing was fetched
    const meta = await ok(admin.post(`${P}/images`, { name: 'Metadata', family: 'other', isoUrl: 'http://169.254.169.254/latest/meta-data', isoSha256: sha('x') }));
    const mj = await ok(admin.post(`${P}/images/${meta.id}/verify`));
    expect((await drive(mj.id, { d: { ...deps(), imageAllowLocal: false } })).error).toMatch(/metadata address/);
    const [after] = await ctx.db.select().from(osImages).where(eq(osImages.id, img.id));
    expect(after!.verifyStatus).toBe('error');
  });
});

const installBody = (extra: object = {}) => ({
  deviceId: ids.s1,
  imageId: ids.img,
  method: 'redfish_virtual_media',
  hostname: 'web-01.example.net',
  macAddress: '52:54:00:aa:bb:01',
  network: { mode: 'dhcp' },
  rootPassword: ROOT_PW,
  sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMq ops@example'],
  confirm: 'srv-01',
  wipeAcknowledged: true,
  ...extra,
});

describe('OS installation', () => {
  it('validates the request before queuing anything', async () => {
    expect((await acme.post(`${P}/installs`, installBody())).status).toBe(403);
    expect((await admin.post(`${P}/installs`, installBody({ confirm: 'srv-02' }))).body.error).toBe('confirmation_mismatch');
    expect((await admin.post(`${P}/installs`, installBody({ wipeAcknowledged: false }))).status).toBe(400);
    expect((await admin.post(`${P}/installs`, installBody({ imageId: ids.badImg }))).body.error).toBe('image_unverified');
    expect((await admin.post(`${P}/installs`, installBody({ deviceId: ids.s4, confirm: 'srv-04' }))).body.error).toBe('no_control_credential');
    expect((await admin.post(`${P}/installs`, installBody({ deviceId: ids.s3, confirm: 'srv-03' }))).body.error).toBe('method_unsupported');
    expect((await admin.post(`${P}/installs`, installBody({ method: 'pxe', macAddress: null }))).status).toBe(400);
    // Never configure an address IPAM has given to something else.
    await ctx.db.insert(ipAddresses).values({ orgId: ctx.org.id, address: '203.0.113.50', status: 'allocated', deviceId: ids.s2, prefixLength: 24 });
    const clash = await admin.post(`${P}/installs`, installBody({ network: { mode: 'static', address: '203.0.113.50', prefixLength: 24, gateway: '203.0.113.1' } }));
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('address_in_use');
    expect(await ctx.db.select().from(provisioningJobs).where(eq(provisioningJobs.kind, 'os_install'))).toEqual([]);
  });

  it('virtual media: inserts the ISO, boots it once, waits for the installer, ejects and verifies', async () => {
    await resetBmc(bmc, 'On');
    bmc.onBoot((src) => {
      if (src === 'Cd') pending.push(installer('52:54:00:aa:bb:01')());
    });
    const j = await ok(admin.post(`${P}/installs`, installBody()));
    expect(JSON.stringify(j)).not.toContain(ROOT_PW);
    expect(j).not.toHaveProperty('bootTokenHash');
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
    expect((await stepsOf(j.id)).map((s) => s.name)).toEqual([
      'Check image and settings',
      'Check BMC access',
      'Eject inserted media',
      'Insert the ISO',
      'Set one-time boot from virtual CD',
      'Start the server',
      'Wait for the installer',
      'Eject the ISO',
      'Verify the installed system',
    ]);
    expect(bmc.state.boots).toEqual(['Cd']);
    expect(bmc.state.media).toEqual({ image: null, inserted: false });
    expect(bmc.state.override.enabled).toBe('Disabled');
    // The installer got a rendered file: hashed password, no template syntax left.
    expect(ids.lastConfig).toContain('--bootproto=dhcp --hostname=web-01.example.net');
    expect(ids.lastConfig).toMatch(/rootpw --iscrypted \$6\$/);
    expect(ids.lastConfig).not.toContain(ROOT_PW);
    expect(ids.lastConfig).not.toContain('{{');
    // Inventory follows the verified result.
    const [d] = await ctx.db.select().from(devices).where(eq(devices.id, ids.s1));
    expect(d).toMatchObject({ hostname: 'web-01.example.net', os: 'AlmaLinux 9.4' });
    const hist = await ctx.db.execute<{ kind: string; summary: string }>(sql`select kind, summary from device_events where device_id = ${ids.s1} and kind = 'os_installed'`);
    expect(hist.rows).toEqual([{ kind: 'os_installed', summary: 'AlmaLinux 9.4 installed as web-01.example.net (verified)' }]);
    // Secrets and boot access are gone once the job finished.
    expect(done).toMatchObject({ secretEnc: null, bootTokenHash: null, bootMac: null });
    expect((await request(ctx.server).get('/api/v1/boot/config?mac=52:54:00:aa:bb:01')).status).toBe(404);
    const detail = await ok(admin.get(`${P}/jobs/${j.id}`));
    expect(detail.events.map((e: { message: string }) => e.message).join('\n')).toMatch(/Installer reported done/);
    const audit = JSON.stringify(await ctx.db.select().from(auditEvents));
    expect(audit).toContain('provisioning.install_completed');
    expect(audit).not.toContain(ROOT_PW);
    expect(audit).not.toContain(BMC_PASS);
  });

  it('PXE: serves the iPXE script and config, verifies over TCP on the static address', async () => {
    await resetBmc(bmc, 'Off');
    let script = '';
    bmc.onBoot((src) => {
      if (src !== 'Pxe') return;
      pending.push(
        (async () => {
          script = (await request(ctx.server).get('/api/v1/boot/ipxe?mac=52-54-00-AA-BB-02')).text;
          const ks = /inst\.ks=(\S+)/.exec(script)![1]!;
          ids.lastConfig = (await request(ctx.server).get(new URL(ks).pathname)).text;
          hooks.tcpUp = true;
        })(),
      );
    });
    const j = await ok(admin.post(`${P}/installs`, installBody({ method: 'pxe', hostname: 'db-01.example.net', macAddress: '52:54:00:aa:bb:02', network: { mode: 'static', address: '203.0.113.60', prefixLength: 24, gateway: '203.0.113.1', nameservers: ['1.1.1.1', '9.9.9.9'] }, verify: { by: 'tcp', port: 22 }, confirm: 'SRV-01' })));
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
    expect((await stepsOf(j.id)).map((s) => s.name)).toContain('Wait for network boot');
    expect(bmc.state.boots).toEqual(['Pxe']);
    expect(bmc.state.resets).toEqual(['On']);
    expect(script).toMatch(/^#!ipxe\n/);
    expect(script).toContain(`kernel ${files.url('/vmlinuz')} initrd=initrd inst.ks=${PUBLIC_URL}/api/v1/boot/config/`);
    expect(script).toContain(`initrd --name initrd ${files.url('/initrd.img')}`);
    expect(ids.lastConfig).toContain('--bootproto=static --ip=203.0.113.60 --netmask=255.255.255.0 --gateway=203.0.113.1 --nameserver=1.1.1.1,9.9.9.9 --hostname=db-01.example.net');
    expect(ids.lastConfig).toContain('--device=52:54:00:aa:bb:02');
  });

  it('PXE hands the installer out once; a server booting again after the install goes to its disk', async () => {
    await resetBmc(bmc, 'On');
    const seen: Record<string, string> = {};
    const mac = '52:54:00:aa:bb:03';
    // Nothing is handed out before DCIM starts the server.
    const j = await ok(admin.post(`${P}/installs`, installBody({ method: 'pxe', macAddress: mac, hostname: 'pxe-02.example.net', confirm: 'SRV-01' })));
    expect((await request(ctx.server).get(`/api/v1/boot/ipxe?mac=${mac}`)).text).toMatch(/not reached the boot step/);
    bmc.onBoot((src) => {
      if (src !== 'Pxe') return;
      pending.push(
        (async () => {
          seen.first = (await request(ctx.server).get(`/api/v1/boot/ipxe?mac=${mac}`)).text;
          const cfgUrl = new URL(/inst\.ks=(\S+)/.exec(seen.first)![1]!).pathname;
          const cfg = await request(ctx.server).get(cfgUrl);
          const cb = new URL(/(http:\/\/\S+\/api\/v1\/boot\/callback\/[\w-]+)/.exec(cfg.text)![1]!).pathname;
          await request(ctx.server).post(cb).send({ status: 'started' }).expect(200);
          // The installer reboots and the server network-boots again before reporting done.
          seen.again = (await request(ctx.server).get(`/api/v1/boot/ipxe?mac=${mac}`)).text;
          await request(ctx.server).post(cb).send({ status: 'done' }).expect(200);
        })(),
      );
    });
    expect((await drive(j.id)).status).toBe('completed');
    expect(seen.first).toContain('kernel ');
    expect(seen.again).toMatch(/already started[\s\S]*exit/);
    expect(bmc.state.boots).toEqual(['Pxe']);
  });

  it('a second request for the boot script before the installer reports stops the job (someone else took it)', async () => {
    await resetBmc(bmc, 'On');
    const mac = '52:54:00:aa:bb:04';
    bmc.onBoot((src) => {
      if (src !== 'Pxe') return;
      pending.push(
        (async () => {
          await request(ctx.server).get(`/api/v1/boot/ipxe?mac=${mac}`); // an impostor on the provisioning network
          await request(ctx.server).get(`/api/v1/boot/ipxe?mac=${mac}`); // the real server
        })(),
      );
    });
    const j = await ok(admin.post(`${P}/installs`, installBody({ method: 'pxe', macAddress: mac, hostname: 'pxe-03.example.net', confirm: 'SRV-01' })));
    const done = await drive(j.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/requested again .* before the installer reported/);
    expect(bmc.state.override.enabled).toBe('Disabled');
  });

  it('TCP verification ignores the previous system still answering on the address', async () => {
    await resetBmc(bmc, 'On');
    hooks.tcpUp = true; // the old OS answers on :22
    bmc.onBoot(() => undefined);
    const j = await ok(admin.post(`${P}/installs`, installBody({ hostname: 'tcp-01.example.net', confirm: 'SRV-01', network: { mode: 'static', address: '203.0.113.70', prefixLength: 24, gateway: '203.0.113.1' }, verify: { by: 'tcp', port: 22 } })));
    const mid = await drive(j.id, { max: 5 }).catch(() => null);
    expect(mid).toBeNull(); // still waiting
    const step = (await stepsOf(j.id)).find((x) => x.name === 'Wait for the installer')!;
    expect(step.detail).toMatch(/still answers \(previous system\)/);
    hooks.tcpUp = false; // installer took over
    await drive(j.id, { max: 2 }).catch(() => null);
    hooks.tcpUp = true; // new system up
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
  });

  it('a server that does not belong to an install gets an iPXE exit; boot endpoints check source networks', async () => {
    const r = await request(ctx.server).get('/api/v1/boot/ipxe?mac=52:54:00:00:00:99');
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/^#!ipxe\n[\s\S]*exit\n$/);
    expect((await request(ctx.server).get('/api/v1/boot/config/not-a-real-token-xxxxxxxxxx')).status).toBe(404);
    expect((await request(ctx.server).post('/api/v1/boot/callback/not-a-real-token-xxxxxxxxxx').send({ status: 'done' })).status).toBe(404);
    const boot = ctx.app.get(BootService);
    expect(() => boot.checkSource('8.8.8.8')).toThrow(/not available from this network/);
    expect(() => boot.checkSource('10.20.30.40')).not.toThrow();
    expect(() => boot.checkSource('::ffff:192.168.1.5')).not.toThrow();
  });

  it('an installer that reports failure fails the job and cleans up the BMC', async () => {
    await resetBmc(bmc, 'On');
    bmc.onBoot((src) => {
      if (src === 'Cd') pending.push(installer('52:54:00:aa:bb:01', 'failed')());
    });
    const j = await ok(admin.post(`${P}/installs`, installBody({ confirm: 'SRV-01' })));
    const done = await drive(j.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/installer reported a failure: anaconda: no disks found/);
    expect(bmc.state.media.inserted).toBe(false);
    expect(bmc.state.override.enabled).toBe('Disabled');
  });

  it('cancelling while the installer runs ejects the media and clears the boot override', async () => {
    await resetBmc(bmc, 'Off');
    bmc.onBoot(() => undefined); // no installer reports back
    const j = await ok(admin.post(`${P}/installs`, installBody({ confirm: 'SRV-01' })));
    // Stop before the server boots so the override is still pending.
    hooks.powerFail = true;
    const r = await drive(j.id);
    expect(r.status).toBe('recovery');
    expect(bmc.state.media.inserted).toBe(true);
    expect(bmc.state.override.enabled).toBe('Once');
    expect((await noc.post(`${P}/jobs/${j.id}/cancel`)).status).toBe(403);
    await ok(admin.post(`${P}/jobs/${j.id}/cancel`));
    const done = await drive(j.id);
    expect(done.status).toBe('cancelled');
    expect(bmc.state.media).toEqual({ image: null, inserted: false });
    expect(bmc.state.override.enabled).toBe('Disabled');
    expect(bmc.state.resets).toEqual([]);
    expect((await admin.post(`${P}/jobs/${j.id}/cancel`)).status).toBe(409);
  });

  it('a queued job is cancelled at once', async () => {
    const j = await ok(admin.post(`${P}/installs`, installBody({ confirm: 'SRV-01' })));
    expect(await ok(admin.post(`${P}/jobs/${j.id}/cancel`))).toMatchObject({ status: 'cancelled', cancelRequested: false });
    expect(await job(j.id)).toMatchObject({ status: 'cancelled', secretEnc: null, bootTokenHash: null });
  });

  it('a worker crash during "Start the server" is not repeated blindly; "skip" after checking continues the install', async () => {
    await resetBmc(bmc, 'Off');
    const j = await ok(admin.post(`${P}/installs`, installBody({ confirm: 'SRV-01' })));
    // Run up to the unsafe step, then make it look like the worker died inside it.
    hooks.powerFail = true;
    await drive(j.id);
    const startSeq = (await stepsOf(j.id)).find((s) => s.name === 'Start the server')!.seq;
    hooks.powerFail = false;
    await ok(admin.post(`${P}/jobs/${j.id}/recovery`, { decision: 'retry' }));
    await ctx.db.execute(sql`update provisioning_jobs set status = 'running', lease_until = ${new Date(clock.t - 1000).toISOString()}::timestamptz, worker_id = 'dead-worker' where id = ${j.id}`);
    await ctx.db.execute(sql`update provisioning_steps set status = 'running' where job_id = ${j.id} and seq = ${startSeq}`);
    // Meanwhile the server did start (the crashed worker's request got through).
    bmc.onBoot((src) => {
      if (src === 'Cd') pending.push(installer('52:54:00:aa:bb:01')());
    });
    await fetch(`http://127.0.0.1:${bmc.port}/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`dcim-ctl:${BMC_PASS}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ResetType: 'On' }),
    });
    while (pending.length) await pending.shift();
    const r = await drive(j.id);
    expect(r.status).toBe('recovery');
    expect((await stepsOf(j.id)).find((s) => s.seq === startSeq)!.error).toMatch(/Interrupted/);
    await ok(admin.post(`${P}/jobs/${j.id}/recovery`, { decision: 'skip', note: 'BMC shows the server powered on' }));
    const done = await drive(j.id);
    expect(done.status).toBe('completed');
    // Exactly one start reached the BMC.
    expect(bmc.state.resets).toEqual(['On']);
    expect((await stepsOf(j.id)).find((s) => s.seq === startSeq)).toMatchObject({ status: 'skipped' });
  });

  it('"fail" on a job in recovery runs cleanup and fails it', async () => {
    await resetBmc(bmc, 'Off');
    hooks.powerFail = true;
    const j = await ok(admin.post(`${P}/installs`, installBody({ confirm: 'SRV-01' })));
    expect((await drive(j.id)).status).toBe('recovery');
    await ok(admin.post(`${P}/jobs/${j.id}/recovery`, { decision: 'fail', note: 'hardware fault' }));
    const done = await drive(j.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/hardware fault/);
    expect(bmc.state.media.inserted).toBe(false);
    expect(bmc.state.override.enabled).toBe('Disabled');
  });

  it('fails at its deadline when the installer never reports', async () => {
    await resetBmc(bmc, 'Off');
    bmc.onBoot(() => undefined);
    const j = await ok(admin.post(`${P}/installs`, installBody({ confirm: 'SRV-01', timeoutMinutes: 10 })));
    const done = await drive(j.id, { stepMs: 60_000 });
    expect(done.status).toBe('failed');
    expect(done.error).toBe('The installation did not finish within 10 minutes');
    expect(bmc.state.media.inserted).toBe(false);
    expect(bmc.state.override.enabled).toBe('Disabled');
  });
});

describe('hypervisors', () => {
  it('Proxmox: read-only sync, secrets write-only, no guessed host links', async () => {
    const body = { kind: 'proxmox', name: 'PVE cluster', url: `http://127.0.0.1:${pve.port}`, verifyTls: false, tokenId: 'dcim@pve!read', tokenSecret: 'pve-read-secret-1', actionTokenId: 'dcim@pve!ops', actionTokenSecret: 'pve-ops-secret-2', syncMinutes: 5 };
    expect((await noc.post(`${V}/integrations`, body)).status).toBe(403);
    const i = await ok(admin.post(`${V}/integrations`, body));
    ids.pve = i.id;
    expect(JSON.stringify(i)).not.toMatch(/pve-read-secret-1|pve-ops-secret-2/);
    expect(i).toMatchObject({ actionsEnabled: true, secretConfigured: true });
    expect(await syncDueIntegrations(deps(), { force: i.id })).toBe(1);
    const hosts = await ok(admin.get(`${V}/hosts`));
    expect(hosts.map((h: { name: string }) => h.name)).toEqual(['pve1', 'pve2']);
    // "PVE1" exists in DCIM, but linking is an operator decision.
    expect(hosts[0].deviceId).toBeNull();
    await ok(admin.put(`${V}/hosts/${hosts[0].id}/device`, { deviceId: ids.pve1 }));
    expect((await ok(admin.get(`${V}/hosts`)))[0].deviceName).toBe('pve1');
    const guests = (await ok(admin.get(`${V}/guests`))).items;
    expect(guests.map((g: { name: string }) => g.name).sort()).toEqual(['db-01', 'dns-ct', 'web-01']); // template excluded
    // Only the read token was used for the sync.
    expect(pve.requests.every((r) => r.token === 'read')).toBe(true);
    ids.db01 = guests.find((g: { name: string }) => g.name === 'db-01').id;
    ids.web01 = guests.find((g: { name: string }) => g.name === 'web-01').id;
    ids.dnsct = guests.find((g: { name: string }) => g.name === 'dns-ct').id;
  });

  it('customers see and control only VMs assigned to them, with the action token', async () => {
    expect((await ok(acme.get(`${V}/guests`))).items).toEqual([]);
    await ok(admin.put(`${V}/guests/${ids.db01}/customer`, { customerId: ctx.customers.acme }));
    const mine = (await ok(acme.get(`${V}/guests`))).items;
    expect(mine.map((g: { name: string }) => g.name)).toEqual(['db-01']);
    expect(mine[0]).toMatchObject({ hostName: null, integrationName: null, customerName: null });
    expect((await globex.post(`${V}/guests/${ids.db01}/actions`, { action: 'start', confirm: 'db-01' })).status).toBe(404);
    expect((await acme.post(`${V}/guests/${ids.db01}/actions`, { action: 'start', confirm: 'web-01' })).body.error).toBe('confirmation_mismatch');
    const j = await ok(acme.post(`${V}/guests/${ids.db01}/actions`, { action: 'start', confirm: 'db-01' }));
    expect((await drive(j.id)).status).toBe('completed');
    expect(pve.guests.get('101')!.status).toBe('running');
    const posts = pve.requests.filter((r) => r.method === 'POST');
    expect(posts).toEqual([{ method: 'POST', url: '/api2/json/nodes/pve1/qemu/101/status/start', token: 'action' }]);
    const [g] = await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, ids.db01));
    expect(g!.status).toBe('running');
    // A reboot is verified by the uptime starting over, not by "running" before and after.
    await ok(admin.put(`${V}/guests/${ids.dnsct}/customer`, { customerId: null }));
    const rb = await ok(admin.post(`${V}/guests/${ids.dnsct}/actions`, { action: 'reboot', confirm: 'dns-ct' }));
    const rbd = await drive(rb.id);
    expect(rbd.status).toBe('completed');
    expect(rbd.result).toMatchObject({ verified: true });
    expect((await stepsOf(rb.id))[2]!.detail).toMatch(/restarted \(uptime \d+ s\)/);
    // Suspend is verified through qmpstatus, not the plain "running" status.
    const s = await ok(acme.post(`${V}/guests/${ids.db01}/actions`, { action: 'suspend', confirm: 'db-01' }));
    expect((await drive(s.id)).status).toBe('completed');
    expect(pve.guests.get('101')!.qmpstatus).toBe('paused');
  });

  it('without an action token VM actions are refused; vanished VMs are kept and marked missing', async () => {
    await ok(admin.put(`${V}/integrations/${ids.pve}`, { kind: 'proxmox', name: 'PVE cluster', url: `http://127.0.0.1:${pve.port}`, verifyTls: false, tokenId: 'dcim@pve!read', tokenSecret: 'pve-read-secret-1', syncMinutes: 5 }));
    expect((await admin.post(`${V}/guests/${ids.web01}/actions`, { action: 'stop', confirm: 'web-01' })).body.error).toBe('actions_disabled');
    pve.guests.delete('100');
    await syncDueIntegrations(deps(), { force: ids.pve });
    const [g] = await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, ids.web01));
    expect(g!.missingSince).not.toBeNull();
    const [kept] = await ctx.db.select().from(virtGuests).where(eq(virtGuests.id, ids.db01));
    expect(kept!.customerId).toBe(ctx.customers.acme);
  });

  it('Virtualizor: actions only after an explicit opt-in; the API key never leaves the worker', async () => {
    const body = { kind: 'virtualizor', name: 'VZ panel', url: `http://127.0.0.1:${vz.port}`, verifyTls: false, apiKey: 'VZKEY123', apiPass: 'vz-api-pass-77', actionsEnabled: false, syncMinutes: 10 };
    const i = await ok(admin.post(`${V}/integrations`, body));
    expect(JSON.stringify(i)).not.toMatch(/VZKEY123|vz-api-pass-77/);
    await syncDueIntegrations(deps(), { force: i.id });
    const list = (await ok(admin.get(`${V}/guests?integrationId=${i.id}`))).items;
    expect(list.map((g: { name: string; status: string; ipAddresses: string[] }) => [g.name, g.status, g.ipAddresses])).toEqual([
      ['vps11.example.net', 'running', ['203.0.113.11']],
      ['vps12.example.net', 'stopped', ['203.0.113.12']],
    ]);
    const v11 = list[0].id;
    expect((await admin.post(`${V}/guests/${v11}/actions`, { action: 'stop', confirm: 'vps11.example.net' })).body.error).toBe('actions_disabled');
    await ok(admin.put(`${V}/integrations/${i.id}`, { ...body, actionsEnabled: true }));
    const j = await ok(admin.post(`${V}/guests/${v11}/actions`, { action: 'shutdown', confirm: 'vps11.example.net' }));
    expect((await drive(j.id)).status).toBe('completed');
    expect(vz.vps.get('11')!.status).toBe(0);
    // "Shut down" is Virtualizor's graceful stop, not its hard power-off.
    expect(vz.requests.some((r) => r.params.action === 'stop' && r.params.vpsid === '11')).toBe(true);
    expect(vz.requests.some((r) => r.params.action === 'poweroff')).toBe(false);
    // Suspend/unsuspend are Virtualizor's administrative (billing) suspension: not offered.
    const sus = await admin.post(`${V}/guests/${list[1].id}/actions`, { action: 'resume', confirm: 'vps12.example.net' });
    expect(sus.body.error).toBe('action_unsupported');
    const integrations = JSON.stringify(await ok(admin.get(`${V}/integrations`)));
    expect(integrations).not.toMatch(/VZKEY123|vz-api-pass-77|pve-read-secret-1/);
    const events = JSON.stringify(await ok(admin.get(`${P}/jobs/${j.id}`)));
    expect(events).not.toMatch(/VZKEY123|vz-api-pass-77/);
  });
});
