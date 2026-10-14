import type { HardwareInventory, HwHealth, HwLogEntry } from '@crapplet/shared';

type Row = Record<string, unknown>;
export type RedfishGet = (path: string) => Promise<Row>;

/** A link inside this host's Redfish tree (no other hosts, no "..", no query). */
export const odataId = (v: unknown): string | null => {
  const id = v && typeof v === 'object' ? (v as Row)['@odata.id'] : null;
  return typeof id === 'string' && /^\/redfish\/v1\/[\w./:%-]*$/.test(id) && !id.includes('..') ? id : null;
};
const members = (coll: Row) => (Array.isArray(coll.Members) ? (coll.Members as unknown[]).map(odataId).filter((x): x is string => !!x) : []);
const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const health = (st: unknown): HwHealth => {
  const h = st && typeof st === 'object' ? ((st as Row).HealthRollup ?? (st as Row).Health) : null;
  return h === 'OK' || h === 'Warning' || h === 'Critical' ? h : null;
};
const absent = (st: unknown) => !!st && typeof st === 'object' && ((st as Row).State === 'Absent' || (st as Row).State === 'Disabled');
const gb = (bytes: unknown) => (n(bytes) !== null ? Math.round((n(bytes)! / 1e9) * 10) / 10 : null);

/** Runs fn over items, at most `limit` at a time. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

const MAX_LOG_ENTRIES = 200;

/**
 * Walks the BMC's Redfish tree with GET requests only and returns what it
 * finds: CPUs, memory modules, storage controllers, drives and volumes, power
 * supplies, fans, temperatures, network ports, BMC firmware and the system
 * event / fault logs. A part that fails (older firmware, missing resource) is
 * skipped and listed in `warnings`; authentication errors stop the walk.
 */
export async function collectRedfishInventory(get: RedfishGet, isAuthError: (e: unknown) => boolean = () => false): Promise<HardwareInventory> {
  const warnings: string[] = [];
  let requests = 0;
  // BMCs (iDRAC especially) drop or refuse requests when many arrive at once:
  // at most three are in flight, and a failed one is tried once more.
  let active = 0;
  const queue: (() => void)[] = [];
  const slot = async () => {
    if (active >= 3) await new Promise<void>((r) => queue.push(r));
    active++;
  };
  const release = () => {
    active--;
    queue.shift()?.();
  };
  const raw = async (path: string): Promise<Row> => {
    await slot();
    try {
      return await get(path);
    } finally {
      release();
    }
  };
  const g = async (path: string, quiet = false): Promise<Row | null> => {
    if (++requests > 500) {
      if (!warnings.includes('Stopped after 500 requests')) warnings.push('Stopped after 500 requests');
      return null;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await raw(path);
      } catch (e) {
        if (isAuthError(e)) throw e;
        const notFound = /404|Not found/i.test((e as Error).message);
        if (attempt === 0 && !notFound && !quiet) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (!quiet && warnings.length < 30) warnings.push(`${path}: ${(e as Error).message}`.slice(0, 200));
        return null;
      }
    }
  };
  /**
   * A collection's members. Tries one expanded request first ($expand, which
   * iDRAC 9 and iLO 5+ support), else reads each member.
   */
  const list = async (path: string | null, cap: number): Promise<Row[]> => {
    if (!path) return [];
    const expanded = await g(`${path}?$expand=*($levels=1)`, true);
    const full = Array.isArray(expanded?.Members) ? (expanded!.Members as Row[]) : [];
    if (full.length && full.every((m) => m && typeof m === 'object' && Object.keys(m).some((k) => !k.startsWith('@odata')))) return full.slice(0, cap);
    const coll = expanded && Array.isArray(expanded.Members) ? expanded : await g(path);
    if (!coll) return [];
    const docs = await Promise.all(members(coll).slice(0, cap).map((m) => g(m)));
    return docs.filter((d): d is Row => !!d);
  };

  const sysPath = members((await get('/redfish/v1/Systems')) ?? {})[0];
  if (!sysPath) throw new Error('The BMC lists no systems');
  const sys = (await get(sysPath)) as Row;
  const ps = (sys.ProcessorSummary ?? {}) as Row;
  const ms = (sys.MemorySummary ?? {}) as Row;

  // Older firmware leaves some links out of the system resource; the standard paths are tried then.
  const memPath = odataId(sys.Memory) ?? `${sysPath}/Memory`;
  const storagePath = odataId(sys.Storage) ?? `${sysPath}/Storage`;
  const [cpus, dimms, storage, nics, chassisPaths, managers] = await Promise.all([
    list(odataId(sys.Processors) ?? `${sysPath}/Processors`, 16),
    list(memPath, 64),
    list(storagePath, 16),
    list(odataId(sys.EthernetInterfaces), 32),
    g('/redfish/v1/Chassis').then((c) => (c ? members(c).slice(0, 4) : [])),
    g('/redfish/v1/Managers').then((c) => (c ? members(c).slice(0, 2) : [])),
  ]);

  // Storage: controllers, drives, volumes.
  const controllers: HardwareInventory['controllers'] = [];
  const drives: HardwareInventory['drives'] = [];
  const volumes: HardwareInventory['volumes'] = [];
  for (const st of storage) {
    for (const c of Array.isArray(st.StorageControllers) ? (st.StorageControllers as Row[]) : []) {
      controllers.push({ name: s(c.Name) ?? s(st.Name) ?? s(st.Id) ?? 'Controller', model: s(c.Model), firmware: s(c.FirmwareVersion), health: health(c.Status) });
    }
    if (!Array.isArray(st.StorageControllers) || !(st.StorageControllers as unknown[]).length) controllers.push({ name: s(st.Name) ?? s(st.Id) ?? 'Storage', model: null, firmware: null, health: health(st.Status) });
    const driveLinks = (Array.isArray(st.Drives) ? (st.Drives as unknown[]) : []).map(odataId).filter((x): x is string => !!x).slice(0, 64);
    const ds = await pool(driveLinks, 4, (p) => g(p));
    for (const d of ds) {
      if (!d || absent(d.Status)) continue;
      const loc = (d.PhysicalLocation as Row | undefined)?.PartLocation as Row | undefined;
      drives.push({
        name: s(d.Name) ?? s(d.Id) ?? 'Drive',
        slot: s(loc?.ServiceLabel) ?? (n(loc?.LocationOrdinalValue) !== null ? String(loc!.LocationOrdinalValue) : null),
        model: s(d.Model),
        serial: s(d.SerialNumber),
        mediaType: s(d.MediaType),
        protocol: s(d.Protocol),
        capacityGb: gb(d.CapacityBytes),
        lifeLeftPercent: n(d.PredictedMediaLifeLeftPercent),
        failurePredicted: typeof d.FailurePredicted === 'boolean' ? d.FailurePredicted : null,
        health: health(d.Status),
      });
    }
    for (const v of await list(odataId(st.Volumes), 32)) {
      volumes.push({ name: s(v.Name) ?? s(v.Id) ?? 'Volume', raid: s(v.RAIDType) ?? s(v.VolumeType), capacityGb: gb(v.CapacityBytes), health: health(v.Status) });
    }
  }

  // Older BMCs list disks only under SimpleStorage.
  if (!drives.length && odataId(sys.SimpleStorage)) {
    for (const ss of await list(odataId(sys.SimpleStorage), 16)) {
      for (const dv of Array.isArray(ss.Devices) ? (ss.Devices as Row[]) : []) {
        if (absent(dv.Status) || (n(dv.CapacityBytes) ?? 0) <= 0) continue;
        drives.push({ name: s(dv.Name) ?? 'Drive', slot: null, model: s(dv.Model), serial: null, mediaType: null, protocol: null, capacityGb: gb(dv.CapacityBytes), lifeLeftPercent: null, failurePredicted: null, health: health(dv.Status) });
      }
      if (!controllers.some((c) => c.name === (s(ss.Name) ?? s(ss.Id)))) controllers.push({ name: s(ss.Name) ?? s(ss.Id) ?? 'Controller', model: null, firmware: null, health: health(ss.Status) });
    }
  }

  // Chassis: power supplies, fans, temperatures.
  const psus: HardwareInventory['psus'] = [];
  const fans: HardwareInventory['fans'] = [];
  const temperatures: HardwareInventory['temperatures'] = [];
  for (const cp of chassisPaths) {
    const ch = await g(cp);
    if (!ch) continue;
    const power = odataId(ch.Power) ? await g(odataId(ch.Power)!) : null;
    for (const p of Array.isArray(power?.PowerSupplies) ? (power!.PowerSupplies as Row[]) : []) {
      if (absent(p.Status)) continue;
      psus.push({
        name: s(p.Name) ?? s(p.MemberId) ?? 'PSU',
        model: s(p.Model),
        serial: s(p.SerialNumber),
        capacityW: n(p.PowerCapacityWatts),
        inputW: n(p.PowerInputWatts),
        outputW: n(p.LastPowerOutputWatts) ?? n(p.PowerOutputWatts),
        firmware: s(p.FirmwareVersion),
        health: health(p.Status),
      });
    }
    const thermal = odataId(ch.Thermal) ? await g(odataId(ch.Thermal)!) : null;
    for (const f of Array.isArray(thermal?.Fans) ? (thermal!.Fans as Row[]) : []) {
      if (absent(f.Status)) continue;
      fans.push({ name: s(f.Name) ?? s(f.FanName) ?? s(f.MemberId) ?? 'Fan', reading: n(f.Reading), units: s(f.ReadingUnits), health: health(f.Status) });
    }
    for (const t of Array.isArray(thermal?.Temperatures) ? (thermal!.Temperatures as Row[]) : []) {
      if (absent(t.Status)) continue;
      temperatures.push({ name: s(t.Name) ?? s(t.MemberId) ?? 'Sensor', celsius: n(t.ReadingCelsius), upperCritical: n(t.UpperThresholdCritical), health: health(t.Status) });
    }
  }

  // BMC and its logs (plus the system's own log services, e.g. HPE IML).
  let bmc: HardwareInventory['bmc'] = null;
  const logServices: string[] = [];
  for (const mp of managers) {
    const m = await g(mp);
    if (!m) continue;
    bmc ??= { model: s(m.Model), firmware: s(m.FirmwareVersion) };
    if (odataId(m.LogServices)) logServices.push(odataId(m.LogServices)!);
  }
  if (odataId(sys.LogServices)) logServices.push(odataId(sys.LogServices)!);
  const logs: HwLogEntry[] = [];
  for (const lsPath of logServices) {
    const ls = await g(lsPath);
    for (const svcPath of ls ? members(ls) : []) {
      const id = svcPath.split('/').pop() ?? '';
      // The lifecycle log is a long change history, not hardware events.
      if (/lclog/i.test(id)) continue;
      const svc = await g(svcPath);
      const entriesPath = odataId(svc?.Entries);
      if (!entriesPath) continue;
      let page: Row | null = await g(entriesPath);
      let pages = 0;
      const got: Row[] = [];
      while (page && pages++ < 10) {
        got.push(...(Array.isArray(page.Members) ? (page.Members as Row[]) : []));
        const next = typeof page['Members@odata.nextLink'] === 'string' ? (page['Members@odata.nextLink'] as string) : null;
        if (!next || !/^\/redfish\/v1\/[\w./:%?=&$-]*$/.test(next) || got.length >= 1000) break;
        page = await g(next);
      }
      for (const e of got) {
        logs.push({
          log: s(svc?.Id) ?? id,
          id: s(e.Id) ?? '',
          created: s(e.Created),
          severity: s(e.Severity) ?? s(e.MessageSeverity),
          message: s(e.Message) ?? s(e.Name) ?? '',
          messageId: s(e.MessageId),
        });
      }
    }
  }
  logs.sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''));

  // Empty slots report State "Absent" or a capacity of 0; a module without a capacity field is kept.
  const dimmsPresent = dimms.filter((d) => !absent(d.Status) && (n(d.CapacityMiB) === null ? n(d.CapacityMB) !== 0 : n(d.CapacityMiB)! > 0));
  if (!dimmsPresent.length && (n(ms.TotalSystemMemoryGiB) ?? 0) > 0) warnings.push(`Memory: the BMC reports ${ms.TotalSystemMemoryGiB} GiB but listed no modules at ${memPath} (${dimms.length} entries read)`);
  if (!drives.length) warnings.push(`Storage: no drives listed at ${storagePath} (${storage.length} storage resource(s) read)`);
  return {
    system: {
      manufacturer: s(sys.Manufacturer),
      model: s(sys.Model),
      serial: s(sys.SerialNumber),
      sku: s(sys.SKU),
      biosVersion: s(sys.BiosVersion),
      powerState: s(sys.PowerState),
      hostName: s(sys.HostName),
      health: health(sys.Status),
      cpuCount: n(ps.Count),
      cpuModel: s(ps.Model),
      logicalCpus: n(ps.LogicalProcessorCount),
      memoryGb: n(ms.TotalSystemMemoryGiB),
    },
    bmc,
    processors: cpus
      .filter((c) => !absent(c.Status) && (c.ProcessorType === undefined || c.ProcessorType === 'CPU'))
      .map((c) => ({ socket: s(c.Socket) ?? s(c.Id) ?? 'CPU', model: s(c.Model), cores: n(c.TotalCores), threads: n(c.TotalThreads), maxSpeedMhz: n(c.MaxSpeedMHz), health: health(c.Status) })),
    memory: dimmsPresent.map((d) => ({
      slot: s(d.DeviceLocator) ?? s(d.Id) ?? 'DIMM',
      sizeGb: n(d.CapacityMiB) !== null ? Math.round(n(d.CapacityMiB)! / 1024) : n(d.CapacityMB) !== null ? Math.round(n(d.CapacityMB)! / 1024) : null,
      type: s(d.MemoryDeviceType),
      speedMhz: n(d.OperatingSpeedMhz) ?? n(d.AllowedSpeedsMHz),
      manufacturer: s(d.Manufacturer),
      partNumber: s(d.PartNumber),
      serial: s(d.SerialNumber),
      health: health(d.Status),
    })),
    controllers,
    drives,
    volumes,
    psus,
    fans,
    temperatures,
    nics: nics.map((e) => ({ name: s(e.Id) ?? s(e.Name) ?? 'NIC', mac: s(e.MACAddress) ?? s(e.PermanentMACAddress), speedMbps: n(e.SpeedMbps), linkStatus: s(e.LinkStatus), health: health(e.Status) })),
    logs: logs.slice(0, MAX_LOG_ENTRIES),
    warnings,
  };
}
