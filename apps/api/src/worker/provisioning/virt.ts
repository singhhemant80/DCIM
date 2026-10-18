import type { GuestAction, VirtTemplate } from '@crapplet/shared';
import type { AdapterTarget } from '../../network/discovery/types';
import { DeviceHttpError, deviceRequest } from '../adapters/http';
import { createHash, randomInt } from 'node:crypto';
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
  /** Installed OS as the hypervisor reports it, where it does (Virtualizor). */
  osId?: string | null;
  osName?: string | null;
  /** Bandwidth this billing month and its limit, in GB, as the hypervisor counts it (Virtualizor; 0 limit = unlimited). */
  bwUsedGb?: number | null;
  bwLimitGb?: number | null;
}
type GuestRef = { externalId: string; hostExternalId: string | null; virtType: string | null };
/** A node's current load: CPU in percent of all its cores, memory in bytes. */
export interface HostLoad {
  cpuPct: number | null;
  memUsed: number | null;
  memTotal: number | null;
}
export interface VirtClient {
  test(): Promise<string>;
  /** `warning`: the sync worked but part of the data could not be read (shown on the integration). */
  /** `templates`: OS templates the hypervisor can install, where it offers reinstalls (undefined: not read). */
  inventory(): Promise<{ hosts: VirtHostInfo[]; guests: VirtGuestInfo[]; warning?: string; templates?: VirtTemplate[] }>;
  guestStatus(g: { externalId: string; hostExternalId: string | null; virtType: string | null }): Promise<string>;
  /** Seconds since the guest started, where the hypervisor reports it (used to verify reboots). */
  guestUptime?(g: { externalId: string; hostExternalId: string | null; virtType: string | null }): Promise<number | null>;
  guestAction(g: { externalId: string; hostExternalId: string | null; virtType: string | null }, action: GuestAction): Promise<void>;
  /** Reinstall from an OS template, erasing the disk (Virtualizor "Rebuild VPS"). */
  reinstall?(g: GuestRef, input: { osid: number; password: string; formatPrimaryOnly: boolean }): Promise<void>;
  /** Current CPU and memory use of the given nodes, read live (a node that can't be read is left out). */
  hostLoads?(hostIds: string[]): Promise<Map<string, HostLoad>>;
  /** The guest's installed OS and state, read together (verifies a reinstall). */
  guestOs?(g: GuestRef): Promise<{ osId: string | null; osName: string | null; status: string }>;
}

type Row = Record<string, unknown>;
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

function target(url: string, verifyTls: boolean, timeoutMs = 20_000): AdapterTarget {
  const u = new URL(url);
  return { host: u.hostname, port: u.port ? Number(u.port) : null, params: { scheme: u.protocol === 'http:' ? 'http' : 'https', verifyTls, timeoutMs }, secret: {} };
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
    async hostLoads() {
      const nodes = ((await get('/nodes')) as Row[] | undefined) ?? [];
      return new Map(nodes.map((x) => [String(x.node), { cpuPct: n(x.cpu) === null ? null : Math.round(n(x.cpu)! * 1000) / 10, memUsed: n(x.mem), memTotal: n(x.maxmem) }]));
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
 * Virtualizor admin API, authenticated as Virtualizor's own admin SDK does
 * (sdk/admin.php): adminapikey and adminapipass, plus a signed apikey made of
 * a random 8-character string followed by md5(apipass + that string). Without
 * the signed key the panel redirects to its login page. The key is in the
 * query string by Virtualizor's design; error messages here never include the
 * query string. Response shapes follow Virtualizor's API docs.
 */
export function virtualizorApiKey(apiPass: string, rand?: string) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const r = rand ?? Array.from({ length: 8 }, () => abc[randomInt(abc.length)]).join('');
  return (
    r +
    createHash('md5')
      .update(apiPass + r)
      .digest('hex')
  );
}

/**
 * Virtualizor's "stop" asks the guest to shut down; "poweroff" cuts it off.
 * Its suspend/unsuspend is an administrative suspension (billing), not a pause,
 * so DCIM does not offer it. Mapping per the Virtualizor admin API docs; not
 * checked against a live panel.
 */
const VZ_ACTIONS: Partial<Record<GuestAction, string>> = { start: 'start', shutdown: 'stop', stop: 'poweroff', reboot: 'restart' };

export function virtualizorClient(cfg: { url: string; verifyTls: boolean; apiKey: string; apiPass: string; actionsEnabled: boolean }): VirtClient {
  // A master listing many slaves and VPSes can take a while to answer.
  const t = target(cfg.url, cfg.verifyTls, 60_000);
  const call = async (params: Record<string, string>, post?: Record<string, string>) => {
    const q = new URLSearchParams({ ...params, adminapikey: cfg.apiKey, adminapipass: cfg.apiPass, api: 'json', apikey: virtualizorApiKey(cfg.apiPass) });
    try {
      const res = post
        ? await deviceRequest(t, 'POST', `/index.php?${q.toString()}`, { defaultPort: 4085, rawErrors: true, raw: { data: new URLSearchParams(post).toString(), contentType: 'application/x-www-form-urlencoded' } })
        : await deviceRequest(t, 'GET', `/index.php?${q.toString()}`, { defaultPort: 4085, rawErrors: true });
      // Virtualizor answers a request it doesn't accept with a redirect to its login page.
      if (res.status >= 300 && res.status < 400) {
        let where: URL | null = null;
        try {
          where = res.location ? new URL(res.location, cfg.url) : null;
        } catch {
          where = null;
        }
        const base = new URL(cfg.url);
        if (where && (where.hostname !== base.hostname || (where.port || '4085') !== (base.port || '4085') || where.protocol !== base.protocol) && !/act=login/.test(where.search))
          throw new PermanentError(`Virtualizor redirects to ${where.protocol}//${where.host}${where.pathname}; use that address as the panel URL`);
        throw new PermanentError(
          `Virtualizor did not accept the API credentials (HTTP ${res.status}, redirect to its login page). Use the Admin API key and password of the master (Virtualizor admin → Configuration → Server Info, or Configuration → API Credentials), and if the key is limited to some IPs, add this NexoraDC server's public IP`,
        );
      }
      if (res.status === 401 || res.status === 403)
        throw new PermanentError(
          `Virtualizor did not accept the API credentials (HTTP ${res.status}). Use the Admin API key and password of the master (Virtualizor admin → Configuration → Server Info, or Configuration → API Credentials), and if the key is limited to some IPs, add this NexoraDC server's public IP`,
        );
      if (res.status >= 400) throw new Error(`HTTP ${res.status} from Virtualizor`);
      const r = res.json as Row | null;
      if (!r || typeof r !== 'object')
        throw new Error('Virtualizor sent no JSON. Check that the URL is the admin panel of the master (https://<master>:4085) and that the API credentials are Admin API credentials');
      const err = r.error as unknown;
      const msgs = Array.isArray(err) ? err.map((x) => String((x as Row)?.msg ?? x)) : err && typeof err === 'object' ? Object.values(err as Row).map(String) : [];
      if (msgs.length) {
        const msg = msgs.join('; ');
        throw /api|key|pass|auth|login|permission/i.test(msg) ? new PermanentError(`Virtualizor refused the request: ${msg}`) : new Error(`Virtualizor: ${msg}`);
      }
      return r;
    } catch (e) {
      return fail(e);
    }
  };
  /**
   * The VPS list has no power state; it comes from act=vs&vs_status=<ids>
   * (documented: 0 off, 1 on, 2 suspended). Administrative suspension,
   * network suspension and a lock come from the VPS list itself and win over
   * the power state, as in Virtualizor's own panel.
   */
  const powerStates = async (ids: string[]) => {
    const out = new Map<string, number>();
    // Virtualizor's VPS Status also carries this month's used bandwidth and the plan's limit (GB).
    const bw = new Map<string, { used: number | null; limit: number | null }>();
    const errors: string[] = [];
    // Virtualizor asks each node live, so keep batches small; one failing batch doesn't lose the others.
    for (let i = 0; i < ids.length; i += 25) {
      const part = ids.slice(i, i + 25);
      try {
        const r = await call({ act: 'vs', vs_status: part.join(',') });
        const m = (r.status && typeof r.status === 'object' ? r.status : r) as Record<string, unknown>;
        for (const id of part) {
          const e = m[id];
          const st = n(e && typeof e === 'object' ? (e as Row).status : e);
          if (st !== null) out.set(id, st);
          if (e && typeof e === 'object') bw.set(id, { used: n((e as Row).used_bandwidth), limit: n((e as Row).bandwidth) });
        }
      } catch (e) {
        errors.push((e as { cause?: Error })?.cause?.message || (e as Error).message);
      }
    }
    const missing = ids.filter((id) => !out.has(id)).length;
    const warning = missing ? `VM status unknown for ${missing} of ${ids.length} VPSes${errors.length ? `: ${errors[0]}` : ' (Virtualizor gave no status for them)'}` : undefined;
    return { out, warning, bw };
  };
  const isSet = (x: unknown) => x !== undefined && x !== null && x !== '' && x !== '0' && x !== 0 && x !== false;
  const status = (v: Row, power: number | undefined): string => {
    if (n(v.suspended) === 1 || power === 2) return 'suspended';
    if (n(v.nw_suspended) === 1) return 'network_suspended';
    if (isSet(v.locked)) return 'locked';
    return power === 1 ? 'running' : power === 0 ? 'stopped' : 'unknown';
  };
  /**
   * A node's load from Virtualizor's Manage Server call (act=manageserver,
   * changeserid=<node>): usage.ram {used, limit} in MB and usage.cpu.percent.
   * Nodes are read a few at a time; one that doesn't answer is left out.
   */
  const hostLoads = async (ids: string[]) => {
    const out = new Map<string, HostLoad>();
    const queue = ids.filter((id) => /^\d+$/.test(id));
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        try {
          const r = await call({ act: 'manageserver', changeserid: id });
          const usage = (r.usage ?? {}) as Row;
          const ram = (usage.ram ?? {}) as Row;
          const cpu = usage.cpu as unknown;
          const cpuPct = n(cpu && typeof cpu === 'object' ? (cpu as Row).percent : cpu);
          const used = n(ram.used);
          const limit = n(ram.limit);
          out.set(id, { cpuPct: cpuPct === null ? null : Math.round(cpuPct * 10) / 10, memUsed: used === null ? null : used * 1024 * 1024, memTotal: limit === null ? null : limit * 1024 * 1024 });
        } catch {
          /* this node stays without a live reading */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    return out;
  };
  return {
    async test() {
      const r = await call({ act: 'servers' });
      return `Virtualizor, ${Object.keys((r.servs as Row | undefined) ?? {}).length} server(s)`;
    },
    async inventory() {
      const servers = ((await call({ act: 'servers' })).servs as Record<string, Row> | undefined) ?? {};
      // VPS lists are paged: read page after page until a short one.
      const vs: Record<string, Row> = {};
      const per = 500;
      for (let page = 1; page <= 200; page++) {
        const chunk = ((await call({ act: 'vs', page: String(page), reslen: String(per) })).vs as Record<string, Row> | undefined) ?? {};
        const before = Object.keys(vs).length;
        Object.assign(vs, chunk);
        if (Object.keys(chunk).length < per || Object.keys(vs).length === before) break;
      }
      // Power states; if the panel can't give them, statuses stay "unknown" rather than guessed.
      const { out: power, warning, bw } = await powerStates(Object.keys(vs));
      // Installed OS templates (Virtualizor's OS Templates call; "ostemplates" are the downloaded ones).
      let templates: VirtTemplate[] | undefined;
      try {
        const r = await call({ act: 'ostemplates', page: '1', reslen: '1000' });
        const list = (r.ostemplates && typeof r.ostemplates === 'object' ? r.ostemplates : {}) as Record<string, Row>;
        templates = Object.entries(list)
          .map(([key, x]) => ({ osid: n(x.osid) ?? n(key) ?? 0, name: s(x.name) ?? s(x.filename) ?? `Template ${key}`, distro: s(x.distro), type: s(x.type) ?? s(x.Nvirt) }))
          .filter((x) => x.osid > 0)
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        templates = undefined;
      }
      const loads = await hostLoads(Object.values(servers).map((x) => String(x.serid)));
      return {
        hosts: Object.values(servers).map((x) => ({
          externalId: String(x.serid),
          name: s(x.server_name) ?? `server-${String(x.serid)}`,
          status: n(x.status) === 1 ? 'online' : n(x.status) === 0 ? 'offline' : s(x.status),
          cpuPct: loads.get(String(x.serid))?.cpuPct ?? null,
          cpus: n(x.total_cores),
          memUsed: loads.get(String(x.serid))?.memUsed ?? null,
          memTotal: loads.get(String(x.serid))?.memTotal ?? (n(x.total_ram) === null ? null : n(x.total_ram)! * 1024 * 1024),
          uptimeSeconds: null,
        })),
        guests: Object.values(vs).map((x) => ({
          externalId: String(x.vpsid),
          hostExternalId: s(x.serid),
          virtType: s(x.virt),
          name: s(x.hostname) ?? s(x.vps_name) ?? `vps-${String(x.vpsid)}`,
          status: status(x, power.get(String(x.vpsid))),
          cpus: n(x.cores),
          memBytes: n(x.ram) === null ? null : n(x.ram)! * 1024 * 1024,
          diskBytes: n(x.space) === null ? null : n(x.space)! * 1024 ** 3,
          uptimeSeconds: null,
          ipAddresses: x.ips && typeof x.ips === 'object' ? Object.values(x.ips as Row).map(String) : [],
          osId: s(x.osid),
          osName: s(x.os_name),
          bwUsedGb: bw.get(String(x.vpsid))?.used ?? null,
          bwLimitGb: bw.get(String(x.vpsid))?.limit ?? n(x.bandwidth),
        })),
        warning,
        templates,
      };
    },
    hostLoads,
    async guestStatus(g) {
      if (!/^\d+$/.test(g.externalId)) throw new PermanentError('Unknown VPS id');
      const vs = ((await call({ act: 'vs', vpsid: g.externalId })).vs as Record<string, Row> | undefined) ?? {};
      // Never fall back to another VPS's status if the filter was ignored.
      const v = vs[g.externalId];
      if (!v) return 'missing';
      return status(v, (await powerStates([g.externalId])).out.get(g.externalId));
    },
    async guestAction(g, action) {
      if (!cfg.actionsEnabled) throw new PermanentError('VM actions are off for this Virtualizor integration');
      if (!/^\d+$/.test(g.externalId)) throw new PermanentError('Unknown VPS id');
      const a = VZ_ACTIONS[action];
      if (!a) throw new PermanentError(`DCIM does not offer ${action} for Virtualizor`);
      await call({ act: 'vs', action: a, vpsid: g.externalId });
    },
    /**
     * Virtualizor "Rebuild VPS": act=rebuild (changeserid = the VPS's node, as
     * Virtualizor's SDK sends it) with vpsid, reos=1, osid, newpass and conf
     * posted. The password goes in the POST body, never in the URL.
     */
    async reinstall(g, input) {
      if (!cfg.actionsEnabled) throw new PermanentError('VM actions are off for this Virtualizor integration');
      if (!/^\d+$/.test(g.externalId)) throw new PermanentError('Unknown VPS id');
      const r = await call(
        { act: 'rebuild', ...(g.hostExternalId && /^\d+$/.test(g.hostExternalId) ? { changeserid: g.hostExternalId } : {}) },
        { vpsid: g.externalId, reos: '1', osid: String(input.osid), newpass: input.password, conf: input.password, ...(input.formatPrimaryOnly ? { format_primary: '1' } : {}), eu_send_rebuild_email: '0' },
      );
      if (!(n(r.done) === 1 || r.done === true)) throw new PermanentError('Virtualizor did not confirm the reinstall (no "done" in its answer); check the VPS in the panel');
    },
    async guestOs(g) {
      if (!/^\d+$/.test(g.externalId)) throw new PermanentError('Unknown VPS id');
      const vs = ((await call({ act: 'vs', vpsid: g.externalId })).vs as Record<string, Row> | undefined) ?? {};
      const v = vs[g.externalId];
      if (!v) return { osId: null, osName: null, status: 'missing' };
      return { osId: s(v.osid), osName: s(v.os_name), status: status(v, (await powerStates([g.externalId])).out.get(g.externalId)) };
    },
  };
}
