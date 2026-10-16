import { BlockList } from 'node:net';
import { describe, expect, it } from 'vitest';
import { FlowDecodeError, TemplateCache, decodeFlowPacket } from './netflow';
import { encodeTemplated, encodeV5, type SimFlow } from './encode';
import { FlowAggregator, LiveWindow, spread } from './collector';

const now = Date.UTC(2026, 9, 16, 6, 0, 30);
const up = 5_000_000;
const flows: SimFlow[] = [
  { src: '8.8.8.8', dst: '103.150.120.10', bytes: 1_500_000, packets: 1000, start: now - 20_000, end: now - 5_000 },
  { src: '103.150.120.10', dst: '1.1.1.1', bytes: 40_000, packets: 300, start: now - 20_000, end: now - 5_000 },
];

describe('flow decoding', () => {
  it('NetFlow v5: addresses, bytes, packets and absolute times', () => {
    const r = decodeFlowPacket(encodeV5(flows, { sysUptimeMs: up, nowMs: now }), '10.0.0.1', new TemplateCache());
    expect(r.version).toBe(5);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ src: '8.8.8.8', dst: '103.150.120.10', bytes: 1_500_000, packets: 1000, sampling: 1 });
    expect(Math.abs(r.records[0]!.start! - (now - 20_000))).toBeLessThan(1000);
    expect(Math.abs(r.records[0]!.end! - (now - 5_000))).toBeLessThan(1000);
  });

  it('NetFlow v5 header sampling', () => {
    const r = decodeFlowPacket(encodeV5(flows, { sysUptimeMs: up, nowMs: now, sampling: 100 }), '10.0.0.1', new TemplateCache());
    expect(r.records[0]!.sampling).toBe(100);
  });

  it('NetFlow v9: data is read with the template; data before any template is skipped', () => {
    const cache = new TemplateCache();
    expect(decodeFlowPacket(encodeTemplated(9, flows, { sysUptimeMs: up, nowMs: now, withTemplate: false }), '10.0.0.1', cache).records).toEqual([]);
    const r = decodeFlowPacket(encodeTemplated(9, flows, { sysUptimeMs: up, nowMs: now }), '10.0.0.1', cache);
    expect(r.records.map((x) => [x.src, x.dst, x.bytes])).toEqual([
      ['8.8.8.8', '103.150.120.10', 1_500_000],
      ['103.150.120.10', '1.1.1.1', 40_000],
    ]);
    expect(Math.abs(r.records[0]!.start! - (now - 20_000))).toBeLessThan(1000);
    // Later packets without templates use the remembered one, per exporter only.
    expect(decodeFlowPacket(encodeTemplated(9, flows, { sysUptimeMs: up, nowMs: now, withTemplate: false }), '10.0.0.1', cache).records).toHaveLength(2);
    expect(decodeFlowPacket(encodeTemplated(9, flows, { sysUptimeMs: up, nowMs: now, withTemplate: false }), '10.0.0.2', cache).records).toEqual([]);
  });

  it('IPFIX with IPv4 and IPv6, and sampling announced in an options record', () => {
    const cache = new TemplateCache();
    const six: SimFlow = { src: '2001:db8::1', dst: '2400:cb00:2049:1::a29f:1804', bytes: 9_000_000_000, packets: 7, start: now - 3000, end: now - 1000 };
    const r = decodeFlowPacket(encodeTemplated(10, [...flows, six], { sysUptimeMs: up, nowMs: now, sampling: 64 }), '10.0.0.1', cache);
    expect(r.version).toBe(10);
    expect(r.records).toHaveLength(3);
    const v6 = r.records.find((x) => x.src === '2001:db8::1')!;
    expect(v6).toMatchObject({ dst: '2400:cb00:2049:1::a29f:1804', bytes: 9_000_000_000, start: now - 3000, end: now - 1000 });
    expect(r.records.every((x) => x.sampling === 64)).toBe(true);
  });

  it('rejects malformed and unknown packets', () => {
    const cache = new TemplateCache();
    expect(() => decodeFlowPacket(Buffer.from([0, 5, 0]), 'x', cache)).toThrow(FlowDecodeError);
    expect(() => decodeFlowPacket(encodeV5(flows, { sysUptimeMs: up, nowMs: now }).subarray(0, 60), 'x', cache)).toThrow(FlowDecodeError);
    expect(() => decodeFlowPacket(Buffer.from('474554202f20485454502f312e310d0a', 'hex'), 'x', cache)).toThrow(FlowDecodeError);
    const bad = encodeTemplated(10, flows, { sysUptimeMs: up, nowMs: now });
    bad.writeUInt16BE(bad.length + 100, 2); // claims more than it has
    expect(() => decodeFlowPacket(bad, 'x', cache)).toThrow(FlowDecodeError);
    // Random bytes never crash the decoder.
    for (let i = 0; i < 500; i++) {
      const junk = Buffer.from(Array.from({ length: 20 + Math.floor(Math.random() * 400) }, () => Math.floor(Math.random() * 256)));
      junk.writeUInt16BE([5, 9, 10][i % 3]!, 0);
      try {
        decodeFlowPacket(junk, 'fuzz', cache);
      } catch (e) {
        expect(e).toBeInstanceOf(FlowDecodeError);
      }
    }
  });
});

describe('attribution', () => {
  it('spreads a flow over the minutes it lasted, and falls back to arrival time for implausible clocks', () => {
    const t0 = Date.UTC(2026, 9, 16, 6, 0, 0);
    const parts = spread(t0 + 30_000, t0 + 90_000, t0 + 100_000);
    expect(parts).toEqual([
      [t0, 0.5],
      [t0 + 60_000, 0.5],
    ]);
    expect(spread(null, null, t0 + 5_000)).toEqual([[t0, 1]]);
    expect(spread(t0 + 10 * 60_000, t0 + 11 * 60_000, t0)).toEqual([[t0, 1]]); // in the future
    expect(spread(t0 - 10 * 3600_000, t0 - 9 * 3600_000, t0)).toEqual([[t0, 1]]); // hours old
  });

  it('download to your destination, upload from your source; internet addresses are not kept', () => {
    const own = new BlockList();
    own.addSubnet('103.150.120.0', 24, 'ipv4');
    const agg = new FlowAggregator();
    const t0 = Date.UTC(2026, 9, 16, 6, 0, 0);
    expect(agg.add('org', own, { src: '8.8.8.8', dst: '103.150.120.10', bytes: 1000, packets: 2, start: t0 + 1000, end: t0 + 2000, sampling: 1 }, 1, t0 + 5000)).toBe(true);
    expect(agg.add('org', own, { src: '103.150.120.10', dst: '1.1.1.1', bytes: 300, packets: 1, start: t0 + 1000, end: t0 + 2000, sampling: 1 }, 10, t0 + 5000)).toBe(true);
    expect(agg.add('org', own, { src: '8.8.8.8', dst: '1.1.1.1', bytes: 999, packets: 1, start: null, end: null, sampling: 1 }, 1, t0 + 5000)).toBe(false);
    const p = agg.take().get('org')!.get(t0)!;
    expect([...p.keys()]).toEqual(['103.150.120.10']);
    expect(p.get('103.150.120.10')).toEqual([1000, 3000, 2, 10]);
  });
});

describe('live window', () => {
  it('rates over the last minute of what arrived, busiest first; old slots fall out', () => {
    const own = new BlockList();
    own.addSubnet('103.150.120.0', 24, 'ipv4');
    const agg = new FlowAggregator();
    const live = new LiveWindow();
    agg.live = live;
    const t = Date.now();
    live.add('warmup', '103.150.120.99', 0, 1, t - 120_000);
    agg.add('org', own, { src: '8.8.8.8', dst: '103.150.120.10', bytes: 7_500_000, packets: 1, start: null, end: null, sampling: 1 }, 1, t);
    agg.add('org', own, { src: '103.150.120.11', dst: '8.8.8.8', bytes: 750_000, packets: 1, start: null, end: null, sampling: 1 }, 1, t);
    // Ten seconds after flows started arriving: averaged over those 10 s (7.5 MB in 10 s = 6 Mbit/s).
    expect(live.rotate(t + 10_000).get('org')!).toMatchObject({ windowSeconds: 10, ips: [{ ip: '103.150.120.10', inBps: 6_000_000, outBps: 0 }, { ip: '103.150.120.11', inBps: 0, outBps: 600_000 }] });
    // After a full minute the window is 60 s: 7.5 MB in 60 s = 1 Mbit/s.
    const snap = live.rotate(t + 120_000).get('org')!;
    expect(snap.windowSeconds).toBe(60);
    expect(snap.ips[0]).toEqual({ ip: '103.150.120.10', inBps: 1_000_000, outBps: 0 });
    expect(snap.ips[1]).toEqual({ ip: '103.150.120.11', inBps: 0, outBps: 100_000 });
    for (let i = 0; i < 12; i++) live.rotate(t + 120_000);
    expect(live.rotate(t + 120_000).get('org')!.ips).toEqual([]);
  });
});
