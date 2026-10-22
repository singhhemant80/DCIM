import type { ServerHealth } from '@crapplet/shared';
import type { Adapter, AdapterTarget, DiscoveryResult, PowerSnapshot, TestResult } from '../../network/discovery/types';
import { emptyServerHealth, fromDellSensors, rollupFromDellSystemView, rollupFromRedfishSystem, temperaturesFromThermal } from './server-health';
import { DeviceHttpError, basicAuth, deviceRequest, str } from './http';
import { collectRedfishInventory } from './redfish-inventory';
import { dellInventoryViaWsman, dellMemoryViaWsman, dellPowerViaWsman, dellSystemFromView, wsmanEnumerate } from './dell-wsman';

/**
 * DMTF Redfish (Dell iDRAC 8/9, HPE iLO 4/5/6, Fujitsu iRMC S4/S5/S6, Lenovo XClarity, Supermicro…).
 * Read-only: only GET requests, and only to paths under /redfish/v1 on the
 * host stored with the credential. Power comes from the chassis
 * `Power.PowerControl[].PowerConsumedWatts` (all current BMCs) or, on newer
 * firmware, `EnvironmentMetrics.PowerWatts.Reading`.
 */
type Row = Record<string, unknown>;

const odataId = (v: unknown): string | null => {
  let id = v && typeof v === 'object' ? (v as Row)['@odata.id'] : null;
  // Some BMCs give absolute links (https://host/redfish/v1/...); only the path is used, on the credential's own host.
  if (typeof id === 'string') id = id.replace(/^https?:\/\/[^/]+(?=\/redfish\/)/i, '').replace(/#.*$/, '');
  // Only follow links inside the Redfish tree of the same host.
  return typeof id === 'string' && /^\/redfish\/v1\/[\w./:-]*$/.test(id) && !id.includes('..') ? id : null;
};

/** Watts from a Power resource (PowerControl) or an EnvironmentMetrics resource. */
export function parseRedfishPower(doc: Row | null): number | null {
  if (!doc) return null;
  const pc = Array.isArray(doc.PowerControl) ? (doc.PowerControl as Row[]) : [];
  for (const c of pc) {
    const w = c.PowerConsumedWatts;
    if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return w;
  }
  const pw = doc.PowerWatts as Row | undefined;
  if (pw && typeof pw.Reading === 'number' && Number.isFinite(pw.Reading) && pw.Reading >= 0) return pw.Reading;
  return null;
}

/** Where common BMCs put their (single) system: Dell iDRAC, HPE iLO / Supermicro / Lenovo XClarity, Fujitsu iRMC, AMI-based BMCs. */
export const KNOWN_SYSTEM_PATHS = ['/redfish/v1/Systems/System.Embedded.1', '/redfish/v1/Systems/1', '/redfish/v1/Systems/0', '/redfish/v1/Systems/Self', '/redfish/v1/Systems/system'];

const isAuth = (e: unknown) => e instanceof DeviceHttpError && (e.status === 401 || e.status === 403);

/**
 * The system resources. Some BMCs (iDRAC with a stuck web service, certain
 * firmware) fail on the /Systems collection with HTTP 500 while the system
 * itself still answers; then the well-known paths are read directly, and the
 * caller gets a note saying so. Read-only GETs only.
 */
/** What a systems collection that gave no usable member looked like, for the error message (no values beyond link paths). */
function describeCollection(coll: Row): string {
  const keys = Object.keys(coll ?? {});
  if (!keys.length) return 'the answer was empty';
  if (!Array.isArray(coll.Members)) return `no Members in the answer; fields: ${keys.slice(0, 8).join(', ')}`;
  if (!coll.Members.length) return `Members is empty${typeof coll['Members@odata.count'] === 'number' ? `, count ${coll['Members@odata.count']}` : ''}; the user may lack the privilege to see the system`;
  const raw = (coll.Members as unknown[]).slice(0, 2).map((m) => String(m && typeof m === 'object' ? (m as Row)['@odata.id'] : m).slice(0, 80));
  return `${coll.Members.length} member link(s) not usable: ${raw.join(', ')}`;
}

export async function findRedfishSystems(get: (path: string) => Promise<Row>): Promise<{ paths: string[]; note: string | null }> {
  let listErr: Error;
  try {
    const coll = await get('/redfish/v1/Systems');
    const list = Array.isArray(coll.Members) ? (coll.Members as unknown[]).map(odataId).filter((x): x is string => !!x) : [];
    if (list.length) return { paths: list, note: null };
    listErr = new Error(`The BMC answered but lists no systems (${describeCollection(coll)})`);
    // The service root may point to the systems somewhere else.
    try {
      const root = await get('/redfish/v1/');
      const link = odataId(root.Systems);
      if (link && link.replace(/\/$/, '') !== '/redfish/v1/Systems') {
        const alt = await get(link);
        const altList = Array.isArray(alt.Members) ? (alt.Members as unknown[]).map(odataId).filter((x): x is string => !!x) : [];
        if (altList.length) return { paths: altList, note: null };
      }
      const product = [str(root.Vendor), str(root.Product), str(root.RedfishVersion) ? `Redfish ${str(root.RedfishVersion)}` : null].filter(Boolean).join(' ');
      if (product) listErr = new Error(`${listErr.message}; service root: ${product}`);
    } catch (e) {
      if (isAuth(e)) throw e;
    }
  } catch (e) {
    if (isAuth(e) || !(e instanceof DeviceHttpError) || e.status === null) throw e;
    listErr = e;
  }
  for (const p of KNOWN_SYSTEM_PATHS) {
    try {
      const doc = await get(p);
      if (doc && typeof doc === 'object' && (doc.Id !== undefined || doc.PowerState !== undefined || doc.Model !== undefined || /ComputerSystem/.test(String(doc['@odata.type'] ?? ''))))
        return { paths: [p], note: `the BMC's system list failed (${listErr.message}), so ${p} was read directly` };
    } catch (e) {
      if (isAuth(e)) throw e;
    }
  }
  const status = listErr instanceof DeviceHttpError ? listErr.status : null;
  const advice =
    status !== null && status >= 500
      ? ' The BMC itself reported an internal error. This usually clears after resetting the BMC (Dell: "racadm racreset" or iDRAC > Maintenance > Diagnostics > Reset iDRAC; it does not affect the running server) or a firmware update. Check also that this user has at least the Read Only / Operator role.'
      : '';
  throw new DeviceHttpError(`${listErr.message}${advice}`, status);
}

/** Per BMC (host:port), the Redfish link its power reading came from last time. */
const powerLinks = new Map<string, string>();
/** Per BMC, where its system and thermal readings are (found once, then read directly). */
const healthLinks = new Map<string, { system: string; thermal: string | null }>();
/** Per Dell BMC: no usage sensors over WS-Man (no license or no WS-Man); asked again after this time. */
const noDellSensorsUntil = new Map<string, number>();

export function redfishAdapter(): Adapter {
  const get = async (t: AdapterTarget, path: string): Promise<Row> => {
    const r = await deviceRequest(t, 'GET', path, { headers: { Authorization: basicAuth(t.username, t.secret.password), 'OData-Version': '4.0' }, defaultPort: (t.params.scheme ?? 'https') === 'https' ? 443 : 80 });
    return (r.json ?? {}) as Row;
  };
  const members = (coll: Row) => (Array.isArray(coll.Members) ? (coll.Members as unknown[]).map(odataId).filter((x): x is string => !!x) : []);
  return {
    async test(t): Promise<TestResult> {
      const started = Date.now();
      let found: Awaited<ReturnType<typeof findRedfishSystems>>;
      try {
        found = await findRedfishSystems((p) => get(t, p));
      } catch (e) {
        if (isAuth(e) || !(e instanceof DeviceHttpError) || e.status === null) throw e;
        // Older Dell iDRAC firmware: Redfish fails for the system, WS-Man still answers.
        const sys = await wsmanEnumerate(t, 'DCIM_SystemView')
          .then(dellSystemFromView)
          .catch((w) => {
            if (isAuth(w)) throw w;
            return null;
          });
        if (!sys) throw e;
        return {
          ok: true,
          message: `Connected over WS-Man: ${[sys.manufacturer, sys.model].filter(Boolean).join(' ')}${sys.serial ? ` (service tag ${sys.serial})` : ''}, power ${sys.powerState ?? 'unknown'}. This iDRAC's Redfish service fails (${e.message.split(' The BMC itself')[0]!.slice(0, 160)}), so hardware and power are read over WS-Man. An iDRAC firmware update fixes Redfish`,
          latencyMs: Date.now() - started,
          facts: { vendor: sys.manufacturer, model: sys.model, serial: sys.serial, sysName: sys.hostName, osVersion: null, sysDescr: sys.biosVersion ? `BIOS ${sys.biosVersion}` : null, uptimeSeconds: null },
        };
      }
      const { paths: systems, note } = found;
      const s = await get(t, systems[0]!);
      const vendor = str(s.Manufacturer);
      const model = str(s.Model);
      const serial = str(s.SerialNumber) ?? str(s.SKU);
      return {
        ok: true,
        message: `Connected: ${[vendor, model].filter(Boolean).join(' ') || 'Redfish system'}${serial ? ` (serial ${serial})` : ''}, power ${str(s.PowerState) ?? 'unknown'}${note ? `. Note: ${note}; resetting the BMC usually fixes its list` : ''}`,
        latencyMs: Date.now() - started,
        facts: { vendor, model, serial, sysName: str(s.HostName), osVersion: null, sysDescr: str(s.BiosVersion) ? `BIOS ${str(s.BiosVersion)}` : null, uptimeSeconds: null },
      };
    },
    async discover(): Promise<DiscoveryResult> {
      throw new Error('Redfish is used for power readings and server facts (use "Test"); network discovery does not apply');
    },
    async hardware(t) {
      let found: Awaited<ReturnType<typeof findRedfishSystems>>;
      try {
        found = await findRedfishSystems((p) => get(t, p));
      } catch (e) {
        if (isAuth(e) || !(e instanceof DeviceHttpError) || e.status === null) throw e;
        let inv;
        try {
          inv = await dellInventoryViaWsman(t, isAuth);
        } catch (w) {
          if (isAuth(w)) throw w;
          throw new Error(`${e.message} (WS-Man also failed: ${(w as Error).message.slice(0, 160)})`);
        }
        inv.warnings.unshift(`Redfish: ${e.message}`.slice(0, 240));
        return inv;
      }
      return collectRedfishInventory(
        (path) => get(t, path),
        isAuth,
        // Older iDRAC firmware has no Redfish memory list; its WS-Man service does (read-only enumeration).
        { applies: (m) => /dell/i.test(m ?? ''), label: 'WS-Man', read: () => dellMemoryViaWsman(t) },
        async () => found,
      );
    },
    /**
     * A server's current health in a few requests: the system resource
     * (component rollups, power state), the chassis Thermal resource, and on
     * Dell the iDRAC's usage sensors over WS-Man. iDRACs whose Redfish fails
     * are read over WS-Man only. Read-only.
     */
    async serverHealth(t): Promise<ServerHealth> {
      const key = `${t.host}:${t.port ?? ''}`;
      const out = emptyServerHealth('Redfish');
      let links = healthLinks.get(key);
      let sys: Row | null = null;
      let redfishErr: Error | null = null;
      try {
        if (links) {
          try {
            sys = await get(t, links.system);
          } catch (e) {
            if (isAuth(e)) throw e;
            healthLinks.delete(key);
            links = undefined;
          }
        }
        if (!sys) {
          const path = (await findRedfishSystems((p) => get(t, p))).paths[0]!;
          sys = await get(t, path);
          const chassisLinks = Array.isArray((sys.Links as Row | undefined)?.Chassis) ? ((sys.Links as Row).Chassis as unknown[]).map(odataId).filter((x): x is string => !!x) : [];
          let thermal: string | null = null;
          for (const c of [...chassisLinks, '/redfish/v1/Chassis/System.Embedded.1', '/redfish/v1/Chassis/1', '/redfish/v1/Chassis/0', '/redfish/v1/Chassis/Self'].slice(0, 5)) {
            try {
              thermal = odataId((await get(t, c)).Thermal);
              if (thermal) break;
            } catch (e) {
              if (isAuth(e)) throw e;
            }
          }
          links = { system: path, thermal };
          if (healthLinks.size > 5000) healthLinks.clear();
          healthLinks.set(key, links);
        }
      } catch (e) {
        if (isAuth(e) || !(e instanceof DeviceHttpError) || e.status === null) throw e;
        redfishErr = e;
      }
      if (sys) {
        out.powerState = str(sys.PowerState);
        out.rollup = rollupFromRedfishSystem(sys);
        if (links?.thermal) {
          try {
            Object.assign(out, temperaturesFromThermal(await get(t, links.thermal)));
          } catch (e) {
            if (isAuth(e)) throw e;
            out.warnings.push(`Thermal: ${(e as Error).message}`.slice(0, 200));
          }
        }
      }
      const dell = /dell/i.test(String(sys?.Manufacturer ?? '')) || /System\.Embedded/.test(links?.system ?? '');
      if (!sys || (dell && (noDellSensorsUntil.get(key) ?? 0) < Date.now())) {
        try {
          if (!sys) {
            const view = (await wsmanEnumerate(t, 'DCIM_SystemView'))[0];
            if (!view) throw new Error('no system view');
            out.rollup = rollupFromDellSystemView(view);
            out.powerState = dellSystemFromView([view])?.powerState ?? null;
          }
          const sens = fromDellSensors(await wsmanEnumerate(t, 'DCIM_NumericSensor'));
          out.cpuUsagePct = sens.cpuUsagePct;
          out.memoryUsagePct = sens.memoryUsagePct;
          out.ioUsagePct = sens.ioUsagePct;
          out.systemUsagePct = sens.systemUsagePct;
          for (const k of ['inletC', 'exhaustC', 'cpuTempC', 'maxTempC'] as const) out[k] ??= sens[k];
          out.source = sys ? 'Redfish + WS-Man' : 'WS-Man';
          // No usage sensors (no license): don't ask WS-Man every few minutes; temperatures come from Redfish.
          if (sys && sens.cpuUsagePct === null && sens.systemUsagePct === null) noDellSensorsUntil.set(key, Date.now() + 6 * 3600_000);
        } catch (w) {
          if (isAuth(w)) throw w;
          if (!sys) throw new Error(`${redfishErr?.message ?? 'Redfish failed'} (WS-Man also failed: ${(w as Error).message.slice(0, 160)})`);
          noDellSensorsUntil.set(key, Date.now() + 6 * 3600_000);
          out.warnings.push(`WS-Man sensors: ${(w as Error).message}`.slice(0, 200));
        }
      }
      return out;
    },
    async power(t): Promise<PowerSnapshot> {
      try {
        return await redfishPower(t);
      } catch (e) {
        if (isAuth(e)) throw e;
        // Older Dell iDRAC firmware: the power sensor over WS-Man.
        let why: string;
        try {
          const w = await dellPowerViaWsman(t);
          if (w) return { watts: w.watts, source: 'redfish', detail: w.detail };
          why = 'no power sensor in its sensor list';
        } catch (w) {
          if (isAuth(w)) throw w;
          why = (w as Error).message;
        }
        throw new Error(`${(e as Error).message}. WS-Man fallback: ${why}`.slice(0, 480));
      }
    },
  };
  async function redfishPower(t: AdapterTarget): Promise<PowerSnapshot> {
    // The link that gave the last reading is read directly: one request per
    // reading instead of three (fewer connections to busy BMCs).
    const key = `${t.host}:${t.port ?? ''}`;
    const known = powerLinks.get(key);
    if (known) {
      try {
        const w = parseRedfishPower(await get(t, known));
        if (w !== null) return { watts: w, source: 'redfish', detail: known };
      } catch (e) {
        if (isAuth(e)) throw e;
      }
      powerLinks.delete(key);
    }
    const snap = await walkPower(t);
    if (snap.detail) {
      if (powerLinks.size > 5000) powerLinks.clear();
      powerLinks.set(key, snap.detail);
    }
    return snap;
  }
  async function walkPower(t: AdapterTarget): Promise<PowerSnapshot> {
    {
      let chassis: string[] = [];
      let listErr: Error | null = null;
      try {
        chassis = members(await get(t, '/redfish/v1/Chassis')).slice(0, 8);
      } catch (e) {
        if (isAuth(e) || !(e instanceof DeviceHttpError) || e.status === null) throw e;
        listErr = e;
      }
      // Older firmware: an empty or failing chassis list while the chassis itself answers.
      if (!chassis.length) chassis = ['/redfish/v1/Chassis/System.Embedded.1', '/redfish/v1/Chassis/1', '/redfish/v1/Chassis/0', '/redfish/v1/Chassis/Self'];
      const listed = !listErr && chassis[0] !== '/redfish/v1/Chassis/System.Embedded.1';
      const tried: string[] = [];
      for (const c of chassis) {
        let doc: Row;
        try {
          doc = await get(t, c);
        } catch (e) {
          if (isAuth(e) || listed) throw e;
          tried.push(`${c}: ${(e as Error).message}`);
          continue;
        }
        for (const link of [odataId(doc.Power), odataId(doc.EnvironmentMetrics)]) {
          if (!link) continue;
          let res: Row | null = null;
          try {
            res = await get(t, link);
          } catch (e) {
            if (e instanceof DeviceHttpError && (e.status === 401 || e.status === 403)) throw e;
            tried.push(`${link}: ${(e as Error).message}`);
            continue;
          }
          const w = parseRedfishPower(res);
          if (w !== null) return { watts: w, source: 'redfish', detail: link };
          tried.push(`${link}: no reading`);
        }
      }
      if (!listed) throw new Error(`The BMC lists no chassis${listErr ? ` (${listErr.message})` : ''} and none answers at the usual paths${tried.length ? ` (${tried.slice(0, 2).join('; ')})` : ''}`.slice(0, 400));
      throw new Error(`No power reading found in ${chassis.length} chassis${tried.length ? ` (${tried.slice(0, 3).join('; ')})` : ''}`);
    }
  }
}
