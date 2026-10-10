import type { GuestAction } from '@crapplet/shared';
import type { AdapterTarget } from '../../network/discovery/types';
import { DeviceHttpError, deviceRequest } from '../adapters/http';
import { PermanentError } from './engine';

/**
 * Hypervisor clients. Sync uses read access only; actions use a separately
 * granted credential (Proxmox: a second token) or an explicit opt-in
 * (Virtualizor admin keys can't be scoped).
 */
export interface VirtHostInfo {
  externalId: string;
  name: string;
  status: string | null;
  cpuPct: number | null;
  cpus: number | null;
  memUsed: number | null;
  memTotal: number | null;
  uptimeSeconds: number | null;
}
export interface VirtGuestInfo {
  externalId: string;
  hostExternalId: string | null;
  virtType: string | null;
  name: string;
  /** running, stopped, paused, suspended… */
  status: string | null;
  cpus: number | null;
  memBytes: number | null;
  diskBytes: number | null;
  uptimeSeconds: number | null;
  ipAddresses: string[];
}
export interface VirtClient {
  test(): Promise<string>;
  inventory(): Promise<{ hosts: VirtHostInfo[]; guests: VirtGuestInfo[] }>;
  guestStatus(g: { externalId: string; hostExternalId: string | null; virtType: string | null }): Promise<string>;
  /** Seconds since the guest started, where the hypervisor reports it (used to verify reboots). */
  guestUptime?(g: { externalId: string; hostExternalId: string | null; virtType: string | null }): Promise<number | null>;
  guestAction(g: { externalId: string; hostExternalId: string | null; virtType: string | null }, action: GuestAction): Promise<void>;
}

type Row = Record<string, unknown>;
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

function target(url: string, verifyTls: boolean): AdapterTarget {
  const u = new URL(url);
  return { host: u.hostname, port: u.port ? Number(u.port) : null, params: { scheme: u.protocol === 'http:' ? 'http' : 'https', verifyTls, timeoutMs: 20_000 }, secret: {} };
}
const fail = (e: unknown): never => {
  if (e instanceof DeviceHttpError && (e.status === 401 || e.status === 403)) throw new PermanentError(e.message);
  throw e;
};

/* ------------------------------------------------------------------ Proxmox VE */

const PVE_ACTIONS: Record<GuestAction, string> = { start: 'start', stop: 'stop', shutdown: 'shutdown', reboot: 'reboot', suspend: 'suspend', resume: 'resume' };

export function proxmoxClient(cfg: { url: string; verifyTls: boolean; tokenId: string; tokenSecret: string; actionTokenId?: string | null; actionTokenSecret?: string | null }): VirtClient {
  const t = target(cfg.url, cfg.verifyTls);
  const defaultPort = 8006;
  const hdr = (id: string, secret: string) => ({ Authorization: `PVEAPIToken=${id}=${secret}` });
  const get = async (path: string) => {
    try {
      return ((await deviceRequest(t, 'GET', `/api2/json${path}`, { headers: hdr(cfg.tokenId, cfg.tokenSecret), defaultPort })).json as Row | null)?.data;
    } catch (e) {
      return fail(e);
    }
  };
  const guestPath = (g: { externalId: string; hostExternalId: string | null; virtType: string | null }) => {
    if (!g.hostExternalId || !/^[\w.-]+$/.test(g.hostExternalId) || !/^\d+$/.test(g.externalId)) throw new PermanentError('Unknown node or VM id');
    return `/nodes/${g.hostExternalId}/${g.virtType === 'lxc' ? 'lxc' : 'qemu'}/${g.externalId}`;
  };
  return {
    async test() {
      const v = (await get('/version')) as Row | undefined;
      return `Proxmox VE ${s(v?.version) ?? ''}`.trim();
    },
    async inventory() {
      const nodes = ((await get('/nodes')) as Row[] | undefined) ?? [];
      const vms = ((await get('/cluster/resources?type=vm')) as Row[] | undefined) ?? [];
      return {
        hosts: nodes.map((x) => ({
          externalId: String(x.node),
          name: String(x.node),
          status: s(x.status),
          cpuPct: n(x.cpu) === null ? null : Math.round(n(x.cpu)! * 1000) / 10,
          cpus: n(x.maxcpu),
          memUsed: n(x.mem),
          memTotal: n(x.maxmem),
          uptimeSeconds: n(x.uptime),
        })),
        guests: vms
          .filter((x) => x.template !== 1)
          .map((x) => ({
            externalId: String(x.vmid),
            hostExternalId: s(x.node),
            virtType: s(x.type),
            name: s(x.name) ?? `vm-${String(x.vmid)}`,
            status: s(x.status),
            cpus: n(x.maxcpu),
            memBytes: n(x.maxmem),
            diskBytes: n(x.maxdisk),
            uptimeSeconds: n(x.uptime),
            ipAddresses: [],
          })),
      };
    },
    async guestStatus(g) {
      const d = (await get(`${guestPath(g)}/status/current`)) as Row | undefined;
      // A suspended QEMU guest reports status "running" with qmpstatus "paused" (or "suspended").
      const qmp = s(d?.qmpstatus);
      if (qmp && qmp !== 'running') return qmp === 'paused' ? 'suspended' : qmp;
      return s(d?.status) ?? 'unknown';
    },
    async guestUptime(g) {
      const d = (await get(`${guestPath(g)}/status/current`)) as Row | undefined;
      return n(d?.uptime);
    },
    async guestAction(g, action) {
      if (!cfg.actionTokenId || !cfg.actionTokenSecret) throw new PermanentError('VM actions are off for this Proxmox integration (no action token configured)');
      try {
        await deviceRequest(t, 'POST', `/api2/json${guestPath(g)}/status/${PVE_ACTIONS[action]}`, { headers: hdr(cfg.actionTokenId, cfg.actionTokenSecret), body: {}, defaultPort });
      } catch (e) {
        fail(e);
      }
    },
  };
}

/* ------------------------------------------------------------------ Virtualizor */

/**
 * Virtualizor admin API (index.php?act=…&api=json&apikey=…&apipass=…). The key
 * is in the query string by Virtualizor's design; error messages here never
 * include the query string. Response shapes follow Virtualizor's API docs and
 * have not been checked against a live panel.
 */
/**
 * Virtualizor's "stop" asks the guest to shut down; "poweroff" cuts it off.
 * Its suspend/unsuspend is an administrative suspension (billing), not a pause,
 * so DCIM does not offer it. Mapping per the Virtualizor admin API docs; not
 * checked against a live panel.
 */
const VZ_ACTIONS: Partial<Record<GuestAction, string>> = { start: 'start', shutdown: 'stop', stop: 'poweroff', reboot: 'restart' };

export function virtualizorClient(cfg: { url: string; verifyTls: boolean; apiKey: string; apiPass: string; actionsEnabled: boolean }): VirtClient {
  const t = target(cfg.url, cfg.verifyTls);
  const call = async (params: Record<string, string>) => {
    const q = new URLSearchParams({ ...params, api: 'json', apikey: cfg.apiKey, apipass: cfg.apiPass });
    try {
      const r = (await deviceRequest(t, 'GET', `/index.php?${q.toString()}`, { defaultPort: 4085 })).json as Row | null;
      if (!r || typeof r !== 'object') throw new Error('Empty response from Virtualizor');
      if (r.error && Object.keys(r.error as object).length) {
        const msg = Object.values(r.error as Row).map(String).join('; ');
        throw /api|key|pass|auth/i.test(msg) ? new PermanentError(`Virtualizor refused the request: ${msg}`) : new Error(`Virtualizor: ${msg}`);
      }
      return r;
    } catch (e) {
      return fail(e);
    }
  };
  const status = (v: Row): string => {
    if (n(v.suspended) === 1) return 'suspended';
    const st = n(v.status);
    return st === 1 ? 'running' : st === 0 ? 'stopped' : (s(v.status) ?? 'unknown');
  };
  return {
    async test() {
      const r = await call({ act: 'servers' });
      return `Virtualizor, ${Object.keys((r.servs as Row | undefined) ?? {}).length} server(s)`;
    },
    async inventory() {
      const servers = ((await call({ act: 'servers' })).servs as Record<string, Row> | undefined) ?? {};
      const vs = ((await call({ act: 'vs' })).vs as Record<string, Row> | undefined) ?? {};
      return {
        hosts: Object.values(servers).map((x) => ({
          externalId: String(x.serid),
          name: s(x.server_name) ?? `server-${String(x.serid)}`,
          status: n(x.status) === 1 ? 'online' : n(x.status) === 0 ? 'offline' : s(x.status),
          cpuPct: null,
          cpus: n(x.total_cores),
          memUsed: null,
          memTotal: n(x.total_ram) === null ? null : n(x.total_ram)! * 1024 * 1024,
          uptimeSeconds: null,
        })),
        guests: Object.values(vs).map((x) => ({
          externalId: String(x.vpsid),
          hostExternalId: s(x.serid),
          virtType: s(x.virt),
          name: s(x.hostname) ?? s(x.vps_name) ?? `vps-${String(x.vpsid)}`,
          status: status(x),
          cpus: n(x.cores),
          memBytes: n(x.ram) === null ? null : n(x.ram)! * 1024 * 1024,
          diskBytes: n(x.space) === null ? null : n(x.space)! * 1024 ** 3,
          uptimeSeconds: null,
          ipAddresses: x.ips && typeof x.ips === 'object' ? Object.values(x.ips as Row).map(String) : [],
        })),
      };
    },
    async guestStatus(g) {
      if (!/^\d+$/.test(g.externalId)) throw new PermanentError('Unknown VPS id');
      const vs = ((await call({ act: 'vs', vpsid: g.externalId })).vs as Record<string, Row> | undefined) ?? {};
      // Never fall back to another VPS's status if the filter was ignored.
      const v = vs[g.externalId];
      return v ? status(v) : 'missing';
    },
    async guestAction(g, action) {
      if (!cfg.actionsEnabled) throw new PermanentError('VM actions are off for this Virtualizor integration');
      if (!/^\d+$/.test(g.externalId)) throw new PermanentError('Unknown VPS id');
      const a = VZ_ACTIONS[action];
      if (!a) throw new PermanentError(`DCIM does not offer ${action} for Virtualizor`);
      await call({ act: 'vs', action: a, vpsid: g.externalId });
    },
  };
}
