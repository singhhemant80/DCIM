import { execFileSync } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { pxeDesiredSchema, renderDnsmasq, renderHosts, renderNexoraIpxe, type PxeDesired } from '../provisioning/pxe/render';

/**
 * Applies the PXE settings NexoraDC's worker asked for. Runs as root (from the
 * crapplet-dcim-pxe-apply systemd unit), so it trusts nothing in the input:
 *
 *  - the desired-state file must be a regular file (not a link) owned by the
 *    NexoraDC service user, at most 1 MiB, and pass the strict schema;
 *  - all output goes to a root-owned directory given on the command line;
 *  - the iPXE binaries come from the release directory, not from the input.
 *
 * Then dnsmasq is restarted (configuration changed), reloaded with SIGHUP
 * (only the list of active MACs changed) or stopped (disabled).
 *
 * Usage: pxe-apply --desired FILE --out DIR --ipxe DIR --owner USER [--service NAME] [--dnsmasq-user USER] [--dnsmasq-group GROUP] [--no-systemctl]
 */

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : def;
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

async function readDesired(path: string, ownerUid: number): Promise<PxeDesired | null> {
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('The desired-state file cannot be opened (it must be a regular file, not a link)');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('The desired-state file is not a regular file');
    if (st.uid !== ownerUid) throw new Error('The desired-state file is not owned by the NexoraDC service user');
    if (st.size > 1024 * 1024) throw new Error('The desired-state file is too large');
    let raw: unknown;
    try {
      raw = JSON.parse(await fh.readFile('utf8'));
    } catch {
      throw new Error('The desired-state file is not valid JSON');
    }
    const r = pxeDesiredSchema.safeParse(raw);
    // Field paths only: no values from the file reach the (world-readable) status.
    if (!r.success) throw new Error(`The desired state was rejected (${r.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')})`);
    return r.data;
  } finally {
    await fh.close();
  }
}

/** Writes a file only if its content changed; returns whether it did. */
async function writeIfChanged(path: string, content: string | Buffer, mode = 0o644): Promise<boolean> {
  const cur = await fs.readFile(path).catch(() => null);
  if (cur && Buffer.compare(cur, Buffer.from(content)) === 0) return false;
  const tmp = `${path}.tmp-${process.pid}`;
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, path);
  return true;
}

function uidOf(user: string): number {
  return Number(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim());
}

async function main() {
  const desiredPath = arg('desired');
  // Absolute: dnsmasq does not run from this directory.
  const out = resolve(arg('out'));
  const ipxeDir = resolve(arg('ipxe'));
  const owner = arg('owner');
  const service = arg('service', 'crapplet-dcim-pxe');
  const dnsUser = arg('dnsmasq-user', 'dnsmasq');
  const dnsGroup = arg('dnsmasq-group', 'nogroup');
  const useSystemctl = !process.argv.includes('--no-systemctl');
  const status = async (s: Record<string, unknown>) => writeIfChanged(join(out, 'status.json'), JSON.stringify({ at: new Date().toISOString(), ...s }, null, 2));
  const systemctl = (...a: string[]) => {
    if (useSystemctl) execFileSync('systemctl', a, { stdio: 'ignore' });
  };

  await fs.mkdir(out, { recursive: true, mode: 0o755 });
  const hostsDir = join(out, 'hosts');
  const tftp = join(out, 'tftp');
  await fs.mkdir(hostsDir, { recursive: true, mode: 0o755 });
  await fs.mkdir(tftp, { recursive: true, mode: 0o755 });

  let d: PxeDesired | null;
  try {
    d = await readDesired(desiredPath, uidOf(owner));
  } catch (e) {
    await status({ ok: false, enabled: false, error: (e as Error).message });
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  if (!d || !d.enabled) {
    systemctl('stop', service);
    await status({ ok: true, enabled: false, running: false });
    return;
  }

  // iPXE binaries from the release (BIOS proxy mode asks for "<name>.0").
  const bins: [string, string][] = [
    ['undionly.kpxe', 'undionly.kpxe'],
    ['undionly.kpxe', 'undionly.0'],
    ['snponly.efi', 'snponly.efi'],
    ['ipxe.efi', 'ipxe.efi'],
  ];
  for (const [src, dst] of bins) await writeIfChanged(join(tftp, dst), await fs.readFile(join(ipxeDir, src)));
  await writeIfChanged(join(tftp, 'nexora.ipxe'), renderNexoraIpxe(d));

  // Leases are rewritten by dnsmasq after it drops to its own user.
  const leases = join(out, 'leases');
  await fs.mkdir(leases, { recursive: true, mode: 0o750 });
  try {
    await fs.chown(leases, uidOf(dnsUser), Number(execFileSync('getent', ['group', dnsGroup], { encoding: 'utf8' }).split(':')[2]));
  } catch {
    /* tests run unprivileged */
  }
  const confChanged = await writeIfChanged(join(out, 'dnsmasq.conf'), renderDnsmasq(d, { hostsDir, tftpRoot: tftp, leaseFile: join(leases, 'dnsmasq.leases'), user: dnsUser, group: dnsGroup }));
  const hostsChanged = await writeIfChanged(join(hostsDir, 'active'), renderHosts(d));
  let running = true;
  try {
    if (useSystemctl) {
      const active = (() => {
        try {
          execFileSync('systemctl', ['is-active', '--quiet', service]);
          return true;
        } catch {
          return false;
        }
      })();
      if (confChanged || !active) systemctl('restart', service);
      // dnsmasq adds new host entries by itself but forgets removed ones only on SIGHUP.
      else if (hostsChanged) systemctl('kill', '--signal=HUP', service);
      execFileSync('systemctl', ['is-active', '--quiet', service]);
    }
  } catch {
    running = false;
  }
  await status({
    ok: running,
    enabled: true,
    running,
    mode: d.mode,
    activeMacs: d.macs.length,
    // Lets an install job wait until its server will be answered before restarting it.
    macs: d.mode === 'external' ? [] : [...new Set(d.macs)].sort(),
    error: running ? null : `The PXE service (${service}) did not start: check "journalctl -u ${service}" (port 67/69 in use by another DHCP/TFTP server, or the interface name is wrong)`,
  });
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
