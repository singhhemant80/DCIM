import { describe, expect, it } from 'vitest';
import { cleanReadings, currentPower, estimateFor, integrate, tariffAt, windowEnergy, type PowerReading } from './energy';

const H = 3600_000;
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const at = (sec: number, watts: number): PowerReading => ({ at: T0 + sec * 1000, watts });
/** Readings every `step` s from `from` to `to` (inclusive) at a constant draw. */
const flat = (from: number, to: number, step: number, w: number) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => at(from + i * step, w));

describe('energy integration', () => {
  it('a constant 500 W for one hour is 500 Wh', () => {
    const r = integrate(flat(0, 3600, 60, 500), T0, T0 + H, 300);
    expect(r.wh).toBeCloseTo(500, 9);
    expect(r.coveredSeconds).toBe(3600);
    expect(r.avgW).toBeCloseTo(500, 9);
  });

  it('uses the trapezoid between readings (a ramp from 0 to 1000 W over an hour is 500 Wh)', () => {
    const r = integrate([at(0, 0), at(3600, 1000)], T0, T0 + H, 3600);
    expect(r.wh).toBeCloseTo(500, 9);
    expect(r.maxW).toBe(1000);
  });

  it('does not bridge a gap: the missing span is uncovered, not interpolated', () => {
    // readings 0–1200 s and 2400–3600 s at 600 W, nothing between
    const rs = [...flat(0, 1200, 60, 600), ...flat(2400, 3600, 60, 600)];
    const r = integrate(rs, T0, T0 + H, 300);
    expect(r.coveredSeconds).toBe(2400);
    expect(r.wh).toBeCloseTo(400, 9);
    expect(r.avgW).toBeCloseTo(600, 9);
  });

  it('counts duplicates once and sorts out-of-order readings', () => {
    const rs = [at(60, 100), at(0, 100), at(60, 100), at(120, 100), at(0, 100)];
    const c = cleanReadings(rs);
    expect(c.readings.map((x) => x.at)).toEqual([T0, T0 + 60_000, T0 + 120_000]);
    expect(c.dropped).toBe(2);
    expect(integrate(rs, T0, T0 + 120_000, 300).wh).toBeCloseTo((100 * 120) / 3600, 9);
  });

  it('drops negative, non-finite and impossible readings', () => {
    const rs = [at(0, 200), at(60, -5), at(120, Number.NaN), at(180, 5_000_000), at(240, 200)];
    const r = integrate(rs, T0, T0 + 300_000, 300);
    expect(r.dropped).toBe(3);
    expect(r.coveredSeconds).toBe(240);
    expect(r.maxW).toBe(200);
  });

  it('clips segments at window edges so adjacent windows add up exactly', () => {
    const rs = [at(3000, 100), at(4200, 700)]; // straddles the hour boundary at 3600 s
    const a = integrate(rs, T0, T0 + H, 1800);
    const b = integrate(rs, T0 + H, T0 + 2 * H, 1800);
    const whole = integrate(rs, T0, T0 + 2 * H, 1800);
    expect(a.coveredSeconds).toBe(600);
    expect(b.coveredSeconds).toBe(600);
    expect(a.wh + b.wh).toBeCloseTo(whole.wh, 9);
    // first half: 100 → 400 W over 600 s = 250 W avg
    expect(a.wh).toBeCloseTo((250 * 600) / 3600, 9);
  });

  it('a single reading covers nothing', () => {
    const r = integrate([at(10, 300)], T0, T0 + H, 300);
    expect(r.wh).toBe(0);
    expect(r.coveredSeconds).toBe(0);
    expect(r.avgW).toBeNull();
    expect(r.samples).toBe(1);
  });
});

describe('window energy: sources, estimates, unknowns', () => {
  it('uses one source only, by priority, never the sum', () => {
    const w = windowEnergy({ from: T0, to: T0 + H, maxGapSeconds: 300, estimateW: null, estimateKind: null, sources: { redfish: flat(0, 3600, 60, 300), pdu_outlet: flat(0, 3600, 60, 330) } });
    expect(w.source).toBe('pdu_outlet');
    expect(w.measuredWh).toBeCloseTo(330, 9);
  });

  it('falls back to a lower-priority source when the higher one has no data in the window', () => {
    const w = windowEnergy({ from: T0, to: T0 + H, maxGapSeconds: 300, estimateW: null, estimateKind: null, sources: { pdu_outlet: [], redfish: flat(0, 3600, 60, 300) } });
    expect(w.source).toBe('redfish');
  });

  it('fills time the higher-priority source misses from the next source, without overlap', () => {
    // PDU outlet for the first half hour at 330 W, BMC all hour at 300 W.
    const w = windowEnergy({ from: T0, to: T0 + H, maxGapSeconds: 300, estimateW: 500, estimateKind: 'admin', sources: { pdu_outlet: flat(0, 1800, 60, 330), redfish: flat(0, 3600, 60, 300) } });
    expect(w.bySource).toEqual({ pdu_outlet: 1800, redfish: 1800 });
    expect(w.measuredSeconds).toBe(3600);
    expect(w.measuredWh).toBeCloseTo(165 + 150, 9);
    expect(w.estimatedWh).toBe(0);
    expect(w.source).toBe('pdu_outlet'); // ties go to the higher priority
  });

  it('applies each source its own gap limit', () => {
    // PDU polled every 60 s with a 25-minute outage; BMC every 600 s. The PDU outage must not be bridged.
    const pdu = [...flat(0, 600, 60, 330), ...flat(2100, 3600, 60, 330)];
    const w = windowEnergy({ from: T0, to: T0 + H, maxGapSeconds: { pdu_outlet: 180, redfish: 1800 }, estimateW: null, estimateKind: null, sources: { pdu_outlet: pdu, redfish: flat(0, 3600, 600, 300) } });
    expect(w.bySource).toEqual({ pdu_outlet: 600 + 1500, redfish: 1500 });
    expect(w.measuredWh).toBeCloseTo((2100 * 330 + 1500 * 300) / 3600, 9);
  });

  it('estimates the uncovered remainder separately from the measured part', () => {
    const w = windowEnergy({ from: T0, to: T0 + H, maxGapSeconds: 300, estimateW: 400, estimateKind: 'admin', sources: { ipmi: flat(0, 1800, 60, 200) } });
    expect(w.measuredSeconds).toBe(1800);
    expect(w.measuredWh).toBeCloseTo(100, 9);
    expect(w.estimatedSeconds).toBe(1800);
    expect(w.estimatedWh).toBeCloseTo(200, 9);
    expect(w.estimateKind).toBe('admin');
    expect(w.unknownSeconds).toBe(0);
  });

  it('reports time with neither measurement nor estimate as unknown, with zero energy', () => {
    const w = windowEnergy({ from: T0, to: T0 + H, maxGapSeconds: 300, estimateW: null, estimateKind: null, sources: {} });
    expect(w).toMatchObject({ source: null, measuredWh: 0, estimatedWh: 0, unknownSeconds: 3600 });
  });

  it('a fully measured window has no estimated part even when an estimate exists', () => {
    const w = windowEnergy({ from: T0, to: T0 + H, maxGapSeconds: 300, estimateW: 999, estimateKind: 'model', sources: { redfish: flat(0, 3600, 60, 250) } });
    expect(w.estimatedWh).toBe(0);
    expect(w.estimateKind).toBeNull();
  });

  it('prefers the admin estimate over the model figure', () => {
    expect(estimateFor(150, 300)).toEqual({ estimateW: 150, estimateKind: 'admin' });
    expect(estimateFor(null, 300)).toEqual({ estimateW: 300, estimateKind: 'model' });
    expect(estimateFor(0, 300)).toEqual({ estimateW: 0, estimateKind: 'admin' }); // e.g. a passive patch panel
    expect(estimateFor(null, null)).toEqual({ estimateW: null, estimateKind: null });
  });
});

describe('current power', () => {
  const now = T0 + H;
  it('uses a fresh measurement, else the estimate, else unknown', () => {
    const latest = [
      { source: 'redfish' as const, at: now - 30_000, watts: 310 },
      { source: 'pdu_outlet' as const, at: now - 3600_000, watts: 350 }, // stale
    ];
    expect(currentPower({ latest, now, staleSeconds: 300, estimateW: 400, estimateKind: 'model' })).toMatchObject({ watts: 310, quality: 'measured', source: 'redfish' });
    expect(currentPower({ latest: [latest[1]!], now, staleSeconds: 300, estimateW: 400, estimateKind: 'model' })).toMatchObject({ watts: 400, quality: 'estimated', source: 'model' });
    expect(currentPower({ latest: [], now, staleSeconds: 300, estimateW: null, estimateKind: null })).toMatchObject({ watts: null, quality: 'unknown' });
  });
});

describe('tariffs', () => {
  const t = [
    { id: 'org-old', datacenterId: null, pricePerKwh: 8, currency: 'INR', validFrom: T0 - 100 * H },
    { id: 'org-new', datacenterId: null, pricePerKwh: 9, currency: 'INR', validFrom: T0 },
    { id: 'dc', datacenterId: 'dc1', pricePerKwh: 10, currency: 'INR', validFrom: T0 + 24 * H },
  ];
  it('picks the datacenter’s tariff in force, else the organization’s, by date', () => {
    expect(tariffAt(t, 'dc1', T0 - H)?.id).toBe('org-old');
    expect(tariffAt(t, 'dc1', T0 + H)?.id).toBe('org-new');
    expect(tariffAt(t, 'dc1', T0 + 25 * H)?.id).toBe('dc');
    expect(tariffAt(t, 'dc2', T0 + 25 * H)?.id).toBe('org-new');
    expect(tariffAt(t, null, T0 - 200 * H)).toBeNull();
  });
});
