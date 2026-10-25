/**
 * A stand-in for an IRRd 4 server's HTTP whois interface (/v1/whois/?q=…):
 * AS152565:AS-JOYSVC contains AS-EXAMPLE, which contains AS210000;
 * AS-TRANSIT-CUST does not. Route objects: AS210000 has 45.10.20.0/22 and
 * 45.10.30.0/24, no IPv6 route6 objects.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const SETS: Record<string, string[]> = { 'AS152565:AS-JOYSVC': ['AS152565', 'AS-EXAMPLE', 'AS64999'], 'AS-EXAMPLE': ['AS210000'], 'AS-TRANSIT-CUST': ['AS9498', 'AS64998'] };
const ROUTES: Record<string, string[]> = { '!gAS210000': ['45.10.20.0/22', '45.10.30.0/24'], '!6AS210000': [] };

function expand(set: string, seen = new Set<string>()): string[] {
  if (seen.has(set)) return [];
  seen.add(set);
  return (SETS[set] ?? []).flatMap((m) => (m.startsWith('AS-') || m.includes(':') ? expand(m, seen) : [m]));
}

export function irrAnswer(q: string): string {
  const a = (words: string[]) => (words.length ? `A${words.join(' ').length + 1}\n${words.join(' ')}\nC\n` : 'C\n');
  const set = /^!i(.+?)(,1)?$/.exec(q);
  if (set) {
    const name = set[1]!.toUpperCase();
    if (!SETS[name]) return 'D\n';
    return a(set[2] ? [...new Set(expand(name))] : SETS[name]!);
  }
  if (q in ROUTES) return a(ROUTES[q]!);
  if (/^!(g|6)AS\d+$/.test(q)) return 'C\n';
  return 'F Unrecognised command\n';
}

export async function startIrrd(port = 0): Promise<{ url: string; queries: string[]; close: () => Promise<void> }> {
  const queries: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method !== 'GET' || u.pathname !== '/v1/whois/') {
      res.writeHead(404);
      return res.end();
    }
    const q = u.searchParams.get('q') ?? '';
    queries.push(q);
    const body = irrAnswer(q);
    res.writeHead(body.startsWith('D') ? 404 : body.startsWith('F') ? 400 : 200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, queries, close: () => new Promise((r) => server.close(() => r())) };
}
