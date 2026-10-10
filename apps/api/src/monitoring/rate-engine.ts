/**
 * Turns two consecutive counter readings into rates. Pure functions, no I/O.
 *
 * Rules (each one has a unit test):
 *  - rate = Δoctets × 8 / Δt, Δt from the poller's own clock.
 *  - First sample, duplicate or backwards timestamps: no rate.
 *  - A gap longer than 3 × the polling interval: no rate for that span
 *    (missing data stays missing; it is never averaged into a fake value).
 *  - Device restart (sysUpTime went down, or is shorter than Δt): the
 *    counters were reset, so no rate; the new reading becomes the baseline.
 *  - A 32-bit counter that went down without a restart wrapped once: add 2³².
 *    A 64-bit counter that went down is treated as a reset (a 64-bit wrap is
 *    not physically reachable).
 *  - A rate above 110 % of the link speed (or above 4 Tbit/s when the speed is
 *    unknown) is impossible, so the sample is dropped instead of drawing a spike.
 *  - Utilization only when the speed is known and the same in both readings.
 */

export interface CounterSample {
  /** Poll time, ms since epoch. */
  at: number;
  /** Device uptime in seconds at this poll, when the platform reports it. */
  uptimeSeconds: number | null;
  inOctets: bigint | null;
  outOctets: bigint | null;
  inPkts?: bigint | null;
  outPkts?: bigint | null;
  inErrors?: bigint | null;
  outErrors?: bigint | null;
  inDiscards?: bigint | null;
  outDiscards?: bigint | null;
  /** Width of the octet and packet counters (64 for IF-MIB HC counters and most APIs). */
  bits: 32 | 64;
  /** Width of the error and discard counters (32 in IF-MIB). */
  errorBits?: 32 | 64;
  speedBps: number | null;
  operUp: boolean | null;
}

export type SkipReason = 'first' | 'duplicate' | 'gap' | 'reset' | 'implausible' | 'no_counters';

export interface Rate {
  kind: 'rate';
  at: number;
  seconds: number;
  inBps: number;
  outBps: number;
  inPps: number | null;
  outPps: number | null;
  errorsPs: number | null;
  discardsPs: number | null;
  utilIn: number | null;
  utilOut: number | null;
  speedBps: number | null;
  /** Notes on how the rate was obtained: 'wrap', 'speed_changed', 'speed_unknown'. */
  flags: string[];
}
export type RateResult = Rate | { kind: 'skip'; reason: SkipReason; at: number };

const TWO32 = 2n ** 32n;
const MAX_UNKNOWN_SPEED_BPS = 4e12;

/** Counter delta honoring width; null when the counter reset or is missing. */
export function counterDelta(prev: bigint | null | undefined, cur: bigint | null | undefined, bits: 32 | 64): { delta: bigint; wrapped: boolean } | null {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  const d = cur - prev;
  if (d >= 0n) return { delta: d, wrapped: false };
  if (bits === 32 && prev < TWO32 && cur < TWO32) return { delta: d + TWO32, wrapped: true };
  return null;
}

export function computeRate(prev: CounterSample | null | undefined, cur: CounterSample, intervalSeconds: number): RateResult {
  const skip = (reason: SkipReason): RateResult => ({ kind: 'skip', reason, at: cur.at });
  if (!prev) return skip('first');
  if (cur.inOctets === null || cur.outOctets === null || prev.inOctets === null || prev.outOctets === null) return skip('no_counters');
  const seconds = (cur.at - prev.at) / 1000;
  if (seconds < 1) return skip('duplicate');
  if (seconds > intervalSeconds * 3) return skip('gap');
  if (cur.uptimeSeconds !== null && prev.uptimeSeconds !== null) {
    // Uptime went backwards, or the device restarted within this interval.
    if (cur.uptimeSeconds < prev.uptimeSeconds || cur.uptimeSeconds + 2 < seconds) return skip('reset');
  }
  const flags = new Set<string>();
  const din = counterDelta(prev.inOctets, cur.inOctets, cur.bits);
  const dout = counterDelta(prev.outOctets, cur.outOctets, cur.bits);
  if (!din || !dout) return skip('reset');
  if (din.wrapped || dout.wrapped) flags.add('wrap');
  const inBps = (Number(din.delta) * 8) / seconds;
  const outBps = (Number(dout.delta) * 8) / seconds;
  const speedKnown = !!cur.speedBps && cur.speedBps > 0;
  const ceiling = speedKnown ? Math.max(cur.speedBps!, prev.speedBps ?? 0) * 1.1 : MAX_UNKNOWN_SPEED_BPS;
  if (inBps > ceiling || outBps > ceiling) return skip('implausible');

  const per = (a: bigint | null | undefined, b: bigint | null | undefined, bits: 32 | 64) => {
    const d = counterDelta(a, b, bits);
    if (!d) return null;
    if (d.wrapped) flags.add('wrap');
    return Number(d.delta) / seconds;
  };
  const sumOrNull = (x: number | null, y: number | null) => (x === null && y === null ? null : (x ?? 0) + (y ?? 0));
  const eb = cur.errorBits ?? 32;
  const inPps = per(prev.inPkts, cur.inPkts, cur.bits);
  const outPps = per(prev.outPkts, cur.outPkts, cur.bits);
  const errorsPs = sumOrNull(per(prev.inErrors, cur.inErrors, eb), per(prev.outErrors, cur.outErrors, eb));
  const discardsPs = sumOrNull(per(prev.inDiscards, cur.inDiscards, eb), per(prev.outDiscards, cur.outDiscards, eb));

  let utilIn: number | null = null;
  let utilOut: number | null = null;
  if (!speedKnown) flags.add('speed_unknown');
  else if (prev.speedBps !== cur.speedBps) flags.add('speed_changed');
  else {
    utilIn = Math.min(100, (inBps / cur.speedBps!) * 100);
    utilOut = Math.min(100, (outBps / cur.speedBps!) * 100);
  }
  return { kind: 'rate', at: cur.at, seconds, inBps, outBps, inPps, outPps, errorsPs, discardsPs, utilIn, utilOut, speedBps: speedKnown ? cur.speedBps : null, flags: [...flags] };
}

/**
 * Which interfaces contribute to a total without counting traffic twice:
 * of the interfaces flagged "count in totals", a LAG member is skipped when
 * its LAG is itself counted (the LAG already carries the members' traffic).
 */
export function countedInterfaces<T extends { id: string; lagId: string | null; countInTotals: boolean }>(ifaces: T[]): T[] {
  const counted = new Set(ifaces.filter((i) => i.countInTotals).map((i) => i.id));
  return ifaces.filter((i) => i.countInTotals && !(i.lagId && counted.has(i.lagId)));
}

/** 95th percentile (nearest-rank, as used for transit billing) of a list of samples. */
export function percentile95(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil(0.95 * v.length);
  return v[Math.max(0, rank - 1)]!;
}
