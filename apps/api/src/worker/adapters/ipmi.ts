import { execFile } from 'node:child_process';
import type { Adapter, AdapterTarget, DiscoveryResult, PowerSnapshot, TestResult } from '../../network/discovery/types';

/**
 * IPMI v2.0 over LAN (RMCP+) through the system `ipmitool` binary, for BMCs
 * without Redfish. Only two read commands are ever run: `mc info` (test) and
 * `dcmi power reading` (power). The password is passed in the IPMI_PASSWORD
 * environment variable (`-E`), never on the command line, and no shell is used.
 */
const SAFE = /^[A-Za-z0-9._:[\]-]+$/;

export function parseDcmiPower(out: string): { watts: number | null; active: boolean | null } {
  const w = /Instantaneous power reading:\s*(\d+(?:\.\d+)?)\s*Watts/i.exec(out);
  const st = /Power reading state is:\s*(\w+)/i.exec(out);
  return { watts: w ? Number(w[1]) : null, active: st ? st[1]!.toLowerCase() === 'activated' : null };
}

export function parseMcInfo(out: string): Record<string, string> {
  const r: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^\s*([A-Za-z][A-Za-z ]+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) r[m[1]!] = m[2]!;
  }
  return r;
}

export function ipmiAdapter(binary = process.env.IPMITOOL_PATH || 'ipmitool'): Adapter {
  const run = (t: AdapterTarget, args: string[]): Promise<string> => {
    const host = t.host.replace(/^\[|\]$/g, '');
    if (!SAFE.test(host) || host.startsWith('-')) return Promise.reject(new Error('Invalid BMC address'));
    if (!t.username || !SAFE.test(t.username.replace(/[ @]/g, '_')) || t.username.startsWith('-')) return Promise.reject(new Error('Invalid IPMI user name'));
    const perTry = Math.max(1, Math.round((t.params.timeoutMs ?? 10_000) / 1000));
    const retries = t.params.retries ?? 1;
    const full = ['-I', 'lanplus', '-H', host, '-p', String(t.port ?? 623), '-U', t.username, '-E', '-L', t.params.ipmiPrivilege ?? 'USER', '-N', String(perTry), '-R', String(retries + 1), ...args];
    return new Promise((resolve, reject) => {
      execFile(
        binary,
        full,
        { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', IPMI_PASSWORD: String(t.secret.password ?? '') }, timeout: perTry * 1000 * (retries + 1) + 3000, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean };
            if (e.code === 'ENOENT') return reject(new Error('ipmitool is not installed on the worker host (apt install ipmitool)'));
            if (e.killed) return reject(new Error('IPMI request timed out'));
            const msg = String(stderr || e.message)
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, 2)
              .join(' ');
            return reject(new Error(/RAKP|password|Unauthorized|authentication/i.test(msg) ? `Authentication failed: ${msg}` : msg || 'ipmitool failed'));
          }
          resolve(String(stdout));
        },
      );
    });
  };
  return {
    async test(t): Promise<TestResult> {
      const started = Date.now();
      const info = parseMcInfo(await run(t, ['mc', 'info']));
      const vendor = info['Manufacturer Name'] ?? null;
      const product = info['Product Name'] ?? null;
      return {
        ok: true,
        message: `Connected: ${[vendor, product].filter(Boolean).join(' ') || 'IPMI BMC'}${info['Firmware Revision'] ? `, BMC firmware ${info['Firmware Revision']}` : ''}`,
        latencyMs: Date.now() - started,
        facts: { vendor, model: product, serial: null, sysName: null, osVersion: null, sysDescr: null, uptimeSeconds: null },
      };
    },
    async discover(): Promise<DiscoveryResult> {
      throw new Error('IPMI is used for power readings (use "Test"); network discovery does not apply');
    },
    async power(t): Promise<PowerSnapshot> {
      const r = parseDcmiPower(await run(t, ['dcmi', 'power', 'reading']));
      if (r.active === false) throw new Error('DCMI power reading is deactivated on this BMC');
      if (r.watts === null) throw new Error('The BMC returned no DCMI power reading (it may not support DCMI)');
      return { watts: r.watts, source: 'ipmi', detail: 'DCMI instantaneous reading' };
    },
  };
}
