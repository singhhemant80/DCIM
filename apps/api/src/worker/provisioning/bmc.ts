import { execFile } from 'node:child_process';
import type { PowerAction } from '@crapplet/shared';
import type { AdapterTarget } from '../../network/discovery/types';
import { DeviceHttpError, basicAuth, deviceRequest } from '../adapters/http';
import { PermanentError } from './engine';

/**
 * BMC control (power, one-time boot device, virtual media). Used only by
 * provisioning jobs, with the separate control credential.
 */
export type PowerState = 'on' | 'off' | 'unknown';
export type BootTarget = 'cd' | 'pxe';

export interface BmcControl {
  powerState(): Promise<PowerState>;
  power(action: PowerAction): Promise<void>;
  /** One-time boot override for the next start. */
  setBootOnce(target: BootTarget): Promise<void>;
  clearBootOverride(): Promise<void>;
  /** The pending one-time override, if any. */
  bootOverride(): Promise<BootTarget | null>;
  /** Virtual media (Redfish only). */
  insertMedia?(url: string): Promise<void>;
  ejectMedia?(): Promise<void>;
  /** URL of the inserted image, or null. */
  insertedMedia?(): Promise<string | null>;
  /** Changes on every boot where the BMC reports it (Redfish BootProgress.LastStateTime); null if not reported. */
  bootMarker?(): Promise<string | null>;
}

type Row = Record<string, unknown>;
const link = (v: unknown): string | null => {
  const id = v && typeof v === 'object' ? (v as Row)['@odata.id'] : null;
  return typeof id === 'string' && /^\/redfish\/v1\/[\w./:-]*$/.test(id) && !id.includes('..') ? id : null;
};

const RESET: Record<PowerAction, string> = {
  on: 'On',
  off: 'ForceOff',
  graceful_shutdown: 'GracefulShutdown',
  restart: 'ForceRestart',
  graceful_restart: 'GracefulRestart',
  power_cycle: 'PowerCycle',
};

export function redfishControl(t: AdapterTarget): BmcControl {
  const auth = { Authorization: basicAuth(t.username, t.secret.password), 'OData-Version': '4.0' };
  const port = (t.params.scheme ?? 'https') === 'https' ? 443 : 80;
  const req = async (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => {
    const r = await deviceRequest(t, method, path, { headers: auth, body, defaultPort: port, rawErrors: true });
    if (r.status === 401 || r.status === 403) throw new PermanentError(`The BMC refused the control credential (HTTP ${r.status}); it needs a role that can change power and boot settings`);
    if (r.status >= 400) {
      const msg = ((r.json as Row | null)?.error as Row | undefined)?.message;
      throw new DeviceHttpError(`HTTP ${r.status} from ${path}${typeof msg === 'string' ? `: ${msg.slice(0, 200)}` : ''}`, r.status);
    }
    return (r.json ?? {}) as Row;
  };
  let systemPath: string | null = null;
  const system = async () => {
    if (!systemPath) {
      const members = ((await req('GET', '/redfish/v1/Systems')).Members as unknown[] | undefined)?.map(link).filter((x): x is string => !!x) ?? [];
      if (!members.length) throw new PermanentError('The BMC lists no computer system');
      systemPath = members[0]!;
    }
    return systemPath;
  };
  let mediaPath: string | null | undefined;
  const virtualMedia = async (): Promise<string> => {
    if (mediaPath) return mediaPath;
    const managers = ((await req('GET', '/redfish/v1/Managers')).Members as unknown[] | undefined)?.map(link).filter((x): x is string => !!x) ?? [];
    for (const m of managers.slice(0, 4)) {
      const vmLink = link((await req('GET', m)).VirtualMedia);
      if (!vmLink) continue;
      const items = ((await req('GET', vmLink)).Members as unknown[] | undefined)?.map(link).filter((x): x is string => !!x) ?? [];
      for (const it of items) {
        const doc = await req('GET', it);
        const types = (doc.MediaTypes as string[] | undefined) ?? [];
        if (types.some((x) => /^(CD|DVD)$/i.test(x))) return (mediaPath = it);
      }
    }
    throw new PermanentError('The BMC offers no virtual CD/DVD drive over Redfish (older firmware may need an update or a vendor tool)');
  };
  return {
    async powerState() {
      const s = String((await req('GET', await system())).PowerState ?? '').toLowerCase();
      return s === 'on' ? 'on' : s === 'off' ? 'off' : 'unknown';
    },
    async power(action) {
      const sys = await system();
      const doc = await req('GET', sys);
      const allowed = (((doc.Actions as Row | undefined)?.['#ComputerSystem.Reset'] as Row | undefined)?.['ResetType@Redfish.AllowableValues'] as string[] | undefined) ?? null;
      let type = RESET[action];
      // Not every BMC offers PowerCycle: an off→on equivalent is a ForceRestart when running.
      if (allowed && !allowed.includes(type) && action === 'power_cycle' && allowed.includes('ForceRestart')) type = 'ForceRestart';
      if (allowed && !allowed.includes(type)) throw new PermanentError(`This BMC does not support ${type} (it offers ${allowed.join(', ')})`);
      await req('POST', `${sys}/Actions/ComputerSystem.Reset`, { ResetType: type });
    },
    async setBootOnce(target) {
      await req('PATCH', await system(), { Boot: { BootSourceOverrideTarget: target === 'cd' ? 'Cd' : 'Pxe', BootSourceOverrideEnabled: 'Once' } });
    },
    async clearBootOverride() {
      await req('PATCH', await system(), { Boot: { BootSourceOverrideEnabled: 'Disabled' } });
    },
    async bootOverride() {
      const b = ((await req('GET', await system())).Boot as Row | undefined) ?? {};
      if (String(b.BootSourceOverrideEnabled ?? 'Disabled') === 'Disabled') return null;
      const target = String(b.BootSourceOverrideTarget ?? 'None');
      return target === 'Cd' ? 'cd' : target === 'Pxe' ? 'pxe' : null;
    },
    async insertMedia(url) {
      const vm = await virtualMedia();
      await req('POST', `${vm}/Actions/VirtualMedia.InsertMedia`, { Image: url, Inserted: true, WriteProtected: true });
    },
    async ejectMedia() {
      const vm = await virtualMedia();
      const doc = await req('GET', vm);
      if (doc.Inserted === true || (typeof doc.Image === 'string' && doc.Image)) await req('POST', `${vm}/Actions/VirtualMedia.EjectMedia`, {});
    },
    async insertedMedia() {
      const doc = await req('GET', await virtualMedia());
      return doc.Inserted === true && typeof doc.Image === 'string' ? doc.Image : null;
    },
    async bootMarker() {
      const bp = (await req('GET', await system())).BootProgress as Row | undefined;
      return typeof bp?.LastStateTime === 'string' && bp.LastStateTime ? bp.LastStateTime : null;
    },
  };
}

const SAFE = /^[A-Za-z0-9._:[\]-]+$/;
const IPMI_POWER: Record<Exclude<PowerAction, 'graceful_restart'>, string> & Partial<Record<PowerAction, string>> = { on: 'on', off: 'off', graceful_shutdown: 'soft', restart: 'reset', power_cycle: 'cycle' };

/** IPMI via ipmitool (power and boot device; no virtual media). Password only in the environment. */
export function ipmiControl(t: AdapterTarget, binary = process.env.IPMITOOL_PATH || 'ipmitool'): BmcControl {
  const run = (args: string[]): Promise<string> => {
    const host = t.host.replace(/^\[|\]$/g, '');
    if (!SAFE.test(host) || host.startsWith('-')) return Promise.reject(new PermanentError('Invalid BMC address'));
    if (!t.username || t.username.startsWith('-') || !SAFE.test(t.username.replace(/[ @]/g, '_'))) return Promise.reject(new PermanentError('Invalid IPMI user name'));
    const perTry = Math.max(1, Math.round((t.params.timeoutMs ?? 10_000) / 1000));
    const full = ['-I', 'lanplus', '-H', host, '-p', String(t.port ?? 623), '-U', t.username, '-E', '-L', t.params.ipmiPrivilege ?? 'OPERATOR', '-N', String(perTry), '-R', '2', ...args];
    return new Promise((resolve, reject) => {
      execFile(binary, full, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', IPMI_PASSWORD: String(t.secret.password ?? '') }, timeout: perTry * 3000 + 3000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === 'ENOENT') return reject(new PermanentError('ipmitool is not installed on the worker host'));
          if (e.killed) return reject(new Error('IPMI request timed out'));
          const msg = String(stderr || e.message).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ');
          return reject(/RAKP|password|Unauthorized|privilege|Insufficient/i.test(msg) ? new PermanentError(`The BMC refused the control credential: ${msg}`) : new Error(msg || 'ipmitool failed'));
        }
        resolve(String(stdout));
      });
    });
  };
  return {
    async powerState() {
      const out = await run(['chassis', 'power', 'status']);
      return /is on/i.test(out) ? 'on' : /is off/i.test(out) ? 'off' : 'unknown';
    },
    async power(action) {
      // "soft" is an ACPI shutdown; there is no ACPI restart over IPMI.
      if (action === 'graceful_restart') throw new PermanentError('IPMI has no ACPI restart; use Shut down (ACPI) and then Power on');
      await run(['chassis', 'power', IPMI_POWER[action]]);
    },
    async setBootOnce(target) {
      if (target !== 'pxe') throw new PermanentError('IPMI can only set network (PXE) boot; virtual media needs Redfish');
      await run(['chassis', 'bootdev', 'pxe']);
    },
    async clearBootOverride() {
      await run(['chassis', 'bootdev', 'none']);
    },
    async bootOverride() {
      const out = await run(['chassis', 'bootparam', 'get', '5']);
      if (/Boot Flag Invalid/i.test(out)) return null;
      return /Force PXE/i.test(out) ? 'pxe' : /CD|DVD/i.test(out) ? 'cd' : null;
    },
  };
}
