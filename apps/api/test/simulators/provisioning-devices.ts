import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Simulated control targets for Phase 6: a Redfish BMC that changes power,
 * boot override and virtual media, a stand-in `ipmitool` with chassis
 * commands, Proxmox VE and Virtualizor APIs, and a file server for images.
 * They follow the published API shapes (DMTF Redfish schema, Proxmox
 * /api2/json, Virtualizor admin API docs); they are not captures of a
 * particular firmware or panel version.
 */

const listen = async (server: http.Server, port = 0) => {
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
};
const closer = (server: http.Server) => () => new Promise<void>((r) => server.close(() => r()));
const readBody = (req: http.IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve(null);
      }
    });
  });

/* ------------------------------------------------------------------ Redfish BMC */

export interface ControlRedfish {
  port: number;
  state: {
    power: 'On' | 'Off';
    override: { enabled: 'Disabled' | 'Once' | 'Continuous'; target: string };
    media: { image: string | null; inserted: boolean };
    /** Boot sources used, in order (one entry per power-on/restart). */
    boots: string[];
    resets: string[];
  };
  /** Next N requests fail with HTTP 503 (transient BMC trouble). */
  failNext: (n: number) => void;
  /** Hook run on each boot with the device the server booted from. */
  onBoot: (fn: (source: string) => void) => void;
  requests: { method: string; url: string; body?: unknown }[];
  close: () => Promise<void>;
}

/**
 * Stateful Redfish service. Power changes take effect after `powerDelayMs`;
 * a one-time boot override is consumed by the next start, as on real BMCs.
 * `ignoreGraceful` simulates an OS that never acts on ACPI shutdown.
 */
export async function startControlRedfish(user: string, pass: string, opts: { port?: number; powerDelayMs?: number; ignoreGraceful?: boolean; resetTypes?: string[]; noVirtualMedia?: boolean; noBootProgress?: boolean; initialPower?: 'On' | 'Off' } = {}): Promise<ControlRedfish> {
  const SYS = '/redfish/v1/Systems/System.Embedded.1';
  const CD = '/redfish/v1/Managers/iDRAC.Embedded.1/VirtualMedia/CD';
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const state: ControlRedfish['state'] = { power: opts.initialPower ?? 'Off', override: { enabled: 'Disabled', target: 'None' }, media: { image: null, inserted: false }, boots: [], resets: [] };
  const requests: ControlRedfish['requests'] = [];
  const allowed = opts.resetTypes ?? ['On', 'ForceOff', 'GracefulShutdown', 'ForceRestart', 'GracefulRestart', 'PowerCycle', 'Nmi'];
  let failures = 0;
  let bootHook: (s: string) => void = () => undefined;
  let lastBoot = '2026-10-01T00:00:00Z';
  const boot = () => {
    lastBoot = new Date(Date.now() + state.boots.length).toISOString();
    const src = state.override.enabled !== 'Disabled' ? state.override.target : 'Hdd';
    if (state.override.enabled === 'Once') state.override = { enabled: 'Disabled', target: 'None' };
    state.boots.push(src);
    bootHook(src);
  };
  const later = (fn: () => void) => (opts.powerDelayMs ? setTimeout(fn, opts.powerDelayMs) : fn());
  const docs = (): Record<string, unknown> => ({
    '/redfish/v1/Systems': { Members: [{ '@odata.id': SYS }] },
    [SYS]: {
      PowerState: state.power,
      ...(opts.noBootProgress ? {} : { BootProgress: { LastState: state.power === 'On' ? 'OSRunning' : 'None', LastStateTime: lastBoot } }),
      Boot: { BootSourceOverrideEnabled: state.override.enabled, BootSourceOverrideTarget: state.override.target, 'BootSourceOverrideTarget@Redfish.AllowableValues': ['None', 'Pxe', 'Cd', 'Hdd', 'BiosSetup'] },
      Actions: { '#ComputerSystem.Reset': { target: `${SYS}/Actions/ComputerSystem.Reset`, 'ResetType@Redfish.AllowableValues': allowed } },
    },
    '/redfish/v1/Managers': { Members: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1' }] },
    '/redfish/v1/Managers/iDRAC.Embedded.1': opts.noVirtualMedia ? { Id: 'iDRAC.Embedded.1' } : { Id: 'iDRAC.Embedded.1', VirtualMedia: { '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1/VirtualMedia' } },
    '/redfish/v1/Managers/iDRAC.Embedded.1/VirtualMedia': { Members: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1/VirtualMedia/RemovableDisk' }, { '@odata.id': CD }] },
    '/redfish/v1/Managers/iDRAC.Embedded.1/VirtualMedia/RemovableDisk': { MediaTypes: ['USBStick'], Inserted: false, Image: null },
    [CD]: { MediaTypes: ['CD', 'DVD'], Inserted: state.media.inserted, Image: state.media.image, ConnectedVia: state.media.inserted ? 'URI' : 'NotConnected' },
  });
  const server = http.createServer(async (req, res) => {
    const body = req.method === 'GET' ? undefined : await readBody(req);
    requests.push({ method: req.method!, url: req.url!, body });
    const send = (status: number, b?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(b === undefined ? '' : JSON.stringify(b));
    };
    if (req.headers.authorization !== expected) return send(401, { error: { message: 'Unauthorized' } });
    if (failures > 0) {
      failures--;
      return send(503, { error: { message: 'Service temporarily unavailable' } });
    }
    const path = req.url!.split('?')[0]!;
    if (req.method === 'GET') {
      const doc = docs()[path];
      return doc === undefined ? send(404, { error: { message: 'Not found' } }) : send(200, doc);
    }
    if (req.method === 'POST' && path === `${SYS}/Actions/ComputerSystem.Reset`) {
      const t = (body as { ResetType?: string } | null)?.ResetType ?? '';
      if (!allowed.includes(t)) return send(400, { error: { message: `ResetType ${t} not supported` } });
      state.resets.push(t);
      if (t === 'On') {
        if (state.power === 'On') return send(409, { error: { message: 'Server is already powered ON.' } });
        later(() => {
          state.power = 'On';
          boot();
        });
      } else if (t === 'ForceOff') later(() => (state.power = 'Off'));
      else if (t === 'GracefulShutdown') {
        if (!opts.ignoreGraceful) later(() => (state.power = 'Off'));
      } else if (t === 'ForceRestart' || t === 'PowerCycle' || (t === 'GracefulRestart' && !opts.ignoreGraceful)) {
        if (state.power === 'Off' && t !== 'PowerCycle') return send(409, { error: { message: 'Server is powered OFF.' } });
        later(() => {
          state.power = 'On';
          boot();
        });
      }
      return send(204);
    }
    if (req.method === 'PATCH' && path === SYS) {
      const b = (body as { Boot?: { BootSourceOverrideEnabled?: string; BootSourceOverrideTarget?: string } } | null)?.Boot;
      if (!b) return send(400, { error: { message: 'Bad request' } });
      if (b.BootSourceOverrideEnabled) state.override.enabled = b.BootSourceOverrideEnabled as ControlRedfish['state']['override']['enabled'];
      if (b.BootSourceOverrideTarget) state.override.target = b.BootSourceOverrideTarget;
      if (state.override.enabled === 'Disabled') state.override.target = 'None';
      return send(204);
    }
    if (req.method === 'POST' && path === `${CD}/Actions/VirtualMedia.InsertMedia` && !opts.noVirtualMedia) {
      const img = (body as { Image?: string } | null)?.Image;
      if (!img) return send(400, { error: { message: 'Image required' } });
      if (state.media.inserted) return send(409, { error: { message: 'Virtual media is already attached' } });
      state.media = { image: img, inserted: true };
      return send(204);
    }
    if (req.method === 'POST' && path === `${CD}/Actions/VirtualMedia.EjectMedia` && !opts.noVirtualMedia) {
      state.media = { image: null, inserted: false };
      return send(204);
    }
    return send(405, { error: { message: 'Method not allowed' } });
  });
  const port = await listen(server, opts.port);
  return { port, state, requests, failNext: (n) => (failures = n), onBoot: (fn) => (bootHook = fn), close: closer(server) };
}

/* ------------------------------------------------------------------ ipmitool */

/**
 * A stand-in `ipmitool` with chassis power/bootdev/bootparam commands. State
 * lives in a JSON file so successive invocations see each other's changes.
 * Records argv so tests can check the password never appears on it.
 */
export function fakeIpmitoolControl(password: string, opts: { power?: 'on' | 'off' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdcim-ipmictl-'));
  const argsFile = join(dir, 'args.log');
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ power: opts.power ?? 'off', bootdev: null, boots: [] }));
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args) + '\\n');
if (process.env.IPMI_PASSWORD !== ${JSON.stringify(password)}) {
  process.stderr.write('Error: Unable to establish IPMI v2 / RMCP+ session\\nRAKP 2 HMAC is invalid\\n');
  process.exit(1);
}
const s = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(s));
const i = args.indexOf('chassis');
const cmd = i >= 0 ? args.slice(i + 1) : [];
const start = () => { s.boots.push(s.bootdev || 'disk'); s.bootdev = null; };
if (cmd[0] === 'power') {
  const a = cmd[1];
  if (a === 'status') { process.stdout.write('Chassis Power is ' + s.power + '\\n'); process.exit(0); }
  if (a === 'on') { if (s.power === 'off') { s.power = 'on'; start(); } }
  else if (a === 'off' || a === 'soft') s.power = 'off';
  else if (a === 'reset' || a === 'cycle') { if (s.power === 'off' && a === 'reset') { process.stderr.write('Unable to set Chassis Power Control to Reset\\n'); process.exit(1); } s.power = 'on'; start(); }
  else { process.stderr.write('Invalid command\\n'); process.exit(1); }
  save();
  process.stdout.write('Chassis Power Control: ' + a + '\\n');
} else if (cmd[0] === 'bootdev') {
  s.bootdev = cmd[1] === 'none' ? null : cmd[1];
  save();
  process.stdout.write('Set Boot Device to ' + cmd[1] + '\\n');
} else if (cmd[0] === 'bootparam' && cmd[1] === 'get' && cmd[2] === '5') {
  process.stdout.write('Boot parameter version: 1\\nBoot parameter 5 is valid/unlocked\\nBoot parameter data: ' + (s.bootdev ? 'a004000000' : '0004000000') + '\\n Boot Flags :\\n   - Boot Flag ' + (s.bootdev ? 'Valid' : 'Invalid') + '\\n   - Options apply to only next boot\\n   - BIOS PC Compatible (legacy) boot\\n   - Boot Device Selector : ' + (s.bootdev === 'pxe' ? 'Force PXE' : 'No override') + '\\n');
} else {
  process.stderr.write('Invalid command\\n');
  process.exit(1);
}
`;
  const path = join(dir, 'ipmitool');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return {
    path,
    argsFile,
    state: () => JSON.parse(readFileSync(stateFile, 'utf8')) as { power: 'on' | 'off'; bootdev: string | null; boots: string[] },
  };
}

/* ------------------------------------------------------------------ Proxmox VE */

export interface MockProxmox {
  port: number;
  guests: Map<string, { node: string; type: 'qemu' | 'lxc'; name: string; status: string; qmpstatus?: string; startedAt?: number }>;
  requests: { method: string; url: string; token: string | null }[];
  close: () => Promise<void>;
}

/** Proxmox VE API with one read token (PVEAuditor) and one action token (PVEVMUser). */
export async function startProxmox(read: { id: string; secret: string }, action: { id: string; secret: string } | null, opts: { actionDelayMs?: number; port?: number } = {}): Promise<MockProxmox> {
  const guests: MockProxmox['guests'] = new Map([
    ['100', { node: 'pve1', type: 'qemu', name: 'web-01', status: 'running', qmpstatus: 'running', startedAt: Date.now() - 86_400_000 }],
    ['101', { node: 'pve1', type: 'qemu', name: 'db-01', status: 'stopped', qmpstatus: 'stopped' }],
    ['200', { node: 'pve2', type: 'lxc', name: 'dns-ct', status: 'running', startedAt: Date.now() - 3_600_000 }],
    ['9000', { node: 'pve1', type: 'qemu', name: 'tmpl-debian', status: 'stopped' }],
  ]);
  const requests: MockProxmox['requests'] = [];
  const server = http.createServer(async (req, res) => {
    const m = /^PVEAPIToken=([^=]+)=(.+)$/.exec(String(req.headers.authorization ?? ''));
    const who = m && m[1] === read.id && m[2] === read.secret ? 'read' : m && action && m[1] === action.id && m[2] === action.secret ? 'action' : null;
    requests.push({ method: req.method!, url: req.url!, token: who });
    if (req.method !== 'GET') await readBody(req);
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status < 400 ? { data } : { data: null, errors: data }));
    };
    if (!who) return send(401, { message: 'authentication failure' });
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET') {
      if (p === '/api2/json/version') return send(200, { version: '8.2.4', release: '8.2' });
      if (p === '/api2/json/nodes')
        return send(200, [
          { node: 'pve1', status: 'online', cpu: 0.231, maxcpu: 32, mem: 68719476736, maxmem: 137438953472, uptime: 864000 },
          { node: 'pve2', status: 'online', cpu: 0.05, maxcpu: 16, mem: 8589934592, maxmem: 68719476736, uptime: 3600 },
        ]);
      if (p === '/api2/json/cluster/resources')
        return send(
          200,
          [...guests].map(([id, g]) => ({ id: `${g.type}/${id}`, vmid: Number(id), node: g.node, type: g.type, name: g.name, status: g.status, maxcpu: 2, maxmem: 4294967296, maxdisk: 34359738368, uptime: g.startedAt && g.status === 'running' ? Math.floor((Date.now() - g.startedAt) / 1000) : 0, template: id === '9000' ? 1 : 0 })),
        );
      const st = /^\/api2\/json\/nodes\/([\w.-]+)\/(qemu|lxc)\/(\d+)\/status\/current$/.exec(p);
      if (st) {
        const g = guests.get(st[3]!);
        if (!g || g.node !== st[1] || g.type !== st[2]) return send(500, { message: `Configuration file 'nodes/${st[1]}/${st[2]}/${st[3]}.conf' does not exist` });
        return send(200, { vmid: Number(st[3]), status: g.status, uptime: g.startedAt && g.status === 'running' ? Math.floor((Date.now() - g.startedAt) / 1000) : 0, ...(g.type === 'qemu' ? { qmpstatus: g.qmpstatus ?? g.status } : {}) });
      }
      return send(404, { message: 'not found' });
    }
    const act = /^\/api2\/json\/nodes\/([\w.-]+)\/(qemu|lxc)\/(\d+)\/status\/(start|stop|shutdown|reboot|suspend|resume)$/.exec(p);
    if (req.method === 'POST' && act) {
      if (who !== 'action') return send(403, { message: `Permission check failed (/vms/${act[3]}, VM.PowerMgmt)` });
      const g = guests.get(act[3]!);
      if (!g) return send(500, { message: 'VM does not exist' });
      const apply = () => {
        const a = act[4]!;
        if (a === 'start' || a === 'reboot') Object.assign(g, { status: 'running', qmpstatus: 'running', startedAt: Date.now() });
        if (a === 'resume') Object.assign(g, { status: 'running', qmpstatus: 'running' });
        if (a === 'stop' || a === 'shutdown') Object.assign(g, { status: 'stopped', qmpstatus: 'stopped', startedAt: undefined });
        if (a === 'suspend') Object.assign(g, { status: 'running', qmpstatus: 'paused' });
      };
      if (opts.actionDelayMs) setTimeout(apply, opts.actionDelayMs);
      else apply();
      return send(200, `UPID:${act[1]}:0000ABCD:00000000:00000000:qm${act[4]}:${act[3]}:${action!.id}:`);
    }
    return send(501, { message: 'Method not implemented' });
  });
  const port = await listen(server, opts.port);
  return { port, guests, requests, close: closer(server) };
}

/* ------------------------------------------------------------------ Virtualizor */

export interface MockVirtualizor {
  port: number;
  vps: Map<string, { serid: string; hostname: string; status: 0 | 1; suspended: 0 | 1; virt: string; ips: string[] }>;
  requests: { act: string | null; params: Record<string, string> }[];
  close: () => Promise<void>;
}

export async function startVirtualizor(apiKey: string, apiPass: string, listenPort?: number): Promise<MockVirtualizor> {
  const vps: MockVirtualizor['vps'] = new Map([
    ['11', { serid: '0', hostname: 'vps11.example.net', status: 1, suspended: 0, virt: 'kvm', ips: ['203.0.113.11'] }],
    ['12', { serid: '0', hostname: 'vps12.example.net', status: 0, suspended: 0, virt: 'kvm', ips: ['203.0.113.12'] }],
  ]);
  const requests: MockVirtualizor['requests'] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const q = Object.fromEntries(url.searchParams);
    const { apikey, apipass, ...rest } = q;
    requests.push({ act: q.act ?? null, params: rest });
    const send = (b: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (url.pathname !== '/index.php' || q.api !== 'json') return send({ error: { unknown: 'Unknown request' } });
    if (apikey !== apiKey || apipass !== apiPass) return send({ error: { auth: 'API Key / API Pass is invalid' } });
    if (q.act === 'servers') return send({ servs: { '0': { serid: '0', server_name: 'kvm-node-1', status: '1', total_cores: '48', total_ram: '262144' } } });
    if (q.act === 'vs') {
      const vpsid = q.vpsid ?? q.suspend ?? q.unsuspend;
      if (q.suspend || q.unsuspend) {
        const v = vps.get(vpsid!);
        if (!v) return send({ error: { vpsid: 'VPS not found' } });
        v.suspended = q.suspend ? 1 : 0;
        return send({ done: { msg: q.suspend ? 'VPS suspended' : 'VPS unsuspended' } });
      }
      if (q.action) {
        const v = vps.get(vpsid!);
        if (!v) return send({ error: { vpsid: 'VPS not found' } });
        if (q.action === 'start' || q.action === 'restart') v.status = 1;
        else if (q.action === 'stop' || q.action === 'poweroff') v.status = 0;
        else return send({ error: { action: 'Invalid action' } });
        return send({ done: { msg: `VPS ${q.action} done` } });
      }
      const list = [...vps].filter(([id]) => !vpsid || id === vpsid);
      return send({
        vs: Object.fromEntries(
          list.map(([id, v]) => [id, { vpsid: id, vps_name: `v10${id}`, hostname: v.hostname, serid: v.serid, virt: v.virt, status: v.status, suspended: v.suspended, cores: '2', ram: '2048', space: '40', ips: Object.fromEntries(v.ips.map((ip, i) => [String(i + 1), ip])) }]),
        ),
      });
    }
    return send({ error: { act: 'Unknown act' } });
  });
  const port = await listen(server, listenPort);
  return { port, vps, requests, close: closer(server) };
}

/* ------------------------------------------------------------------ file server */

/** Serves fixed bodies at fixed paths (stand-in for an image mirror). */
export async function startFileServer(files: Record<string, Buffer | string>, listenPort?: number) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url!);
    const f = files[req.url!];
    if (f === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': Buffer.byteLength(f) });
    res.end(f);
  });
  const port = await listen(server, listenPort);
  return { port, url: (p: string) => `http://127.0.0.1:${port}${p}`, files, hits, close: closer(server) };
}
