import { describe, expect, it } from 'vitest';
import { evaluatePrefix, upstreamsFrom } from './ripestat';
import { LOOKING_GLASS, ROUTING_STATUS, RPKI } from '../../../test/simulators/ripestat';
import { routingSkipReason } from '@crapplet/shared';

const rpki = (origin: number, prefix: string) => ({ origin, prefix, data: RPKI[`${origin} ${prefix}`] as Record<string, unknown> });
const ans = (p: string, r: { origin: number; prefix: string }[], lg = true) => ({
  status: ROUTING_STATUS[p] as Record<string, unknown>,
  rpki: r.map((x) => rpki(x.origin, x.prefix)),
  lookingGlass: lg ? ((LOOKING_GLASS[r[0]?.prefix ?? p] as Record<string, unknown>) ?? null) : null,
});
const codes = (d: { findings: { code: string }[] }) => d.findings.map((f) => f.code);

describe('routing evaluation', () => {
  it('our exact announcement with a ROA and a route object is OK; upstreams from AS paths (prepending removed)', () => {
    const d = evaluatePrefix('45.10.20.0/22', [210000], ans('45.10.20.0/22', [{ origin: 210000, prefix: '45.10.20.0/22' }]));
    expect(d).toMatchObject({ level: 'ok', announced: true, effective: { prefix: '45.10.20.0/22', origins: [210000] }, visibility: { seeing: 310, total: 320 }, exact: [{ asn: 210000, routeObjects: ['RIPE'] }] });
    expect(d.rpki[0]).toMatchObject({ status: 'valid', roas: [{ origin: 210000, prefix: '45.10.20.0/22', maxLength: 24 }] });
    expect(d.upstreams).toEqual([
      { asn: 3356, peers: 2 },
      { asn: 1299, peers: 1 },
      { asn: 6939, peers: 1 },
    ]);
    expect(d.findings).toEqual([]);
  });

  it('a pool inside our announced aggregate is routed through it', () => {
    const d = evaluatePrefix('45.10.21.0/24', [210000], ans('45.10.21.0/24', [{ origin: 210000, prefix: '45.10.20.0/22' }]));
    expect(d).toMatchObject({ level: 'ok', effective: { prefix: '45.10.20.0/22' } });
    expect(codes(d)).toEqual(['covered']);
  });

  it('not announced is critical', () => {
    const d = evaluatePrefix('45.10.30.0/24', [210000], ans('45.10.30.0/24', [{ origin: 210000, prefix: '45.10.30.0/24' }], false));
    expect(d).toMatchObject({ level: 'critical', announced: false, effective: null });
    expect(codes(d)).toEqual(['not_announced']);
  });

  it('another AS announcing our prefix (RPKI invalid) is critical', () => {
    const d = evaluatePrefix('45.10.40.0/24', [210000], ans('45.10.40.0/24', [{ origin: 666, prefix: '45.10.40.0/24' }]));
    expect(d.level).toBe('critical');
    expect(codes(d)).toEqual(['wrong_origin', 'rpki_invalid']);
    expect(d.findings[0]!.text).toMatch(/AS666, not by AS210000/);
  });

  it('missing ROA, missing route object, low visibility and a foreign more-specific', () => {
    const d = evaluatePrefix('2a0e:1000::/32', [210000], ans('2a0e:1000::/32', [{ origin: 210000, prefix: '2a0e:1000::/32' }]));
    expect(d.level).toBe('critical');
    expect(codes(d)).toEqual(['rpki_unknown', 'no_route_object', 'low_visibility', 'foreign_more_specific']);
  });

  it('an expected origin per prefix (customer ASN)', () => {
    expect(evaluatePrefix('45.10.50.0/24', [65010], ans('45.10.50.0/24', [{ origin: 65010, prefix: '45.10.50.0/24' }])).level).toBe('ok');
    expect(evaluatePrefix('45.10.50.0/24', [210000], ans('45.10.50.0/24', [{ origin: 65010, prefix: '45.10.50.0/24' }])).level).toBe('critical');
  });

  it('upstreams ignore malformed paths', () => {
    expect(upstreamsFrom({ rrcs: [{ peers: [{ as_path: '' }, { as_path: ['174', '{1,2}', '210000'] }, { as_path: '210000' }] }] })).toEqual({ upstreams: [{ asn: 174, peers: 1 }], pathPeers: 2 });
    expect(upstreamsFrom(null)).toEqual({ upstreams: [], pathPeers: 0 });
  });

  it('only public prefixes up to /24 and /48 are sent out', () => {
    expect(routingSkipReason('45.10.20.0/22')).toBeNull();
    expect(routingSkipReason('2a0e:1000::/32')).toBeNull();
    expect(routingSkipReason('10.1.0.0/16')).toMatch(/Private/);
    expect(routingSkipReason('100.64.0.0/24')).toMatch(/Private/);
    expect(routingSkipReason('203.0.113.0/24')).toMatch(/Private/);
    expect(routingSkipReason('45.10.20.0/25')).toMatch(/\/24/);
    expect(routingSkipReason('2a0e:1000::/56')).toMatch(/\/48/);
    expect(routingSkipReason('fd00::/48')).toMatch(/global unicast/);
  });
});
