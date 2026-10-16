import { randomUUID } from 'node:crypto';
import type { HardwareInventory, HwHealth, HwMemory } from '@crapplet/shared';
import type { AdapterTarget } from '../../network/discovery/types';
import { basicAuth, deviceRequest } from './http';

/**
 * Dell iDRAC inventory over WS-Management, for iDRAC firmware whose Redfish
 * service lacks parts (no Memory collection) or fails outright (older iDRAC 7/8
 * firmware). Read-only: only WS-Man Enumerate/Pull (a SOAP POST that reads,
 * never changes, anything) of the Dell "view" classes listed below. No other
 * class and no other action can be sent from here.
 */
const DCIM = 'http://schemas.dell.com/wbem/wscim/1/cim-schema/2/';
export const WSMAN_CLASSES = [
  'DCIM_SystemView',
  'DCIM_CPUView',
  'DCIM_MemoryView',
  'DCIM_PhysicalDiskView',
  'DCIM_ControllerView',
  'DCIM_VirtualDiskView',
  'DCIM_PowerSupplyView',
  'DCIM_NICView',
  'DCIM_iDRACCardView',
  'DCIM_NumericSensor',
] as const;
export type WsmanClass = (typeof WSMAN_CLASSES)[number];
const ENUM = 'http://schemas.xmlsoap.org/ws/2004/09/enumeration';

const esc = (v: string) => v.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

function envelope(to: string, cls: WsmanClass, action: 'Enumerate' | 'Pull', context?: string) {
  const body =
    action === 'Enumerate'
      ? '<wsen:Enumerate><wsman:OptimizeEnumeration/><wsman:MaxElements>64</wsman:MaxElements></wsen:Enumerate>'
      : `<wsen:Pull><wsen:EnumerationContext>${esc(context ?? '')}</wsen:EnumerationContext><wsen:MaxElements>64</wsen:MaxElements></wsen:Pull>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:wsen="${ENUM}">
<s:Header>
<wsa:To s:mustUnderstand="true">${esc(to)}</wsa:To>
<wsman:ResourceURI s:mustUnderstand="true">${DCIM}${cls}</wsman:ResourceURI>
<wsa:ReplyTo><wsa:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>
<wsa:Action s:mustUnderstand="true">${ENUM}/${action}</wsa:Action>
<wsa:MessageID s:mustUnderstand="true">uuid:${randomUUID()}</wsa:MessageID>
<wsman:MaxEnvelopeSize s:mustUnderstand="true">512000</wsman:MaxEnvelopeSize>
<wsman:OperationTimeout>PT60S</wsman:OperationTimeout>
</s:Header>
<s:Body>${body}</s:Body>
</s:Envelope>`;
}

const unesc = (v: string) =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');

export type WsmanItem = Record<string, string | null>;

/** The items of one class in a WS-Man answer, as field → text maps. */
export function wsmanItems(xml: string, cls: WsmanClass): WsmanItem[] {
  const out: WsmanItem[] = [];
  const itemRe = new RegExp(`<(\\w+:)?${cls}\\b[^>]*>([\\s\\S]*?)<\\/\\1?${cls}>`, 'g');
  for (const m of xml.matchAll(itemRe)) {
    const fields: Record<string, string | null> = {};
    for (const f of m[2]!.matchAll(/<(?:\w+:)?(\w+)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?\1>)/g)) {
      fields[f[1]!] = f[3] === undefined || /nil="true"/.test(f[2]!) ? null : unesc(f[3].trim());
    }
    out.push(fields);
  }
  return out;
}

/** The DCIM_MemoryView items of a WS-Man answer. */
export const memoryViewItems = (xml: string) => wsmanItems(xml, 'DCIM_MemoryView');

// CIM_PhysicalMemory.MemoryType values used by Dell.
const MEMORY_TYPES: Record<string, string> = { '20': 'DDR', '21': 'DDR2', '24': 'DDR3', '26': 'DDR4', '34': 'DDR5' };
const num = (v: string | null | undefined) => (v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
function health(primaryStatus: string | null | undefined): HwHealth {
  switch (primaryStatus) {
    case '1':
      return 'OK';
    case '2':
      return 'Warning';
    case '3':
      return 'Critical';
    default:
      return null;
  }
}

export function memoryFromView(items: Record<string, string | null>[]): HwMemory[] {
  return items
    .filter((f) => (num(f.Size) ?? 1) > 0)
    .map((f) => ({
      slot: f.FQDD ?? f.InstanceID ?? f.DeviceDescription ?? 'DIMM',
      // Size is in MB.
      sizeGb: num(f.Size) !== null ? Math.round(num(f.Size)! / 1024) : null,
      type: (f.MemoryType && (MEMORY_TYPES[f.MemoryType] ?? (/^\d+$/.test(f.MemoryType) ? null : f.MemoryType))) || null,
      speedMhz: num(f.CurrentOperatingSpeed) ?? num(f.Speed),
      manufacturer: f.Manufacturer || null,
      partNumber: f.PartNumber || null,
      serial: f.SerialNumber || null,
      health: health(f.PrimaryStatus),
    }));
}

/** Enumerates one class (Enumerate, then Pull until done; at most 20 pages). */
export async function wsmanEnumerate(t: AdapterTarget, cls: WsmanClass): Promise<WsmanItem[]> {
  if (!WSMAN_CLASSES.includes(cls)) throw new Error('Class not allowed');
  const scheme = t.params.scheme ?? 'https';
  const port = t.port ?? (scheme === 'https' ? 443 : 80);
  const to = `${scheme}://${t.host}:${port}/wsman`;
  const send = async (xml: string) => {
    const r = await deviceRequest(t, 'POST', '/wsman', {
      headers: { Authorization: basicAuth(t.username, t.secret.password) },
      raw: { data: xml, contentType: 'application/soap+xml;charset=UTF-8' },
      defaultPort: scheme === 'https' ? 443 : 80,
      idempotent: true,
    });
    return r.text ?? '';
  };
  let xml = await send(envelope(to, cls, 'Enumerate'));
  const items = wsmanItems(xml, cls);
  for (let pulls = 0; pulls < 20 && !/EndOfSequence/.test(xml); pulls++) {
    const ctx = /<(?:\w+:)?EnumerationContext[^>]*>([^<]+)</.exec(xml)?.[1];
    if (!ctx) break;
    xml = await send(envelope(to, cls, 'Pull', unesc(ctx.trim())));
    items.push(...wsmanItems(xml, cls));
  }
  return items;
}

/** Reads the memory modules of a Dell iDRAC over WS-Man. */
export async function dellMemoryViaWsman(t: AdapterTarget): Promise<HwMemory[]> {
  return memoryFromView(await wsmanEnumerate(t, 'DCIM_MemoryView'));
}

const str = (v: string | null | undefined) => (v && v.trim() ? v.trim().slice(0, 300) : null);
const bytesGb = (v: string | null | undefined) => (num(v) !== null ? Math.round((num(v)! / 1e9) * 10) / 10 : null);
// CIM power states as Dell's DCIM_SystemView reports them.
const POWER_STATES: Record<string, string> = { '2': 'On', '3': 'Off', '4': 'Off', '6': 'Off', '7': 'Off', '8': 'Off', '9': 'Off', '10': 'PoweringOn', '11': 'On', '12': 'Off', '13': 'Off' };
const BUS: Record<string, string> = { '1': 'SCSI', '2': 'PATA', '3': 'FC', '4': 'USB', '5': 'SATA', '6': 'SAS', '7': 'PCIe', '8': 'NVMe' };
const RAID: Record<string, string> = { '1': 'None', '2': 'RAID0', '4': 'RAID1', '64': 'RAID5', '128': 'RAID6', '2048': 'RAID10', '8192': 'RAID50', '16384': 'RAID60' };
const NIC_SPEED: Record<string, number> = { '1': 10, '2': 100, '3': 1000, '4': 2500, '5': 10000, '6': 20000, '7': 40000, '8': 100000, '9': 25000, '10': 50000 };

/** The system facts (model, service tag, power state) from DCIM_SystemView. */
export function dellSystemFromView(items: WsmanItem[]) {
  const v = items[0];
  if (!v) return null;
  return {
    manufacturer: str(v.Manufacturer) ?? 'Dell Inc.',
    model: str(v.Model),
    serial: str(v.ServiceTag) ?? str(v.ChassisServiceTag),
    sku: str(v.ServiceTag),
    biosVersion: str(v.BIOSVersionString),
    powerState: v.PowerState ? (POWER_STATES[v.PowerState] ?? null) : null,
    hostName: str(v.HostName),
    health: health(v.PrimaryStatus),
    memoryGb: num(v.SysMemTotalSize) !== null ? Math.round(num(v.SysMemTotalSize)! / 1024) : null,
    cpuCount: num(v.PopulatedCPUSockets),
  };
}

/** A sensor's reading in base units (CurrentReading × 10^UnitModifier). */
const reading = (f: WsmanItem) => (num(f.CurrentReading) !== null || /^-\d+$/.test(f.CurrentReading ?? '') ? Number(f.CurrentReading) * 10 ** Number(f.UnitModifier ?? 0) : null);

/** System power draw in watts from the iDRAC's sensors (BaseUnits 7 = watts), if it has one. */
export async function dellPowerViaWsman(t: AdapterTarget): Promise<{ watts: number; detail: string } | null> {
  const sensors = await wsmanEnumerate(t, 'DCIM_NumericSensor');
  const watts = sensors.filter((f) => f.BaseUnits === '7' && reading(f) !== null);
  const pick = watts.find((f) => /consumption/i.test(f.ElementName ?? '')) ?? watts[0];
  return pick ? { watts: reading(pick)!, detail: `WS-Man ${pick.ElementName ?? 'power sensor'}` } : null;
}

/**
 * The whole inventory over WS-Man, for iDRACs whose Redfish service fails.
 * Each class is read on its own; one that fails is listed in the warnings.
 */
export async function dellInventoryViaWsman(t: AdapterTarget, isAuthError: (e: unknown) => boolean): Promise<HardwareInventory> {
  const warnings: string[] = [];
  const read = async (cls: WsmanClass) => {
    try {
      return await wsmanEnumerate(t, cls);
    } catch (e) {
      if (isAuthError(e)) throw e;
      warnings.push(`${cls} (WS-Man): ${(e as Error).message}`.slice(0, 240));
      return [];
    }
  };
  // One class at a time: older iDRACs handle few requests at once.
  const sysView = await read('DCIM_SystemView');
  const system = dellSystemFromView(sysView);
  if (!system) throw new Error(`The iDRAC's WS-Man service returned no system view${warnings.length ? ` (${warnings[0]})` : ''}`);
  const cpus = await read('DCIM_CPUView');
  const mem = await read('DCIM_MemoryView');
  const disks = await read('DCIM_PhysicalDiskView');
  const ctrls = await read('DCIM_ControllerView');
  const vds = await read('DCIM_VirtualDiskView');
  const psus = await read('DCIM_PowerSupplyView');
  const nics = await read('DCIM_NICView');
  const idrac = await read('DCIM_iDRACCardView');
  const sensors = await read('DCIM_NumericSensor');
  const processors = cpus.map((f) => ({ socket: str(f.FQDD) ?? 'CPU', model: str(f.Model), cores: num(f.NumberOfProcessorCores), threads: num(f.NumberOfEnabledThreads), maxSpeedMhz: num(f.MaxClockSpeed), health: health(f.PrimaryStatus) }));
  return {
    system: {
      manufacturer: system.manufacturer,
      model: system.model,
      serial: system.serial,
      sku: system.sku,
      biosVersion: system.biosVersion,
      powerState: system.powerState,
      hostName: system.hostName,
      health: system.health,
      cpuCount: system.cpuCount ?? (processors.length || null),
      cpuModel: processors[0]?.model ?? null,
      logicalCpus: processors.reduce((a, p) => a + (p.threads ?? 0), 0) || null,
      memoryGb: system.memoryGb,
    },
    bmc: idrac[0] ? { model: str(idrac[0].Model) ?? str(idrac[0].ProductDescription), firmware: str(idrac[0].FirmwareVersion) } : null,
    processors,
    memory: memoryFromView(mem),
    memorySource: 'WS-Man',
    controllers: ctrls.map((f) => ({ name: str(f.FQDD) ?? 'Controller', model: str(f.ProductName), firmware: str(f.ControllerFirmwareVersion), health: health(f.PrimaryStatus) })),
    drives: disks.map((f) => ({
      name: str(f.DeviceDescription) ?? str(f.FQDD) ?? 'Drive',
      slot: str(f.Slot),
      model: str(f.Model),
      serial: str(f.SerialNumber),
      mediaType: f.MediaType === '1' ? 'SSD' : f.MediaType === '0' ? 'HDD' : null,
      protocol: f.BusProtocol ? (BUS[f.BusProtocol] ?? null) : null,
      capacityGb: bytesGb(f.SizeInBytes),
      lifeLeftPercent: num(f.RemainingRatedWriteEndurance) !== null && num(f.RemainingRatedWriteEndurance)! <= 100 ? num(f.RemainingRatedWriteEndurance) : null,
      failurePredicted: f.PredictiveFailureState === '1' ? true : f.PredictiveFailureState === '0' ? false : null,
      health: health(f.PrimaryStatus),
    })),
    volumes: vds.map((f) => ({ name: str(f.Name) ?? str(f.FQDD) ?? 'Volume', raid: f.RAIDTypes ? (RAID[f.RAIDTypes] ?? null) : null, capacityGb: bytesGb(f.SizeInBytes), health: health(f.PrimaryStatus) })),
    psus: psus.map((f) => ({
      name: str(f.DeviceDescription) ?? str(f.FQDD) ?? 'PSU',
      model: str(f.Model),
      serial: str(f.SerialNumber),
      capacityW: num(f.TotalOutputPower),
      inputW: null,
      outputW: null,
      firmware: str(f.FirmwareVersion),
      health: health(f.PrimaryStatus),
    })),
    // SensorType 5 = tachometer (fans), 2 = temperature.
    fans: sensors.filter((f) => f.SensorType === '5').map((f) => ({ name: str(f.ElementName) ?? 'Fan', reading: reading(f), units: 'RPM', health: health(f.PrimaryStatus) })),
    temperatures: sensors
      .filter((f) => f.SensorType === '2')
      .map((f) => {
        const k = 10 ** Number(f.UnitModifier ?? 0);
        return { name: str(f.ElementName) ?? 'Sensor', celsius: reading(f), upperCritical: num(f.UpperThresholdCritical) !== null ? num(f.UpperThresholdCritical)! * k : null, health: health(f.PrimaryStatus) };
      }),
    nics: nics.map((f) => ({
      name: str(f.FQDD) ?? str(f.ProductName) ?? 'NIC',
      mac: str(f.CurrentMACAddress) ?? str(f.PermanentMACAddress),
      speedMbps: f.LinkSpeed ? (NIC_SPEED[f.LinkSpeed] ?? null) : null,
      linkStatus: f.LinkSpeed && f.LinkSpeed !== '0' ? 'LinkUp' : null,
      health: health(f.PrimaryStatus),
    })),
    // The system event log is not read over WS-Man here.
    logs: [],
    source: 'WS-Man',
    warnings,
  };
}
