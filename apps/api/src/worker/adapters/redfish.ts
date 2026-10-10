import type { Adapter, AdapterTarget, DiscoveryResult, PowerSnapshot, TestResult } from '../../network/discovery/types';
import { DeviceHttpError, basicAuth, deviceRequest, str } from './http';

/**
 * DMTF Redfish (Dell iDRAC 8/9, HPE iLO 5/6, Lenovo XClarity, Supermicro…).
 * Read-only: only GET requests, and only to paths under /redfish/v1 on the
 * host stored with the credential. Power comes from the chassis
 * `Power.PowerControl[].PowerConsumedWatts` (all current BMCs) or, on newer
 * firmware, `EnvironmentMetrics.PowerWatts.Reading`.
 */
type Row = Record<string, unknown>;

const odataId = (v: unknown): string | null => {
  const id = v && typeof v === 'object' ? (v as Row)['@odata.id'] : null;
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

export function redfishAdapter(): Adapter {
  const get = async (t: AdapterTarget, path: string): Promise<Row> => {
    const r = await deviceRequest(t, 'GET', path, { headers: { Authorization: basicAuth(t.username, t.secret.password), 'OData-Version': '4.0' }, defaultPort: (t.params.scheme ?? 'https') === 'https' ? 443 : 80 });
    return (r.json ?? {}) as Row;
  };
  const members = (coll: Row) => (Array.isArray(coll.Members) ? (coll.Members as unknown[]).map(odataId).filter((x): x is string => !!x) : []);
  return {
    async test(t): Promise<TestResult> {
      const started = Date.now();
      const systems = members(await get(t, '/redfish/v1/Systems'));
      if (!systems.length) return { ok: false, message: 'The BMC answered but lists no systems', latencyMs: Date.now() - started };
      const s = await get(t, systems[0]!);
      const vendor = str(s.Manufacturer);
      const model = str(s.Model);
      const serial = str(s.SerialNumber) ?? str(s.SKU);
      return {
        ok: true,
        message: `Connected: ${[vendor, model].filter(Boolean).join(' ') || 'Redfish system'}${serial ? ` (serial ${serial})` : ''}, power ${str(s.PowerState) ?? 'unknown'}`,
        latencyMs: Date.now() - started,
        facts: { vendor, model, serial, sysName: str(s.HostName), osVersion: null, sysDescr: str(s.BiosVersion) ? `BIOS ${str(s.BiosVersion)}` : null, uptimeSeconds: null },
      };
    },
    async discover(): Promise<DiscoveryResult> {
      throw new Error('Redfish is used for power readings and server facts (use "Test"); network discovery does not apply');
    },
    async power(t): Promise<PowerSnapshot> {
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
    },
  };
}
