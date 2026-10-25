/**
 * A stand-in for the RIPEstat Data API with a few routing situations:
 * AS210000 (ours) announces 45.10.20.0/22 and 2a0e:1000::/32 (no route
 * object, no ROA) and 45.10.99.0/24 (not in IPAM); 45.10.30.0/24 is not
 * announced; 45.10.40.0/24 is announced by AS666; 45.10.50.0/24 by a
 * customer's AS65010.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const T = '2026-10-25T08:00:00';
const vis = (seeing: number) => ({ v4: { ris_peers_seeing: seeing, total_ris_peers: 320 }, v6: { ris_peers_seeing: seeing, total_ris_peers: 300 } });
const lg = (prefix: string, paths: string[]) => ({ rrcs: [{ rrc: 'RRC00', location: 'Amsterdam', peers: paths.map((p, i) => ({ as_path: p, prefix, peer: `192.0.2.${i + 1}`, asn_origin: p.split(' ').pop() })) }], latest_time: T });

export const ROUTING_STATUS: Record<string, unknown> = {
  '45.10.20.0/22': {
    query_time: T,
    visibility: vis(310),
    origins: [{ origin: 210000, route_objects: ['RIPE'] }],
    less_specifics: [],
    more_specifics: [],
    first_seen: { time: '2021-03-01T00:00:00', origin: '210000', prefix: '45.10.20.0/22' },
    last_seen: { time: T, origin: '210000', prefix: '45.10.20.0/22' },
  },
  '45.10.21.0/24': { query_time: T, visibility: vis(310), origins: [], less_specifics: [{ prefix: '45.10.20.0/22', origin: 210000 }], more_specifics: [] },
  '45.10.30.0/24': { query_time: T, visibility: vis(0), origins: [], less_specifics: [], more_specifics: [] },
  '45.10.40.0/24': { query_time: T, visibility: vis(290), origins: [{ origin: 666, route_objects: [] }], less_specifics: [], more_specifics: [] },
  '45.10.50.0/24': { query_time: T, visibility: vis(300), origins: [{ origin: 65010, route_objects: ['RADB'] }], less_specifics: [], more_specifics: [] },
  '2a0e:1000::/32': { query_time: T, visibility: vis(120), origins: [{ origin: 210000, route_objects: [] }], less_specifics: [], more_specifics: [{ prefix: '2a0e:1000:66::/48', origin: 666 }] },
  AS210000: { query_time: T, announced_space: { v4: { prefixes: 2, ips: 1280 }, v6: { prefixes: 1, '48s': 65536 } }, observed_neighbours: 4 },
};
export const RPKI: Record<string, unknown> = {
  '210000 45.10.20.0/22': { status: 'valid', validating_roas: [{ origin: '210000', prefix: '45.10.20.0/22', max_length: 24, validity: 'valid' }] },
  '210000 45.10.30.0/24': { status: 'unknown', validating_roas: [] },
  '666 45.10.40.0/24': { status: 'invalid_asn', validating_roas: [{ origin: '210000', prefix: '45.10.40.0/22', max_length: 24, validity: 'invalid_asn' }] },
  '65010 45.10.50.0/24': { status: 'valid', validating_roas: [{ origin: '65010', prefix: '45.10.50.0/24', max_length: 24, validity: 'valid' }] },
  '210000 2a0e:1000::/32': { status: 'unknown', validating_roas: [] },
};
export const LOOKING_GLASS: Record<string, unknown> = {
  '45.10.20.0/22': lg('45.10.20.0/22', ['174 3356 210000', '6939 210000', '1299 210000 210000', '3356 210000']),
  '45.10.40.0/24': lg('45.10.40.0/24', ['174 666']),
  '45.10.50.0/24': lg('45.10.50.0/24', ['6939 210000 65010']),
  '2a0e:1000::/32': lg('2a0e:1000::/32', ['6939 210000']),
};

export interface MockRipeStat {
  url: string;
  requests: { call: string; params: Record<string, string> }[];
  close: () => Promise<void>;
}

export async function startRipeStat(port = 0): Promise<MockRipeStat> {
  const requests: MockRipeStat['requests'] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const call = /^\/data\/([\w-]+)\/data\.json$/.exec(u.pathname)?.[1] ?? '';
    const params = Object.fromEntries(u.searchParams);
    requests.push({ call, params });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { status: 'error' });
    const r = params.resource ?? '';
    const ok = (data: unknown) => send(200, { status: 'ok', status_code: 200, data });
    if (call === 'routing-status') return ROUTING_STATUS[r] ? ok({ resource: r, ...(ROUTING_STATUS[r] as object) }) : ok({ resource: r, query_time: T, visibility: vis(0), origins: [], less_specifics: [], more_specifics: [] });
    if (call === 'rpki-validation') return ok({ resource: r, prefix: params.prefix, ...((RPKI[`${r} ${params.prefix}`] as object) ?? { status: 'unknown', validating_roas: [] }) });
    if (call === 'looking-glass') return ok(LOOKING_GLASS[r] ?? { rrcs: [] });
    if (call === 'as-overview') return ok({ resource: r, holder: r === 'AS210000' ? 'EXAMPLE-NET - Example Networks' : null, announced: true });
    if (call === 'announced-prefixes')
      return ok({
        resource: r,
        query_starttime: '2026-10-11T08:00:00',
        query_endtime: T,
        prefixes:
          r === 'AS210000'
            ? [
                { prefix: '45.10.20.0/22', timelines: [{ starttime: '2026-10-11T08:00:00', endtime: T }] },
                { prefix: '2a0e:1000::/32', timelines: [{ starttime: '2026-10-11T08:00:00', endtime: T }] },
                { prefix: '45.10.99.0/24', timelines: [{ starttime: '2026-10-20T08:00:00', endtime: T }] },
                { prefix: '45.10.98.0/24', timelines: [{ starttime: '2026-10-11T08:00:00', endtime: '2026-10-12T00:00:00' }] },
              ]
            : [],
      });
    send(404, { status: 'error', messages: [['error', 'unknown data call']] });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}
