import { describe, expect, it } from 'vitest';
import { computeRate, counterDelta, countedInterfaces, percentile95, type CounterSample, type Rate } from './rate-engine';

const base = (over: Partial<CounterSample> = {}): CounterSample => ({
  at: 1_000_000,
  uptimeSeconds: 10_000,
  inOctets: 1_000_000n,
  outOctets: 2_000_000n,
  inPkts: 1000n,
  outPkts: 2000n,
  inErrors: 0n,
  outErrors: 0n,
  inDiscards: 0n,
  outDiscards: 0n,
  bits: 64,
  speedBps: 1e9,
  operUp: true,
  ...over,
});
/** A second sample `secs` later with the given octet increases. */
const next = (p: CounterSample, secs: number, dIn: bigint, dOut: bigint, over: Partial<CounterSample> = {}): CounterSample => ({
  ...p,
  at: p.at + secs * 1000,
  uptimeSeconds: p.uptimeSeconds === null ? null : p.uptimeSeconds + secs,
  inOctets: p.inOctets! + dIn,
  outOctets: p.outOctets! + dOut,
  ...over,
});
const rate = (r: ReturnType<typeof computeRate>) => {
  if (r.kind !== 'rate') throw new Error(`expected a rate, got ${r.reason}`);
  return r as Rate;
};

describe('rate engine', () => {
  it('computes bit rates and utilization from octet deltas', () => {
    const a = base();
    const r = rate(computeRate(a, next(a, 60, 750_000_000n, 75_000_000n, { inPkts: 1600n, outPkts: 2600n }), 60));
    expect(r.inBps).toBe(100_000_000);
    expect(r.outBps).toBe(10_000_000);
    expect(r.utilIn).toBe(10);
    expect(r.utilOut).toBe(1);
    expect(r.inPps).toBe(10);
    expect(r.outPps).toBe(10);
    expect(r.flags).toEqual([]);
  });

  it('needs a previous sample, and ignores duplicates and backwards clocks', () => {
    const a = base();
    expect(computeRate(null, a, 60)).toMatchObject({ kind: 'skip', reason: 'first' });
    expect(computeRate(a, { ...a }, 60)).toMatchObject({ kind: 'skip', reason: 'duplicate' });
    expect(computeRate(a, { ...a, at: a.at - 5000 }, 60)).toMatchObject({ kind: 'skip', reason: 'duplicate' });
  });

  it('gives no rate across a gap longer than three intervals (missing stays missing)', () => {
    const a = base();
    expect(computeRate(a, next(a, 180, 1000n, 1000n), 60).kind).toBe('rate');
    expect(computeRate(a, next(a, 181, 1000n, 1000n), 60)).toMatchObject({ kind: 'skip', reason: 'gap' });
  });

  it('treats a device restart as a reset, not a negative or huge rate', () => {
    const a = base();
    // Uptime went down and counters restarted from near zero.
    expect(computeRate(a, { ...next(a, 60, 0n, 0n), uptimeSeconds: 30, inOctets: 5000n, outOctets: 7000n }, 60)).toMatchObject({ kind: 'skip', reason: 'reset' });
    // Restarted within the interval: uptime shorter than the elapsed time, counters already above the old values.
    expect(computeRate(a, { ...next(a, 60, 10_000n, 10_000n), uptimeSeconds: 20 }, 60)).toMatchObject({ kind: 'skip', reason: 'reset' });
  });

  it('a 64-bit counter going down without uptime evidence is a reset', () => {
    const a = base({ uptimeSeconds: null });
    expect(computeRate(a, { ...a, at: a.at + 60_000, inOctets: 10n }, 60)).toMatchObject({ kind: 'skip', reason: 'reset' });
  });

  it('handles a 32-bit counter wrap', () => {
    const max = 2n ** 32n;
    const a = base({ bits: 32, inOctets: max - 1000n, outOctets: 500n, speedBps: 100e6 });
    const b = { ...next(a, 60, 0n, 1000n), inOctets: 4000n };
    const r = rate(computeRate(a, b, 60));
    expect(r.inBps).toBe((5000 * 8) / 60);
    expect(r.flags).toContain('wrap');
    expect(counterDelta(10n, 5n, 64)).toBeNull();
    expect(counterDelta(max - 1n, 0n, 32)).toEqual({ delta: 1n, wrapped: true });
  });

  it('drops impossible rates instead of drawing a spike', () => {
    const a = base({ speedBps: 1e9 });
    // 1.2 Gbit/s on a 1 Gbit/s port.
    expect(computeRate(a, next(a, 10, 1_500_000_000n, 0n), 60)).toMatchObject({ kind: 'skip', reason: 'implausible' });
    // Unknown speed: anything above 4 Tbit/s.
    const u = base({ speedBps: null });
    expect(computeRate(u, next(u, 1, 600_000_000_000n, 0n), 60)).toMatchObject({ kind: 'skip', reason: 'implausible' });
  });

  it('computes no utilization when the speed is unknown or changed between samples', () => {
    const u = base({ speedBps: null });
    const r1 = rate(computeRate(u, next(u, 60, 1000n, 1000n), 60));
    expect(r1.utilIn).toBeNull();
    expect(r1.flags).toContain('speed_unknown');
    const a = base({ speedBps: 1e9 });
    const r2 = rate(computeRate(a, next(a, 60, 1000n, 1000n, { speedBps: 10e9 }), 60));
    expect(r2.utilIn).toBeNull();
    expect(r2.flags).toContain('speed_changed');
    expect(r2.inBps).toBeGreaterThan(0);
  });

  it('reports errors and discards per second, and null when not collected', () => {
    const a = base();
    const r = rate(computeRate(a, next(a, 10, 0n, 0n, { inErrors: 30n, outErrors: 20n, inDiscards: 5n, outDiscards: 5n }), 60));
    expect(r.errorsPs).toBe(5);
    expect(r.discardsPs).toBe(1);
    const n = base({ inErrors: null, outErrors: null, inDiscards: null, outDiscards: null, inPkts: null, outPkts: null });
    const r2 = rate(computeRate(n, next(n, 10, 10n, 10n), 60));
    expect(r2.errorsPs).toBeNull();
    expect(r2.inPps).toBeNull();
  });

  it('needs octet counters', () => {
    const a = base({ inOctets: null });
    expect(computeRate(a, { ...a, at: a.at + 60_000 }, 60)).toMatchObject({ kind: 'skip', reason: 'no_counters' });
  });
});

describe('totals and percentiles', () => {
  it('counts a LAG once, not the LAG plus its members', () => {
    const ifs = [
      { id: 'po1', lagId: null, countInTotals: true },
      { id: 'e1', lagId: 'po1', countInTotals: true },
      { id: 'e2', lagId: 'po1', countInTotals: true },
      { id: 'e3', lagId: null, countInTotals: true },
      { id: 'e4', lagId: 'po2', countInTotals: true }, // its LAG isn't counted, so it is
      { id: 'e5', lagId: null, countInTotals: false },
    ];
    expect(countedInterfaces(ifs).map((i) => i.id)).toEqual(['po1', 'e3', 'e4']);
  });

  it('computes the 95th percentile by nearest rank', () => {
    expect(percentile95([])).toBeNull();
    expect(percentile95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(percentile95([5])).toBe(5);
    expect(percentile95([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])).toBe(100);
  });
});
