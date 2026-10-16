import type { Adapter, AdapterTarget, DiscoveryResult, PowerSnapshot, TestResult } from '../../network/discovery/types';
import { DeviceHttpError, basicAuth, deviceRequest, str } from './http';
import { collectRedfishInventory } from './redfish-inventory';
import { dellInventoryViaWsman, dellMemoryViaWsman, dellPowerViaWsman, dellSystemFromView, wsmanEnumerate } from './dell-wsman';

/**
 * DMTF Redfish (Dell iDRAC 8/9, HPE iLO 5/6, Lenovo XClarity, Supermicro…).
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

/** Where common BMCs put their (single) system: Dell iDRAC, HPE iLO / Supermicro / Lenovo XClarity, AMI-based BMCs. */
export const KNOWN_SYSTEM_PATHS = ['/redfish/v1/Systems/System.Embedded.1', '/redfish/v1/Systems/1', '/redfish/v1/Systems/Self', '/redfish/v1/Systems/system'];

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
          message: `Connected over WS-Man: ${[sys.manufacturer, sys.model].filter(Boolean).join(' ')}${sys.serial ? ` (service tag ${sys.serial})` : ''}, power ${sys.powerState ?? 'unknown'}. This iDRAC's Redfish service fails (${e.message.slice(0, 160)}), so hardware and power are read over WS-Man; an iDRAC firmware update fixes Redfish`,
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
    async power(t): Promise<PowerSnapshot> {
      try {
        return await redfishPower(t);
      } catch (e) {
        if (isAuth(e)) throw e;
        // Older Dell iDRAC firmware: the power sensor over WS-Man.
        const w = await dellPowerViaWsman(t).catch(() => null);
        if (w) return { watts: w.watts, source: 'redfish', detail: w.detail };
        throw e;
      }
    },
  };
  async function redfishPower(t: AdapterTarget): Promise<PowerSnapshot> {
    {
      const chassis = members(await get(t, '/redfish/v1/Chassis')).slice(0, 8);
      if (!chassis.length) throw new Error('The BMC lists no chassis');
      const tried: string[] = [];
      for (const c of chassis) {
        const doc = await get(t, c);
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
      throw new Error(`No power reading found in ${chassis.length} chassis${tried.length ? ` (${tried.slice(0, 3).join('; ')})` : ''}`);
    }
  }
}
