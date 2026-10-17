/**
 * Real network boot against a running NexoraDC (dev API on :4000 + worker):
 * uploads an ISO, sets the PXE service to "external DHCP" (QEMU's built-in
 * DHCP/TFTP plays the customer's DHCP server), queues an automatic network
 * install on a server whose BMC is simulated, and when the BMC is asked to
 * restart the server, boots a QEMU machine from the network. QEMU loads
 * NexoraDC's iPXE build over TFTP, which chains to the API, downloads the
 * kernel and initrd under the job's token and boots them; the test initramfs
 * fetches its autoinstall config and reports "done" through the callback.
 *
 * Usage: npx tsx test/manual/qemu-pxe.ts <iso> [base=http://127.0.0.1:4000]
 *   UEFI=1      boot with OVMF (snponly.efi) instead of legacy BIOS (undionly.kpxe)
 *   MODE=dhcp   NexoraDC's dnsmasq gives the address, on bridge nxbr0 (10.77.0.1/24) with taps nxtap0/nxtap1
 *   MODE=proxy  same bridge, with another DHCP server on it; NexoraDC answers as proxy DHCP
 * Needs qemu-system-x86_64, dnsmasq (bridged modes), ovmf (UEFI) and a dev API + worker running.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControlRedfish } from '../simulators/provisioning-devices';

const iso = process.argv[2]!;
const API = process.argv[3] ?? 'http://127.0.0.1:4000';
const OUT = '.data/pxe-out';
const LOG = join(tmpdir(), 'nexora-qemu-boot.log');
let cookie = '';
let csrf = '';
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, 'x-csrf-token': csrf, ...(body instanceof Uint8Array ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) {
    cookie = set.map((c) => c.split(';')[0]).join('; ');
    const c = set.find((s) => s.startsWith('cdcim_csrf='));
    if (c) csrf = decodeURIComponent(c.split(';')[0]!.split('=')[1]!);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
/** A writable copy of the OVMF variable store (UEFI=1). */
function uefiVars() {
  const f = join(tmpdir(), 'nexora-ovmf-vars.fd');
  copyFileSync('/usr/share/OVMF/OVMF_VARS_4M.fd', f);
  return f;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

async function main() {
  await call('POST', '/api/v1/auth/login', { email: 'ops@crapplet.example', password: 'Glass-Rack-Orbit-2026!' });
  const data = new Uint8Array(readFileSync(iso));
  const name = `QEMU boot test ${Date.now()}`;
  const img = await call('POST', '/api/v1/provisioning/images/upload', { name, fileName: 'boot-test.iso', size: data.length });
  for (let off = 0; off < data.length; off += 8 * 1024 * 1024) await call('PUT', `/api/v1/provisioning/images/${img.id}/upload`, data.subarray(off, off + 8 * 1024 * 1024), { 'upload-offset': String(off), 'content-type': 'application/octet-stream' });
  await call('POST', `/api/v1/provisioning/images/${img.id}/upload/complete`, {});
  log(`uploaded ${data.length} bytes; preparing`);
  let row: { uploadStatus: string; bootKind: string; processError: string | null; templateKind: string; template: string } | undefined;
  for (let i = 0; i < 60; i++) {
    row = ((await call('GET', '/api/v1/provisioning/images')) as (typeof row & { id: string })[]).find((x) => x!.id === img.id);
    if (row && row.uploadStatus !== 'processing') break;
    await sleep(1000);
  }
  log(`image ${row?.uploadStatus} (${row?.bootKind}) ${row?.processError ?? ''}`);
  if (row?.uploadStatus !== 'ready') throw new Error('image not ready');
  // Kernel messages on the serial console, so the boot can be followed here.
  await call('PUT', `/api/v1/provisioning/images/${img.id}/settings`, { name, templateKind: row.templateKind, template: row.template, bootArgs: 'console=ttyS0', enabled: true });
  // MODE=dhcp: NexoraDC's own dnsmasq hands out the address on a bridge (nxbr0, 10.77.0.1/24) that QEMU joins through a tap.
  const bridged = process.env.MODE === 'dhcp' || process.env.MODE === 'proxy';
  const proxy = process.env.MODE === 'proxy';
  if (bridged) {
    // The dev API listens on loopback only: forward 10.77.0.1:4000 to it.
    const net = await import('node:net');
    net.createServer((c) => {
      const u = net.connect(4000, '127.0.0.1');
      c.pipe(u).pipe(c);
      c.on('error', () => u.destroy());
      u.on('error', () => c.destroy());
    }).listen(4000, '10.77.0.1');
  }
  await call(
    'PUT',
    '/api/v1/provisioning/pxe',
    proxy
      ? { enabled: true, mode: 'proxy', interface: 'nxbr0', serverAddress: '10.77.0.1', proxyNetworks: ['10.77.0.0/24'], bootBaseUrl: 'http://10.77.0.1:4000', allowNetworks: ['127.0.0.0/8'] }
      : bridged
      ? { enabled: true, mode: 'dhcp', interface: 'nxbr0', serverAddress: '10.77.0.1', ranges: [{ network: '10.77.0.0/24', start: '10.77.0.100', end: '10.77.0.150', gateway: '10.77.0.1', dns: [] }], bootBaseUrl: 'http://10.77.0.1:4000', allowNetworks: ['127.0.0.0/8'] }
      : { enabled: true, mode: 'external', serverAddress: '10.0.2.2', bootBaseUrl: 'http://10.0.2.2:4000', allowNetworks: ['127.0.0.0/8'] },
  );

  const bmc = await startControlRedfish('qemu-ctl', 'qemu-ctl-pass-1234', { initialPower: 'On' });
  const m = await call('GET', '/api/v1/dcim/models');
  const models = { items: (Array.isArray(m) ? m : m.items) as { id: string }[] };
  const tag = `QEMU-${Date.now() % 100000}`;
  const dev = await call('POST', '/api/v1/dcim/devices', { modelId: models.items[0]!.id, assetTag: tag, hostname: tag.toLowerCase(), initialState: 'inventory' });
  await call('PUT', `/api/v1/provisioning/devices/${dev.id}/control`, { kind: 'redfish', host: '127.0.0.1', port: bmc.port, username: 'qemu-ctl', password: 'qemu-ctl-pass-1234', scheme: 'http' });

  let qemu: ReturnType<typeof spawn> | null = null;
  let dns: ReturnType<typeof spawn> | null = null;
  let stranger: ReturnType<typeof spawn> | null = null;
  writeFileSync(`${LOG}.dnsmasq`, '');
  bmc.onBoot((src) => {
    log(`BMC: server restarted, one-time boot from ${src}`);
    if (src !== 'Pxe' || qemu) return;
    log(`PXE helper status: ${readFileSync(`${OUT}/status.json`, 'utf8').replace(/\s+/g, ' ')}`);
    log(`nexora.ipxe: ${readFileSync(`${OUT}/tftp/nexora.ipxe`, 'utf8').split('\n')[2]}`);
    writeFileSync(LOG, '');
    const uefi = process.env.UEFI === '1';
    if (bridged) {
      // A second machine with an unknown MAC on the same network must get nothing.
      stranger = spawn('qemu-system-x86_64', ['-m', '256', '-nographic', '-no-reboot', '-boot', 'n', '-netdev', 'tap,id=n0,ifname=nxtap1,script=no,downscript=no', '-device', 'virtio-net-pci,netdev=n0,mac=52:54:00:99:99:99'], { stdio: 'ignore' });
    }
    qemu = spawn('qemu-system-x86_64', ['-m', '1024', '-nographic', '-no-reboot', ...(uefi ? ['-drive', 'if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd', '-drive', `if=pflash,format=raw,file=${uefiVars()}`] : []), '-boot', 'n', '-netdev', bridged ? 'tap,id=n0,ifname=nxtap0,script=no,downscript=no' : `user,id=n0,tftp=${OUT}/tftp,bootfile=${uefi ? 'snponly.efi' : 'undionly.kpxe'}`, '-device', 'virtio-net-pci,netdev=n0,mac=52:54:00:12:34:56'], { stdio: ['ignore', 'pipe', 'pipe'] });
    qemu.stdout!.on('data', (c: Buffer) => writeFileSync(LOG, c, { flag: 'a' }));
    qemu.stderr!.on('data', (c: Buffer) => writeFileSync(LOG, c, { flag: 'a' }));
  });

  // What the systemd path unit does: run the root helper whenever the worker's desired state changes,
  // and (re)start dnsmasq (crapplet-dcim-pxe) with the rendered configuration.
  let lastConf = '';
  const applyLoop = setInterval(() => {
    try {
      execFileSync('npx', ['tsx', 'src/cli/pxe-apply.ts', '--desired', '.data/pxe/desired.json', '--out', OUT, '--ipxe', '../../deploy/pxe/ipxe', '--owner', 'root', '--no-systemctl', '--dnsmasq-user', 'root', '--dnsmasq-group', 'root']);
    } catch {
      /* status.json says why */
    }
    if (!bridged) return;
    const conf = readFileSync(`${OUT}/dnsmasq.conf`, 'utf8');
    if (conf !== lastConf) {
      lastConf = conf;
      dns?.kill();
      dns = spawn('dnsmasq', ['--keep-in-foreground', `--conf-file=${OUT}/dnsmasq.conf`], { stdio: ['ignore', 'pipe', 'pipe'] });
      dns.stderr!.on('data', (c: Buffer) => writeFileSync(`${LOG}.dnsmasq`, c, { flag: 'a' }));
    } else dns?.kill('SIGHUP');
  }, 2000);
  const job = await call('POST', '/api/v1/provisioning/installs', {
    deviceId: dev.id,
    imageId: img.id,
    method: 'pxe',
    mode: 'automatic',
    hostname: 'qemu-test.example.net',
    macAddress: '52:54:00:12:34:56',
    network: { mode: 'dhcp' },
    rootPassword: 'Qemu-Test-Root-Pass-1',
    confirm: tag,
    wipeAcknowledged: true,
  });
  log(`install job ${job.id} queued`);
  let last = '';
  for (let i = 0; i < 400; i++) {
    const j = await call('GET', `/api/v1/provisioning/jobs/${job.id}`);
    const line = `${j.status} · ${(j.steps ?? []).filter((s: { status: string }) => s.status !== 'pending').map((s: { name: string; status: string }) => `${s.name}: ${s.status}`).slice(-1)[0] ?? ''}`;
    if (line !== last) log(`job: ${line}`);
    last = line;
    if (['completed', 'failed', 'cancelled', 'recovery'].includes(j.status)) {
      log(`job finished: ${j.status} ${j.error ?? ''}`);
      for (const e of j.events ?? []) log(`  event: ${e.message}`);
      break;
    }
    await sleep(1500);
  }
  const serial = readFileSync(LOG, 'utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  log('--- QEMU serial (selected lines) ---');
  for (const l of serial.split(/\r?\n/)) if (/iPXE 2|nexora|NexoraDC|http:\/\/10\.0\.2\.2|NEXORA-TEST|fqdn|Linux version|"ok":true/i.test(l)) process.stdout.write(`  ${l.slice(0, 220)}\n`);
  (qemu as ReturnType<typeof spawn> | null)?.kill();
  (stranger as ReturnType<typeof spawn> | null)?.kill();
  clearInterval(applyLoop);
  (dns as ReturnType<typeof spawn> | null)?.kill();
  if (bridged) {
    log('--- dnsmasq log (DHCP/TFTP) ---');
    for (const l of readFileSync(`${LOG}.dnsmasq`, 'utf8').split('\n')) if (/DHCPOFFER|DHCPACK|PXE|proxy|ignored|sent .*kpxe|sent .*\.0 |sent .*ipxe|sent .*efi|started|52:54:00:99/i.test(l)) process.stdout.write(`  ${l.slice(0, 200)}\n`);
  }
  await bmc.close();
  process.exit(0);
}
main().catch((e) => {
  process.stderr.write(`${(e as Error).stack}\n`);
  process.exit(1);
});
