import type { HwHealth, ServerHealth, ServerRollupKey } from '@crapplet/shared';
import type { WsmanItem } from './dell-wsman';

/**
 * A server's current health from its BMC, read every few minutes (the full
 * hardware walk is daily). Parsers only; the requests are in redfish.ts.
 *
 * - Health per component: the Redfish system resource's standard summaries
 *   (Status, ProcessorSummary, MemorySummary), Dell's rollups
 *   (Oem.Dell.DellSystem *RollupStatus) and HPE's (Oem.Hpe.AggregateHealthStatus);
 *   on iDRACs whose Redfish fails, the same rollups from WS-Man DCIM_SystemView.
 * - Temperatures: the chassis Thermal resource (inlet, exhaust, CPUs, hottest).
 * - Usage: Dell's CUPS sensors (CPU / memory / IO / system usage in %) from
 *   WS-Man DCIM_NumericSensor, where the iDRAC has them (13th generation and
 *   later with an Enterprise or Datacenter license). Never estimated.
 */
type Row = Record<string, unknown>;
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});

/** "OK" / "Ok" / "Warning" / "Critical" (any case); anything else is not a health. */
export function healthOf(v: unknown): HwHealth {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'ok' ? 'OK' : s === 'warning' ? 'Warning' : s === 'critical' ? 'Critical' : null;
}
const statusHealth = (status: unknown): HwHealth => healthOf(obj(status).HealthRollup) ?? healthOf(obj(status).Health);
const worse = (a: HwHealth, b: HwHealth): HwHealth => (a === 'Critical' || b === 'Critical' ? 'Critical' : a === 'Warning' || b === 'Warning' ? 'Warning' : (a ?? b));

/** Health per component from a Redfish ComputerSystem (standard, Dell and HPE fields). */
export function rollupFromRedfishSystem(sys: Row): Partial<Record<ServerRollupKey, HwHealth>> {
  const out: Partial<Record<ServerRollupKey, HwHealth>> = {};
  const set = (k: ServerRollupKey, h: HwHealth) => {
    if (h) out[k] = worse(out[k] ?? null, h);
  };
  set('system', statusHealth(sys.Status));
  set('cpu', statusHealth(obj(sys.ProcessorSummary).Status));
  set('memory', statusHealth(obj(sys.MemorySummary).Status));
  const dell = obj(obj(obj(sys.Oem).Dell).DellSystem);
  set('cpu', healthOf(dell.CPURollupStatus));
  set('memory', healthOf(dell.SysMemPrimaryStatus));
  set('storage', healthOf(dell.StorageRollupStatus));
  set('psu', healthOf(dell.PSRollupStatus));
  set('fans', healthOf(dell.FanRollupStatus));
  set('temperature', healthOf(dell.TempRollupStatus));
  set('voltage', healthOf(dell.VoltRollupStatus));
  set('battery', healthOf(dell.BatteryRollupStatus));
  const hpe = obj(obj(obj(sys.Oem).Hpe).AggregateHealthStatus);
  const hp = (k: string) => healthOf(obj(obj(hpe[k]).Status).Health);
  set('cpu', hp('Processors'));
  set('memory', hp('Memory'));
  set('storage', hp('Storage'));
  set('psu', hp('PowerSupplies'));
  set('fans', hp('Fans'));
  set('temperature', hp('Temperatures'));
  set('network', hp('Network'));
  return out;
}

/** Temperatures from a Redfish Thermal resource: inlet, exhaust, hottest CPU and hottest overall. */
export function temperaturesFromThermal(thermal: Row) {
  const list = (Array.isArray(thermal.Temperatures) ? (thermal.Temperatures as Row[]) : [])
    .filter((t) => !/absent|disabled/i.test(String(obj(t.Status).State ?? '')))
    .map((t) => ({ name: String(t.Name ?? t.MemberId ?? ''), c: n(t.ReadingCelsius), ctx: String(t.PhysicalContext ?? '') }))
    .filter((t) => t.c !== null && t.c > -50 && t.c < 150) as { name: string; c: number; ctx: string }[];
  const max = (xs: { c: number }[]) => (xs.length ? Math.max(...xs.map((x) => x.c)) : null);
  return {
    inletC: max(list.filter((t) => /inlet|ambient|intake/i.test(t.name) || /intake/i.test(t.ctx))),
    exhaustC: max(list.filter((t) => /exhaust|outlet/i.test(t.name) || /exhaust/i.test(t.ctx))),
    cpuTempC: max(list.filter((t) => /\bcpu|proc/i.test(t.name) || /^cpu$/i.test(t.ctx))),
    maxTempC: max(list),
  };
}

/** A WS-Man sensor reading in base units (CurrentReading × 10^UnitModifier). */
const reading = (f: WsmanItem) => (f.CurrentReading !== null && f.CurrentReading !== undefined && /^-?\d+(\.\d+)?$/.test(f.CurrentReading) ? Number(f.CurrentReading) * 10 ** Number(f.UnitModifier ?? 0) : null);

/** Dell CUPS usage (%) and temperatures from DCIM_NumericSensor. */
export function fromDellSensors(items: WsmanItem[]) {
  const pct = (re: RegExp) => {
    const s = items.find((f) => re.test(f.ElementName ?? '') && reading(f) !== null);
    const v = s ? reading(s)! : null;
    return v !== null && v >= 0 && v <= 100 ? v : null;
  };
  // BaseUnits 2 = degrees Celsius.
  const temps = items.filter((f) => f.BaseUnits === '2' && reading(f) !== null).map((f) => ({ name: f.ElementName ?? '', c: reading(f)! }));
  const max = (xs: { c: number }[]) => (xs.length ? Math.max(...xs.map((x) => x.c)) : null);
  return {
    cpuUsagePct: pct(/\bCPU Usage/i),
    memoryUsagePct: pct(/\bMEM(ORY)? Usage/i),
    ioUsagePct: pct(/\bIO Usage/i),
    systemUsagePct: pct(/\bSYS(TEM)? Usage/i),
    inletC: max(temps.filter((t) => /inlet/i.test(t.name))),
    exhaustC: max(temps.filter((t) => /exhaust/i.test(t.name))),
    cpuTempC: max(temps.filter((t) => /\bcpu/i.test(t.name))),
    maxTempC: max(temps),
  };
}

const WSMAN_STATUS: Record<string, HwHealth> = { '1': 'OK', '2': 'Warning', '3': 'Critical' };
/** Health per component from WS-Man DCIM_SystemView (0 unknown, 1 OK, 2 degraded, 3 error). */
export function rollupFromDellSystemView(v: WsmanItem): Partial<Record<ServerRollupKey, HwHealth>> {
  const out: Partial<Record<ServerRollupKey, HwHealth>> = {};
  const set = (k: ServerRollupKey, field: string) => {
    const h = WSMAN_STATUS[v[field] ?? ''] ?? null;
    if (h) out[k] = h;
  };
  set('system', 'PrimaryStatus');
  set('cpu', 'CPURollupStatus');
  set('memory', 'SysMemPrimaryStatus');
  set('storage', 'StorageRollupStatus');
  set('psu', 'PSRollupStatus');
  set('fans', 'FanRollupStatus');
  set('temperature', 'TempRollupStatus');
  set('voltage', 'VoltRollupStatus');
  set('battery', 'BatteryRollupStatus');
  return out;
}

export function emptyServerHealth(source: string): ServerHealth {
  return { source, powerState: null, rollup: {}, cpuUsagePct: null, memoryUsagePct: null, ioUsagePct: null, systemUsagePct: null, inletC: null, exhaustC: null, cpuTempC: null, maxTempC: null, warnings: [] };
}
