import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * In-memory mocks of the PowerDNS HTTP API and the Cloudflare DNS API, enough
 * of each for the IPAM DNS publisher: zone lookup, record listing by name and
 * type, and record changes. Shapes follow the vendors' API documentation.
 */
export interface Rrset {
  name: string;
  type: string;
  ttl?: number;
  records: { content: string; disabled?: boolean }[];
  comments?: { content: string; account?: string }[];
}

export interface MockPdns {
  url: string;
  zones: Map<string, Rrset[]>; // zone name with trailing dot → rrsets
  requests: { method: string; url: string; apiKey?: string }[];
  /** Delay before answering GETs (to provoke races in tests). */
  delayMs: number;
  close: () => Promise<void>;
}

const json = (res: http.ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => r(b));
  });
}

export async function startPowerDns(apiKey: string, zoneNames: string[]): Promise<MockPdns> {
  const zones = new Map<string, Rrset[]>(zoneNames.map((z) => [`${z}.`, []]));
  const requests: MockPdns['requests'] = [];
  const state = { delayMs: 0 };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method!, url: req.url!, apiKey: req.headers['x-api-key'] as string | undefined });
    if (req.headers['x-api-key'] !== apiKey) return json(res, 401, { error: 'Unauthorized' });
    const u = new URL(req.url!, 'http://x');
    const m = /^\/api\/v1\/servers\/localhost(?:\/zones\/([^/]+))?$/.exec(u.pathname);
    if (!m) return json(res, 404, { error: 'Not Found' });
    if (!m[1]) return json(res, 200, { type: 'Server', id: 'localhost', daemon_type: 'authoritative', version: '4.9.1' });
    const zname = decodeURIComponent(m[1]);
    const sets = zones.get(zname);
    if (!sets) return json(res, 404, { error: 'Could not find domain' });
    if (req.method === 'GET') {
      const name = u.searchParams.get('rrset_name');
      const type = u.searchParams.get('rrset_type');
      // The answer is taken now and delivered after the delay, like a slow server: a concurrent writer can change the data meanwhile.
      const answer = JSON.parse(JSON.stringify({ name: zname, rrsets: sets.filter((s) => (!name || s.name === name) && (!type || s.type === type)) }));
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      return json(res, 200, answer);
    }
    if (req.method === 'PATCH') {
      const { rrsets } = JSON.parse(body) as { rrsets: (Rrset & { changetype: string })[] };
      for (const r of rrsets) {
        if (!r.name.endsWith(zname)) return json(res, 422, { error: `RRset ${r.name} is not in zone ${zname}` });
        const i = sets.findIndex((s) => s.name === r.name && s.type === r.type);
        if (i >= 0) sets.splice(i, 1);
        if (r.changetype === 'REPLACE') sets.push({ name: r.name, type: r.type, ttl: r.ttl, records: r.records, comments: r.comments });
      }
      res.writeHead(204);
      return res.end();
    }
    return json(res, 405, { error: 'Method not allowed' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    zones,
    requests,
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(v: number) {
      state.delayMs = v;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string | null;
}
export interface MockCloudflare {
  base: string;
  records: Map<string, CfRecord[]>; // zone id → records
  close: () => Promise<void>;
}

export async function startCloudflare(token: string, zones: Record<string, string>): Promise<MockCloudflare> {
  const records = new Map<string, CfRecord[]>(Object.keys(zones).map((id) => [id, []]));
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 403, { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] });
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/client/v4/user/tokens/verify') return json(res, 200, { success: true, result: { status: 'active' } });
    const m = /^\/client\/v4\/zones\/([^/]+)(\/dns_records(?:\/([^/]+))?)?$/.exec(u.pathname);
    if (!m || !records.has(m[1]!)) return json(res, 404, { success: false, errors: [{ code: 7003, message: 'Could not route' }] });
    const list = records.get(m[1]!)!;
    if (!m[2]) return json(res, 200, { success: true, result: { id: m[1], name: zones[m[1]!] } });
    if (req.method === 'GET') {
      const type = u.searchParams.get('type');
      const name = u.searchParams.get('name');
      return json(res, 200, { success: true, result: list.filter((r) => (!type || r.type === type) && (!name || r.name === name)) });
    }
    if (req.method === 'POST') {
      const r = JSON.parse(body) as CfRecord;
      const rec = { id: `rec${++seq}`, type: r.type, name: r.name, content: r.content, comment: r.comment ?? null };
      list.push(rec);
      return json(res, 200, { success: true, result: rec });
    }
    if (req.method === 'DELETE' && m[3]) {
      const i = list.findIndex((r) => r.id === m[3]);
      if (i < 0) return json(res, 404, { success: false, errors: [{ message: 'Record not found' }] });
      list.splice(i, 1);
      return json(res, 200, { success: true, result: { id: m[3] } });
    }
    return json(res, 405, { success: false });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`, records, close: () => new Promise((r) => server.close(() => r())) };
}
