/**
 * Power and energy calculations. Pure functions, no I/O; each rule has a unit test.
 *
 *  - Measured energy is the trapezoidal integral of timestamped readings.
 *    Two readings further apart than `maxGapSeconds` are not joined: that
 *    span is uncovered (missing stays missing, never interpolated).
 *  - Readings are sorted; duplicates at the same instant count once;
 *    negative, non-finite and impossible values (above `maxW`) are dropped.
 *  - A window takes only the part of each segment inside it (linear
 *    interpolation at the edges), so adjacent windows add up exactly.
 *  - At any moment one source counts for a device, chosen by priority
 *    (PDU outlet, then the device's own BMC or controller); sources are never
 *    added together, so nothing is double counted. Time the highest-priority
 *    source doesn't cover is filled from the next source that does.
 *  - The part of a window no measurement covers is estimated from the
 *    device's power profile (admin estimate, else the model's typical draw),
 *    kept separately as estimated; with no estimate it is reported as unknown.
 */

export interface PowerReading {
  /** ms since epoch */
  at: number;
  watts: number;
}

/** Measured sources, highest priority first. */
export const POWER_SOURCES = ['pdu_outlet', 'redfish', 'ipmi', 'nxos', 'routeros', 'snmp'] as const;
export type PowerSource = (typeof POWER_SOURCES)[number];

/** A device drawing more than this is a bad reading, not a measurement. */
export const MAX_DEVICE_WATTS = 100_000;

export function cleanReadings(readings: PowerReading[], maxW = MAX_DEVICE_WATTS): { readings: PowerReading[]; dropped: number } {
  const ok = readings.filter((r) => Number.isFinite(r.at) && Number.isFinite(r.watts) && r.watts >= 0 && r.watts <= maxW);
  ok.sort((a, b) => a.at - b.at);
  const out: PowerReading[] = [];
  for (const r of ok) if (!out.length || out[out.length - 1]!.at !== r.at) out.push(r);
  return { readings: out, dropped: readings.length - out.length };
}

export interface Integration {
  wh: number;
  coveredSeconds: number;
  /** Time-weighted average over the covered part; null when nothing is covered. */
  avgW: number | null;
  maxW: number | null;
  /** Readings inside the window. */
  samples: number;
  dropped: number;
}

/** Energy over [from, to) from readings (pass readings up to maxGap before and after the window). */
export function integrate(raw: PowerReading[], from: number, to: number, maxGapSeconds: number, maxW = MAX_DEVICE_WATTS): Integration {
  const { readings, dropped } = cleanReadings(raw, maxW);
  let ws = 0; // watt-seconds
  let covered = 0;
  let maxSeen: number | null = null;
  for (let i = 0; i + 1 < readings.length; i++) {
    const a = readings[i]!;
    const b = readings[i + 1]!;
    const span = (b.at - a.at) / 1000;
    if (span <= 0 || span > maxGapSeconds) continue;
    const s = Math.max(a.at, from);
    const e = Math.min(b.at, to);
    if (e <= s) continue;
    const w = (t: number) => a.watts + ((b.watts - a.watts) * (t - a.at)) / (b.at - a.at);
    const ws0 = w(s);
    const ws1 = w(e);
    const secs = (e - s) / 1000;
    ws += ((ws0 + ws1) / 2) * secs;
    covered += secs;
    maxSeen = Math.max(maxSeen ?? 0, ws0, ws1);
  }
  const inside = readings.filter((r) => r.at >= from && r.at < to);
  for (const r of inside) maxSeen = Math.max(maxSeen ?? 0, r.watts);
  return { wh: ws / 3600, coveredSeconds: covered, avgW: covered > 0 ? ws / covered : null, maxW: covered > 0 || inside.length ? maxSeen : null, samples: inside.length, dropped };
}

export type EstimateKind = 'admin' | 'model';

export interface WindowEnergy {
  from: number;
  to: number;
  /** The measured source used for this window, if any. */
  source: PowerSource | null;
  measuredWh: number;
  measuredSeconds: number;
  estimatedWh: number;
  estimatedSeconds: number;
  estimateKind: EstimateKind | null;
  /** Seconds with neither a measurement nor an estimate. */
  unknownSeconds: number;
  avgMeasuredW: number | null;
  maxMeasuredW: number | null;
  samples: number;
}

/** Joined reading pairs of one source, clipped to a window: the spans it measures. */
interface Segment {
  s: number;
  e: number;
  /** Watts at s and at e (linear between the two readings). */
  ws: number;
  we: number;
}

function segments(raw: PowerReading[], from: number, to: number, maxGapSeconds: number): Segment[] {
  const { readings } = cleanReadings(raw);
  const out: Segment[] = [];
  for (let i = 0; i + 1 < readings.length; i++) {
    const a = readings[i]!;
    const b = readings[i + 1]!;
    const span = (b.at - a.at) / 1000;
    if (span <= 0 || span > maxGapSeconds) continue;
    const s = Math.max(a.at, from);
    const e = Math.min(b.at, to);
    if (e <= s) continue;
    const w = (t: number) => a.watts + ((b.watts - a.watts) * (t - a.at)) / (b.at - a.at);
    out.push({ s, e, ws: w(s), we: w(e) });
  }
  return out;
}

/** Removes the already-covered intervals from a segment (intervals sorted, non-overlapping). */
function subtract(seg: Segment, covered: [number, number][]): Segment[] {
  let parts: Segment[] = [seg];
  const at = (x: Segment, t: number) => x.ws + ((x.we - x.ws) * (t - x.s)) / (x.e - x.s);
  for (const [cs, ce] of covered) {
    const next: Segment[] = [];
    for (const p of parts) {
      if (ce <= p.s || cs >= p.e) {
        next.push(p);
        continue;
      }
      if (cs > p.s) next.push({ s: p.s, e: cs, ws: p.ws, we: at(p, cs) });
      if (ce < p.e) next.push({ s: ce, e: p.e, ws: at(p, ce), we: p.we });
    }
    parts = next;
  }
  return parts;
}

function addInterval(covered: [number, number][], s: number, e: number): [number, number][] {
  const all = [...covered, [s, e] as [number, number]].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const iv of all) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

/**
 * Energy for one device over one window. Sources are taken in priority order;
 * each one only counts for time no higher-priority source already covers, so
 * no instant is ever counted twice. `source` is the source that covered the
 * most time. The uncovered remainder is estimated or unknown.
 */
export function windowEnergy(input: {
  from: number;
  to: number;
  sources: Partial<Record<PowerSource, PowerReading[]>>;
  /** Longest join between two readings; per source (3 × that source's polling period) or one value for all. */
  maxGapSeconds: number | Partial<Record<PowerSource, number>>;
  estimateW: number | null;
  estimateKind: EstimateKind | null;
}): WindowEnergy & { bySource: Partial<Record<PowerSource, number>> } {
  const total = (input.to - input.from) / 1000;
  let covered: [number, number][] = [];
  let ws = 0;
  let secs = 0;
  let maxW: number | null = null;
  let samples = 0;
  const bySource: Partial<Record<PowerSource, number>> = {};
  for (const src of POWER_SOURCES) {
    const rs = input.sources[src];
    if (!rs?.length) continue;
    let used = 0;
    const gap = typeof input.maxGapSeconds === 'number' ? input.maxGapSeconds : (input.maxGapSeconds[src] ?? 180);
    for (const seg of segments(rs, input.from, input.to, gap)) {
      for (const p of subtract(seg, covered)) {
        const d = (p.e - p.s) / 1000;
        if (d <= 0) continue;
        ws += ((p.ws + p.we) / 2) * d;
        used += d;
        maxW = Math.max(maxW ?? 0, p.ws, p.we);
        covered = addInterval(covered, p.s, p.e);
      }
    }
    if (used > 0) {
      bySource[src] = used;
      secs += used;
      samples += cleanReadings(rs).readings.filter((r) => r.at >= input.from && r.at < input.to).length;
    }
  }
  const measuredSeconds = Math.min(total, secs);
  const rest = Math.max(0, total - measuredSeconds);
  const hasEstimate = input.estimateW !== null && input.estimateW >= 0;
  const main = (Object.entries(bySource) as [PowerSource, number][]).sort((a, b) => b[1] - a[1] || POWER_SOURCES.indexOf(a[0]) - POWER_SOURCES.indexOf(b[0]))[0]?.[0] ?? null;
  return {
    from: input.from,
    to: input.to,
    source: main,
    bySource,
    measuredWh: ws / 3600,
    measuredSeconds,
    estimatedWh: hasEstimate ? (input.estimateW! * rest) / 3600 : 0,
    estimatedSeconds: hasEstimate ? rest : 0,
    estimateKind: hasEstimate && rest > 0 ? input.estimateKind : null,
    unknownSeconds: hasEstimate ? 0 : rest,
    avgMeasuredW: secs > 0 ? ws / secs : null,
    maxMeasuredW: maxW,
    samples,
  };
}

export type Quality = 'measured' | 'estimated' | 'unknown';

/** Current draw: the newest fresh reading of the highest-priority source, else the estimate, else unknown. */
export function currentPower(input: { latest: { source: PowerSource; at: number; watts: number }[]; now: number; staleSeconds: number; estimateW: number | null; estimateKind: EstimateKind | null }): {
  watts: number | null;
  quality: Quality;
  source: PowerSource | EstimateKind | null;
  at: number | null;
} {
  for (const s of POWER_SOURCES) {
    const r = input.latest.find((x) => x.source === s && input.now - x.at <= input.staleSeconds * 1000 && x.at <= input.now + 60_000 && Number.isFinite(x.watts) && x.watts >= 0 && x.watts <= MAX_DEVICE_WATTS);
    if (r) return { watts: r.watts, quality: 'measured', source: s, at: r.at };
  }
  if (input.estimateW !== null && input.estimateW >= 0) return { watts: input.estimateW, quality: 'estimated', source: input.estimateKind, at: null };
  return { watts: null, quality: 'unknown', source: null, at: null };
}

/** The estimate for a device: the admin's figure wins over the model's typical draw. */
export function estimateFor(profileW: number | null | undefined, modelTypicalW: number | null | undefined): { estimateW: number | null; estimateKind: EstimateKind | null } {
  if (profileW !== null && profileW !== undefined) return { estimateW: profileW, estimateKind: 'admin' };
  if (modelTypicalW !== null && modelTypicalW !== undefined) return { estimateW: modelTypicalW, estimateKind: 'model' };
  return { estimateW: null, estimateKind: null };
}

export interface Tariff {
  id: string;
  datacenterId: string | null;
  /** Price per kWh in the tariff's currency. */
  pricePerKwh: number;
  currency: string;
  /** ms since epoch */
  validFrom: number;
}

/** The tariff in force at `at` for a datacenter: its own newest one, else the organization-wide newest one. */
export function tariffAt(tariffs: Tariff[], datacenterId: string | null, at: number): Tariff | null {
  const pick = (dc: string | null) =>
    tariffs
      .filter((t) => t.datacenterId === dc && t.validFrom <= at)
      .sort((a, b) => b.validFrom - a.validFrom)[0] ?? null;
  return (datacenterId ? pick(datacenterId) : null) ?? pick(null);
}
