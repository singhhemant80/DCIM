import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Simulated power sources, built from the published Redfish schema and the
 * documented `ipmitool dcmi power reading` output. They are simulators, not
 * captures from a specific BMC firmware.
 */

export interface MockRedfish {
  port: number;
  /** Change the reported PowerConsumedWatts. */
  setWatts: (w: number | null) => void;
  requests: { method: string; url: string }[];
  close: () => Promise<void>;
}

/** Dell-iDRAC-shaped Redfish service with one system and one chassis. */
export async function startRedfish(user: string, pass: string, opts: { watts?: number; environmentMetricsOnly?: boolean; port?: number } = {}): Promise<MockRedfish> {
  let watts: number | null = opts.watts ?? 312;
  const requests: { method: string; url: string }[] = [];
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const docs = (): Record<string, unknown> => ({
    '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] },
    '/redfish/v1/Systems/System.Embedded.1': { Manufacturer: 'Dell Inc.', Model: 'PowerEdge R650', SerialNumber: 'CN7XXXX', PowerState: 'On', HostName: 'srv-01', BiosVersion: '1.10.2' },
    '/redfish/v1/Chassis': { Members: [{ '@odata.id': '/redfish/v1/Chassis/System.Embedded.1' }] },
    '/redfish/v1/Chassis/System.Embedded.1': opts.environmentMetricsOnly
      ? { EnvironmentMetrics: { '@odata.id': '/redfish/v1/Chassis/System.Embedded.1/EnvironmentMetrics' } }
      : { Power: { '@odata.id': '/redfish/v1/Chassis/System.Embedded.1/Power' } },
    '/redfish/v1/Chassis/System.Embedded.1/Power': { PowerControl: [{ Name: 'System Power Control', PowerConsumedWatts: watts, PowerCapacityWatts: 1400 }] },
    '/redfish/v1/Chassis/System.Embedded.1/EnvironmentMetrics': { PowerWatts: { Reading: watts } },
  });
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url! });
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'Method not allowed' });
    if (req.headers.authorization !== expected) return send(401, { error: 'Unauthorized' });
    const doc = docs()[req.url!.split('?')[0]!];
    return doc === undefined ? send(404, { error: 'Not found' }) : send(200, doc);
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, setWatts: (w) => (watts = w), requests, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * A stand-in `ipmitool` executable: answers `mc info` and `dcmi power reading`
 * like the real tool, checks the password from the IPMI_PASSWORD environment
 * variable, and records its argument list so tests can check the password is
 * never on the command line.
 */
export function fakeIpmitool(password: string, opts: { watts?: number; deactivated?: boolean } = {}): { path: string; argsFile: string; setWatts: (w: number) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cdcim-ipmi-'));
  const argsFile = join(dir, 'args.log');
  const wattsFile = join(dir, 'watts');
  writeFileSync(wattsFile, String(opts.watts ?? 245));
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args) + '\\n');
if (process.env.IPMI_PASSWORD !== ${JSON.stringify(password)}) {
  process.stderr.write('Error: Unable to establish IPMI v2 / RMCP+ session\\nRAKP 2 HMAC is invalid\\n');
  process.exit(1);
}
const cmd = args.slice(-3).join(' ');
if (args.slice(-2).join(' ') === 'mc info') {
  process.stdout.write('Device ID                 : 32\\nFirmware Revision         : 7.00\\nManufacturer Name         : DELL Inc\\nProduct Name              : iDRAC\\n');
} else if (cmd === 'dcmi power reading') {
  const w = fs.readFileSync(${JSON.stringify(wattsFile)}, 'utf8').trim();
  process.stdout.write('\\n    Instantaneous power reading:                   ' + w + ' Watts\\n    Minimum during sampling period:                 180 Watts\\n    Maximum during sampling period:                 410 Watts\\n    Average power reading over sample period:       240 Watts\\n    IPMI timestamp:                           Sat Oct 10 04:00:00 2026\\n    Sampling period:                          00000005 Seconds.\\n    Power reading state is:                   ${opts.deactivated ? 'deactivated' : 'activated'}\\n');
} else {
  process.stderr.write('Invalid command\\n');
  process.exit(1);
}
`;
  const path = join(dir, 'ipmitool');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, argsFile, setWatts: (w) => writeFileSync(wattsFile, String(w)) };
}

/** RouterOS /system/health (v7 list form) and NX-OS `show environment power` bodies. */
export const ROUTEROS_HEALTH = [
  { '.id': '*1', name: 'voltage', value: '24.1', type: 'V' },
  { '.id': '*2', name: 'power-consumption', value: '38.5', type: 'W' },
  { '.id': '*3', name: 'temperature', value: '41', type: 'C' },
];
export const NXOS_POWER = {
  power_summary: { ps_redun_mode: 'Redundant', tot_pow_capacity: '1100.00 W', tot_pow_input_actual_draw: '287.00 W', tot_pow_out_actual_draw: '262.00 W' },
  powersup: { TABLE_psinfo: { ROW_psinfo: [{ psnum: 1, psmodel: 'NXA-PAC-650W-PE', actual_input: '144 W', actual_out: '131 W', ps_status: 'Ok' }, { psnum: 2, psmodel: 'NXA-PAC-650W-PE', actual_input: '143 W', actual_out: '131 W', ps_status: 'Ok' }] } },
};
