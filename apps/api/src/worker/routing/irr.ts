/**
 * Read-only queries to an IRRd 4 server over its HTTP whois interface
 * (GET /v1/whois/?q=…, https://irrd.readthedocs.io/en/latest/users/queries/whois/):
 * AS-SET expansion (!i) and route objects by origin (!g, !6). The default
 * server, rr.ntt.net, mirrors the major registries (RIPE, APNIC, ARIN,
 * RADB, …), so a set or route object in any of them is found.
 */
export interface Irr {
  server: string;
  /** The answer's words, [] when the query found nothing, null when the key (e.g. the set) does not exist. */
  query(q: string): Promise<string[] | null>;
}

export class IrrError extends Error {}

/** Parses an IRRd response: "A<len>\n<data>\nC", "C" (nothing found), "D" (key not found), "F <error>". */
export function parseIrrResponse(body: string): string[] | null {
  const t = body.replace(/\r/g, '').trim();
  if (t === 'C') return [];
  if (t === 'D') return null;
  if (t.startsWith('F')) throw new IrrError(`IRR: ${t.slice(1).trim() || 'query refused'}`.slice(0, 200));
  const m = /^A\d+\n([\s\S]*?)\n?C$/.exec(t);
  if (!m) throw new IrrError('IRR: unexpected answer');
  return m[1]!.split(/\s+/).filter(Boolean);
}

export function irrClient(base = 'https://rr.ntt.net', fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): Irr {
  return {
    server: new URL(base).host,
    async query(q) {
      const u = new URL('/v1/whois/', base);
      u.searchParams.set('q', q);
      let res: Response;
      try {
        res = await fetchImpl(u, { headers: { 'user-agent': 'NexoraDC-DCIM routing check' }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new IrrError(`IRR ${u.host}: ${(e as Error).name === 'TimeoutError' ? 'no answer' : ((e as Error).cause as Error)?.message || (e as Error).message}`);
      }
      const text = await res.text();
      // IRRd answers 404 for D and 400 for F over HTTP; the body still carries the code.
      if (!res.ok && !/^[CDF]/.test(text.trim())) throw new IrrError(`IRR ${u.host}: HTTP ${res.status}`);
      return parseIrrResponse(text);
    },
  };
}

const asnOf = (w: string) => (/^AS\d+$/i.test(w) ? Number(w.slice(2)) : null);

/** Expands an AS-SET: all ASNs (recursive) and the direct members (ASNs and set names). null when the set does not exist. */
export async function expandAsSet(irr: Irr, set: string): Promise<{ asns: number[]; direct: string[] } | null> {
  const all = await irr.query(`!i${set},1`);
  if (all === null) return null;
  const direct = (await irr.query(`!i${set}`)) ?? [];
  return { asns: [...new Set(all.map(asnOf).filter((x): x is number => x !== null))], direct: direct.map((d) => d.toUpperCase()) };
}

/** Route objects (route and route6) with this origin. */
export async function routeObjectsOf(irr: Irr, asn: number): Promise<string[]> {
  const v4 = (await irr.query(`!gAS${asn}`)) ?? [];
  const v6 = (await irr.query(`!6AS${asn}`)) ?? [];
  return [...new Set([...v4, ...v6])].sort();
}
