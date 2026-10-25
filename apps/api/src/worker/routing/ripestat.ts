import type { AsnRoutingData, PrefixRoutingData, RoutingFinding, RoutingLevel, RpkiStatus } from '@crapplet/shared';

/**
 * Reads the global routing table from the outside through the RIPEstat Data
 * API (https://stat.ripe.net/docs/02.data-api/): RIPE RIS route collectors
 * (routing-status, looking-glass, announced-prefixes), RIPE NCC's RPKI
 * validator (rpki-validation) and the routing registries (route objects in
 * routing-status). GET requests only; nothing is announced or changed.
 */
type Row = Record<string, unknown>;
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const arr = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]).map(obj) : []);
const asn = (v: unknown): number | null => {
  const n = Number(String(v ?? '').replace(/^AS/i, ''));
  return Number.isInteger(n) && n > 0 && n <= 4294967295 ? n : null;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export interface RipeStat {
  get(call: string, params: Record<string, string>): Promise<Row>;
}

export class RipeStatError extends Error {}

/** A RIPEstat client; `base` defaults to https://stat.ripe.net. */
export function ripeStat(base = 'https://stat.ripe.net', fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): RipeStat {
  return {
    async get(call, params) {
      const u = new URL(`/data/${call}/data.json`, base);
      for (const [k, v] of Object.entries({ ...params, sourceapp: 'nexoradc-dcim' })) u.searchParams.set(k, v);
      let res: Response;
      try {
        res = await fetchImpl(u, { headers: { accept: 'application/json', 'user-agent': 'NexoraDC-DCIM routing check' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new RipeStatError(`RIPEstat ${call}: ${(e as Error).name === 'TimeoutError' ? 'no answer' : ((e as Error).cause as Error)?.message || (e as Error).message}`);
      }
      if (res.status === 429) throw new RipeStatError(`RIPEstat ${call}: rate limited, will retry later`);
      const body = obj(await res.json().catch(() => null));
      if (!res.ok || body.status === 'error') {
        const msg = Array.isArray(body.messages) ? (body.messages as unknown[]).map((m) => (Array.isArray(m) ? String(m[1] ?? '') : '')).find(Boolean) : '';
        throw new RipeStatError(`RIPEstat ${call}: HTTP ${res.status}${msg ? ` — ${msg.slice(0, 200)}` : ''}`);
      }
      return obj(body.data);
    },
  };
}

/** Raw answers for one prefix. */
export interface PrefixAnswers {
  status: Row;
  rpki: { prefix: string; origin: number; data: Row }[];
  lookingGlass: Row | null;
}

/** Fetches what is needed for one prefix: 1 routing-status, up to 3 RPKI validations and 1 looking-glass. */
export async function fetchPrefix(c: RipeStat, prefix: string, expected: number[]): Promise<PrefixAnswers> {
  const status = await c.get('routing-status', { resource: prefix });
  const eff = effectiveOf(status, prefix);
  const pairs = eff ? eff.origins.slice(0, 3).map((o) => ({ prefix: eff.prefix, origin: o })) : expected.slice(0, 2).map((o) => ({ prefix, origin: o }));
  const rpki = [];
  for (const pr of pairs) rpki.push({ ...pr, data: await c.get('rpki-validation', { resource: String(pr.origin), prefix: pr.prefix }) });
  const lookingGlass = eff ? await c.get('looking-glass', { resource: eff.prefix }).catch(() => null) : null;
  return { status, rpki, lookingGlass };
}

const prefixLen = (p: string) => Number(p.split('/')[1] ?? 0);

/** The announcement carrying traffic: the exact prefix, else the most specific covering one. */
function effectiveOf(status: Row, prefix: string): { prefix: string; origins: number[] } | null {
  const exact = arr(status.origins)
    .map((o) => asn(o.origin))
    .filter((x): x is number => x !== null);
  if (exact.length) return { prefix, origins: [...new Set(exact)] };
  const less = arr(status.less_specifics).filter((l) => str(l.prefix));
  if (!less.length) return null;
  const best = Math.max(...less.map((l) => prefixLen(String(l.prefix))));
  const at = less.filter((l) => prefixLen(String(l.prefix)) === best);
  return { prefix: String(at[0]!.prefix), origins: [...new Set(at.map((l) => asn(l.origin)).filter((x): x is number => x !== null))] };
}

/** Upstream ASes from RIS peers' AS paths (the AS before the origin, prepending removed). */
export function upstreamsFrom(lg: Row | null): { upstreams: { asn: number; peers: number }[]; pathPeers: number } {
  const counts = new Map<number, number>();
  let pathPeers = 0;
  for (const rrc of arr(lg?.rrcs)) {
    for (const peer of arr(rrc.peers)) {
      const raw = Array.isArray(peer.as_path) ? (peer.as_path as unknown[]).join(' ') : String(peer.as_path ?? '');
      const path = raw
        .split(/\s+/)
        .map(asn)
        .filter((x): x is number => x !== null)
        .filter((x, i, a) => i === 0 || a[i - 1] !== x);
      if (!path.length) continue;
      pathPeers++;
      if (path.length >= 2) counts.set(path[path.length - 2]!, (counts.get(path[path.length - 2]!) ?? 0) + 1);
    }
  }
  return { upstreams: [...counts.entries()].map(([a, peers]) => ({ asn: a, peers })).sort((a, b) => b.peers - a.peers || a.asn - b.asn), pathPeers };
}

const RPKI: Record<string, RpkiStatus> = { valid: 'valid', invalid_asn: 'invalid_asn', invalid_length: 'invalid_length', invalid: 'invalid', unknown: 'unknown', 'not-found': 'unknown', not_found: 'unknown' };

/** Turns the raw answers into the stored result with findings and an overall level. */
export function evaluatePrefix(prefix: string, expected: number[], a: PrefixAnswers): PrefixRoutingData {
  const s = a.status;
  const family = prefix.includes(':') ? 'v6' : 'v4';
  const vis = obj(obj(s.visibility)[family]);
  const seen = (v: unknown) => (obj(v).time ? { time: String(obj(v).time), origin: asn(obj(v).origin), prefix: str(obj(v).prefix) } : null);
  const exact = arr(s.origins)
    .map((o) => ({ asn: asn(o.origin), routeObjects: Array.isArray(o.route_objects) ? (o.route_objects as unknown[]).map(String) : [] }))
    .filter((o): o is { asn: number; routeObjects: string[] } => o.asn !== null);
  const pfx = (l: Row) => ({ prefix: String(l.prefix), origin: asn(l.origin) ?? 0 });
  const covering = arr(s.less_specifics)
    .filter((l) => str(l.prefix))
    .map(pfx);
  const moreSpecifics = arr(s.more_specifics)
    .filter((l) => str(l.prefix))
    .map(pfx);
  const effective = effectiveOf(s, prefix);
  const rpki = a.rpki.map((r) => ({
    prefix: r.prefix,
    origin: r.origin,
    status: RPKI[String(r.data.status ?? '').toLowerCase()] ?? 'unknown',
    roas: arr(r.data.validating_roas).map((v) => ({ origin: asn(v.origin) ?? 0, prefix: String(v.prefix ?? ''), maxLength: num(v.max_length) })),
  }));
  const { upstreams, pathPeers } = upstreamsFrom(a.lookingGlass);
  const visibility = num(vis.total_ris_peers) ? { seeing: num(vis.ris_peers_seeing) ?? 0, total: num(vis.total_ris_peers)! } : null;

  const f: RoutingFinding[] = [];
  const ours = (x: number) => expected.includes(x);
  const list = (xs: number[]) => xs.map((x) => `AS${x}`).join(', ');
  if (!expected.length) f.push({ level: 'warning', code: 'no_expected_asn', text: 'No ASN to compare with: add your ASN, or set the expected origin on the prefix' });
  if (!effective) {
    f.push({ level: 'critical', code: 'not_announced', text: 'Not seen in the global routing table (RIPE RIS)' });
    const roa = rpki.find((r) => r.status === 'valid');
    if (roa) f.push({ level: 'info', code: 'roa_ready', text: `A ROA already allows AS${roa.origin} to announce it` });
  } else {
    const foreign = effective.origins.filter((o) => !ours(o));
    if (expected.length && foreign.length && foreign.length === effective.origins.length)
      f.push({ level: 'critical', code: 'wrong_origin', text: `Announced by ${list(foreign)}, not by ${list(expected)} — a hijack, a leak, or another network announcing it (set the expected origin if this is intended)` });
    else if (expected.length && foreign.length) f.push({ level: 'warning', code: 'multiple_origins', text: `Also announced by ${list(foreign)} (multiple origins)` });
    if (effective.prefix !== prefix) f.push({ level: 'info', code: 'covered', text: `Routed through the covering ${effective.prefix} (${list(effective.origins)})` });
    for (const r of rpki) {
      if (r.status.startsWith('invalid'))
        f.push({
          level: 'critical',
          code: 'rpki_invalid',
          text: `RPKI ${r.status === 'invalid_length' ? 'invalid: longer than the ROA allows' : 'invalid: no ROA for this origin'} (${r.prefix} from AS${r.origin}) — networks that validate RPKI drop it`,
        });
      else if (r.status === 'unknown' && ours(r.origin)) f.push({ level: 'warning', code: 'rpki_unknown', text: `No ROA for ${r.prefix} from AS${r.origin}: create one with your RIR` });
    }
    if (effective.prefix === prefix)
      for (const o of exact) if (!o.routeObjects.length && ours(o.asn)) f.push({ level: 'warning', code: 'no_route_object', text: `No IRR route object for ${prefix} with origin AS${o.asn}: some upstreams filter on it` });
    if (visibility && visibility.total > 0 && visibility.seeing / visibility.total < 0.5) f.push({ level: 'warning', code: 'low_visibility', text: `Seen by only ${visibility.seeing} of ${visibility.total} RIS peers` });
  }
  for (const m of moreSpecifics) if (expected.length && m.origin && !ours(m.origin)) f.push({ level: 'critical', code: 'foreign_more_specific', text: `More-specific ${m.prefix} announced by AS${m.origin}` });
  const level: RoutingLevel = f.some((x) => x.level === 'critical') ? 'critical' : f.some((x) => x.level === 'warning') ? 'warning' : 'ok';
  return {
    source: 'RIPEstat (RIPE RIS, RPKI, IRR)',
    queryTime: str(s.query_time),
    expectedAsns: expected,
    announced: !!effective,
    exact,
    covering,
    moreSpecifics,
    effective,
    visibility,
    firstSeen: seen(s.first_seen),
    lastSeen: seen(s.last_seen),
    rpki,
    upstreams: upstreams.slice(0, 20),
    pathPeers,
    findings: f,
    level,
  };
}

/** What an AS announces now: holder, prefixes, neighbour count. */
export async function checkAsn(c: RipeStat, n: number): Promise<AsnRoutingData> {
  const overview = await c.get('as-overview', { resource: `AS${n}` }).catch(() => ({}) as Row);
  const status = await c.get('routing-status', { resource: `AS${n}` });
  const ann = await c.get('announced-prefixes', { resource: `AS${n}` });
  const end = Date.parse(String(ann.query_endtime ?? '')) || Date.now();
  const current = arr(ann.prefixes)
    .filter((p) => arr(p.timelines).some((t) => (Date.parse(String(t.endtime ?? '')) || 0) >= end - 12 * 3600_000))
    .map((p) => String(p.prefix));
  const space = obj(status.announced_space);
  return {
    source: 'RIPEstat (RIPE RIS)',
    queryTime: str(status.query_time),
    holder: str(obj(overview).holder),
    prefixes: [...new Set(current)].sort(),
    v4Prefixes: num(obj(space.v4).prefixes),
    v6Prefixes: num(obj(space.v6).prefixes),
    neighbours: num(status.observed_neighbours),
  };
}
