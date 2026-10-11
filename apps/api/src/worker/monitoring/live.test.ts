import { describe, expect, it } from 'vitest';
import type { CounterSample } from '../../monitoring/rate-engine';
import { liveRate } from './live';

const s = (at: number, inO: bigint, outO: bigint, extra: Partial<CounterSample> = {}): CounterSample => ({
  at, uptimeSeconds: 1000 + at / 1000, inOctets: inO, outOctets: outO, inPkts: null, outPkts: null, inErrors: null, outErrors: null,
  inDiscards: null, outDiscards: null, bits: 64, errorBits: 64, speedBps: 10e9, operUp: true, ...extra,
});

describe('live (per-second) rates', () => {
  it('computes bits per second from two reads about a second apart, allowing jitter', () => {
    expect(liveRate(s(0, 0n, 0n), s(1000, 12_500_000n, 6_250_000n))).toEqual({ inBps: 100e6, outBps: 50e6 });
    expect(liveRate(s(0, 0n, 0n), s(800, 10_000_000n, 0n))!.inBps).toBeCloseTo(100e6);
  });
  it('gives no rate for the first read, a gap, a reset, a restart or an impossible value', () => {
    expect(liveRate(undefined, s(1000, 1n, 1n))).toBeNull();
    expect(liveRate(s(0, 0n, 0n), s(6000, 1n, 1n))).toBeNull();
    expect(liveRate(s(0, 100n, 100n), s(1000, 5n, 500n))).toBeNull();
    expect(liveRate(s(0, 0n, 0n, { uptimeSeconds: 5000 }), s(1000, 1n, 1n, { uptimeSeconds: 3 }))).toBeNull();
    expect(liveRate(s(0, 0n, 0n), s(1000, 10n ** 13n, 0n))).toBeNull();
  });
});
