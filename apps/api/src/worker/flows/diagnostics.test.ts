import { describe, expect, it } from 'vitest';
import { FlowProfile } from './diagnostics';
import { flowAccuracy, type FlowCoverage } from '../../monitoring/flow-accuracy';

const now = Date.parse('2026-11-02T16:00:30Z');
const rec = (sec: number, src = '8.8.8.8') => ({ src, start: now - sec * 1000, end: now });
const codes = (r: ReturnType<typeof flowAccuracy>) => r.findings.map((f) => f.code);

describe('flow profile', () => {
  it('reveals a 30-minute active timeout, bytes outside IPAM, IPv6 and sampling', () => {
    const p = new FlowProfile();
    for (let i = 0; i < 4; i++) p.add(rec(1800), 1_000_000, 1, true, now);
    p.add(rec(5), 100_000, 1, true, now);
    p.add(rec(5), 1_000_000, 1, false, now);
    p.add({ src: '2001:db8::1', start: null, end: null }, 10, 4, true, now);
    expect(p.snapshot(now)).toMatchObject({ records: 7, bytes: 5_100_010, matchedBytes: 4_100_010, ipv6Records: 1, untimedRecords: 1, longestSeconds: 1800, atLongestRecords: 4, sampling: 4 });
    expect(p.snapshot(now).longFlowByteShare).toBeCloseTo(4_000_000 / 5_100_010);
    // Older than 15 minutes falls out.
    expect(p.snapshot(now + 16 * 60_000).records).toBe(0);
  });
});

describe('flow accuracy', () => {
  const p = new FlowProfile();
  for (let i = 0; i < 5; i++) p.add(rec(30), 1_000_000, 1, true, now);
  p.add(rec(30, '2001:db8::1'), 1000, 1, true, now);
  const good = p.snapshot(now);
  const cov = (down: number): FlowCoverage => ({
    from: '2026-11-02T15:00:00.000Z',
    to: '2026-11-02T15:30:00.000Z',
    interfaceName: 'sfp1',
    deviceName: 'edge',
    counterDownBytes: 1e9,
    counterUpBytes: 1e8,
    flowDownBytes: down * 1e9,
    flowUpBytes: 1e8,
    download: down,
    upload: 1,
  });

  it('short timeout, matching counters: OK', () => {
    const r = flowAccuracy({ name: 'edge', liveInterface: 'sfp1', exportersInOrg: 1 }, good, cov(0.95));
    expect(r).toMatchObject({ level: 'ok' });
    expect(codes(r)).toEqual(['coverage_ok']);
  });
  it('flows far below the counters: critical, with causes; above them: counted twice', () => {
    const low = flowAccuracy({ name: 'edge', liveInterface: 'sfp1', exportersInOrg: 2 }, good, cov(0.2));
    expect(low.level).toBe('critical');
    expect(low.findings[0]!.text).toMatch(/only 20% of the download.*all your exporters/);
    expect(low.findings[0]!.causes!.join(' ')).toMatch(/hardware offloading/);
    expect(codes(flowAccuracy({ name: 'edge', liveInterface: 'sfp1', exportersInOrg: 1 }, good, cov(2)))).toEqual(['coverage_high']);
  });
  it('without an interface: says how to get the comparison', () => {
    expect(codes(flowAccuracy({ name: 'edge', liveInterface: null, exportersInOrg: 1 }, good, null))).toEqual(['no_interface']);
    expect(flowAccuracy({ name: 'edge', liveInterface: null, exportersInOrg: 1 }, null, null).level).toBe('unknown');
  });
});
