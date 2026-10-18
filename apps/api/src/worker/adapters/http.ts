import http from 'node:http';
import https from 'node:https';
import type { AdapterTarget } from '../../network/discovery/types';

/**
 * Connections are kept open briefly so the several requests of one reading
 * share a connection (BMCs are slow at new TLS handshakes and some stop
 * answering when connections churn), but an idle connection is closed after
 * 3 s, before BMCs drop it on their side. A request that fails on a reused
 * connection is retried on a brand-new one.
 */
const agentOpts = { keepAlive: true, keepAliveMsecs: 1000, maxSockets: 4, maxFreeSockets: 4, timeout: 3000 };
const httpAgent = new http.Agent(agentOpts);
const httpsAgent = new https.Agent(agentOpts);

export class DeviceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/**
 * The device's own explanation from an error body (Redfish `error.message` or
 * `@Message.ExtendedInfo[].Message`, or a plain `error`/`message` string),
 * single-line and capped. Device error bodies never contain our request
 * headers, so no secret can come back through here.
 */
export function deviceErrorText(raw: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  const err = (o.error && typeof o.error === 'object' ? o.error : o) as Record<string, unknown>;
  const info = Array.isArray(err['@Message.ExtendedInfo']) ? (err['@Message.ExtendedInfo'] as Record<string, unknown>[]) : [];
  const parts = info.map((m) => [m?.Message, m?.Resolution].filter((x) => typeof x === 'string' && x.trim()).join(' ')).filter(Boolean);
  const text = parts.length
    ? parts.join(' ')
    : typeof err.message === 'string'
      ? err.message
      : err.message && typeof err.message === 'object' && typeof (err.message as Record<string, unknown>).value === 'string'
        ? ((err.message as Record<string, unknown>).value as string)
        : typeof o.error === 'string'
          ? o.error
          : typeof o.message === 'string'
            ? o.message
            : null;
  if (!text) return null;
  const clean = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? (clean.length > 240 ? `${clean.slice(0, 237)}...` : clean) : null;
}

const MAX_BODY = 32 * 1024 * 1024;

/**
 * Small JSON client for device APIs. TLS verification is on unless the
 * credential explicitly disables it (self-signed management certificates).
 * Error messages never include request headers, so tokens and passwords
 * can't leak into run errors or logs.
 */
export function deviceRequest(
  t: AdapterTarget,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  opts: {
    headers?: Record<string, string>;
    body?: unknown;
    defaultPort: number;
    /** Resolve error statuses (with the parsed body) instead of rejecting. */ rawErrors?: boolean;
    /** A non-JSON body (e.g. a WS-Management SOAP envelope); the answer is returned as `text`. */ raw?: { data: string; contentType: string };
    /** Internal: redirects followed so far. */ hops?: number;
    /** Internal: already retried after a connection reset. */ retried?: boolean;
    /** A read sent as POST (WS-Man Enumerate/Pull): may be retried like a GET. */ idempotent?: boolean;
    /** Internal: parse leniently (older BMC firmware sends malformed HTTP). */ lenient?: boolean;
    /** Internal: use a new connection that is closed afterwards (retries). */ fresh?: boolean;
    /** Internal: offer TLS 1.2 at most (some older BMCs stall or reset on a TLS 1.3 hello). */ tls12?: boolean;
  },
): Promise<{ status: number; json: unknown; text?: string; location?: string }> {
  const scheme = t.params.scheme ?? 'https';
  const lib = scheme === 'https' ? https : http;
  const payload = opts.raw ? Buffer.from(opts.raw.data) : opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
  const timeout = t.params.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    // Set once an answer arrives: completes it from what was already received.
    let finishEarly: (() => boolean) | null = null;
    const req = lib.request(
      {
        host: t.host.replace(/^\[|\]$/g, ''),
        port: t.port ?? opts.defaultPort,
        method,
        path,
        // A fresh connection per request: BMCs and switches often drop idle
        // keep-alive sockets without notice, and reusing one gives ECONNRESET.
        agent: opts.fresh ? false : scheme === 'https' ? httpsAgent : httpAgent,
        ...(opts.lenient ? { insecureHTTPParser: true } : {}),
        headers: {
          Accept: opts.raw ? '*/*' : 'application/json',
          ...(opts.fresh ? { Connection: 'close' } : {}),
          ...(payload ? { 'Content-Type': opts.raw?.contentType ?? 'application/json', 'Content-Length': String(payload.length) } : {}),
          ...opts.headers,
        },
        timeout,
        ...(scheme === 'https' ? { rejectUnauthorized: t.params.verifyTls !== false, servername: /^[\d.:[\]]+$/.test(t.host) ? undefined : t.host, ...(opts.tls12 ? { maxVersion: 'TLSv1.2' as const } : {}) } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy(new DeviceHttpError('Response too large', res.statusCode ?? null));
            return;
          }
          chunks.push(c);
        });
        let ended = false;
        const onEnd = () => {
          if (ended) return;
          ended = true;
          const status = res.statusCode ?? 0;
          const raw = Buffer.concat(chunks).toString('utf8');
          if (opts.rawErrors) {
            let json: unknown = null;
            try {
              json = raw ? JSON.parse(raw) : null;
            } catch {
              json = null;
            }
            return resolve({ status, json, ...(res.headers.location ? { location: String(res.headers.location) } : {}) });
          }
          // Redirects: a GET to another path on the same host, scheme and port is
          // followed (BMCs redirect e.g. /Systems to /Systems/); anything else is
          // reported, since the request (with its credentials) would go elsewhere.
          if (status >= 300 && status < 400) {
            const loc = String(res.headers.location ?? '');
            const port = t.port ?? opts.defaultPort;
            let next: URL | null = null;
            try {
              next = loc ? new URL(loc, `${scheme}://${t.host.includes(':') && !t.host.startsWith('[') ? `[${t.host}]` : t.host}:${port}${path}`) : null;
            } catch {
              next = null;
            }
            const samePlace = next && next.protocol === `${scheme}:` && next.hostname.replace(/^\[|\]$/g, '') === t.host.replace(/^\[|\]$/g, '') && Number(next.port || (scheme === 'https' ? 443 : 80)) === port;
            if (next && samePlace && method === 'GET' && (opts.hops ?? 0) < 3 && next.pathname + next.search !== path)
              return deviceRequest(t, method, next.pathname + next.search, { ...opts, hops: (opts.hops ?? 0) + 1 }).then(resolve, reject);
            const where = next ? `${next.protocol}//${next.host}${next.pathname}` : 'an unknown location';
            const hint =
              next && next.protocol !== `${scheme}:`
                ? `; set this credential's protocol to ${next.protocol.replace(':', '').toUpperCase()}${next.port ? ` and port ${next.port}` : ''}`
                : next && !samePlace
                  ? '; check the address and port of this credential'
                  : '';
            return reject(new DeviceHttpError(`${path.split('?')[0]} redirected (HTTP ${status}) to ${where}${hint}`, status));
          }
          if (status === 401 || status === 403) return reject(new DeviceHttpError(`Authentication failed (HTTP ${status}); check the username, password or token and its permissions`, status));
          if (status === 404) return reject(new DeviceHttpError(`Not found (HTTP 404): ${path.split('?')[0]}`, status));
          if (status >= 400) {
            const why = deviceErrorText(raw);
            return reject(new DeviceHttpError(`HTTP ${status} from ${path.split('?')[0]}${why ? `: ${why}` : ''}`, status));
          }
          if (opts.raw) return resolve({ status, json: null, text: raw });
          try {
            resolve({ status, json: raw ? JSON.parse(raw) : null });
          } catch {
            reject(new DeviceHttpError(`Invalid JSON from ${path.split('?')[0]}`, status));
          }
        };
        res.on('end', onEnd);
        finishEarly = () => {
          if (!res.complete) return false;
          // Flush what the parser already buffered (read() emits it through the 'data' handler above).
          while (res.read() !== null);
          onEnd();
          return true;
        };
        res.on('error', reject);
      },
    );
    // `timeout` above is an idle timeout; this caps the whole request, so a device
    // that drips bytes slowly can't hold the worker past the limit.
    // Say whether the connection itself never opened (firewall, wrong port) or the device was slow to answer.
    let connected = false;
    req.on('socket', (sock) => {
      const mark = () => (connected = true);
      if ((sock as { connecting?: boolean }).connecting === false) mark();
      else sock.once(scheme === 'https' ? 'secureConnect' : 'connect', mark);
    });
    const timedOut = () =>
      Object.assign(
        new DeviceHttpError(
          connected
            ? `Connected to ${t.host}:${t.port ?? opts.defaultPort}, but no answer within ${Math.round(timeout / 1000)} s`
            : `Could not connect to ${t.host}:${t.port ?? opts.defaultPort} within ${Math.round(timeout / 1000)} s: check that the port is open to this server (firewall) and the address is right`,
          null,
        ),
        { timedOut: true, connected },
      );
    const deadline = setTimeout(() => req.destroy(timedOut()), timeout);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(timedOut()));
    req.on('error', (e: NodeJS.ErrnoException) => {
      const reads = method === 'GET' || opts.idempotent === true;
      // A read that timed out is tried once more on a fresh connection: busy
      // BMCs drop a request now and then. When even the TLS handshake did not
      // finish, the retry offers TLS 1.2 at most (older iDRAC/iLO stall on 1.3).
      if (e instanceof DeviceHttpError && (e as DeviceHttpError & { timedOut?: boolean }).timedOut && reads && !opts.retried) {
        const handshakeDone = (e as DeviceHttpError & { connected?: boolean }).connected;
        deviceRequest(t, method, path, { ...opts, retried: true, fresh: true, tls12: opts.tls12 || (!handshakeDone && scheme === 'https') }).then(resolve, (e2: Error) =>
          reject(new DeviceHttpError(`${e2.message} (tried twice)`, (e2 as DeviceHttpError).status ?? null)),
        );
        return;
      }
      if (e instanceof DeviceHttpError) return reject(e);
      // Some BMCs (older iDRAC) send stray bytes after a complete answer marked
      // "Connection: close"; the answer itself is whole, so it is used.
      if (e.code === 'HPE_CLOSED_CONNECTION' && finishEarly?.()) return;
      // A connection reset before any answer is tried once more for reads
      // (embedded web servers reset connections when busy or just restarted).
      // Malformed HTTP from older BMC firmware (bad header characters, stray
      // bytes): a read is tried once more with the lenient parser. Requests
      // go only to the credential's own host on a fresh connection.
      if (reads && !opts.lenient && typeof e.code === 'string' && e.code.startsWith('HPE_')) {
        clearTimeout(deadline);
        deviceRequest(t, method, path, { ...opts, lenient: true, fresh: true }).then(resolve, reject);
        return;
      }
      if (reads && !opts.retried && (e.code === 'ECONNRESET' || e.code === 'EPIPE' || /socket hang up/i.test(e.message))) {
        clearTimeout(deadline);
        setTimeout(() => deviceRequest(t, method, path, { ...opts, retried: true, fresh: true, tls12: opts.tls12 || (!connected && scheme === 'https') }).then(resolve, reject), 300);
        return;
      }
      const tls = /certificate|self[- ]signed|SSL|TLS/i.test(e.message);
      const reset = e.code === 'ECONNRESET' || /socket hang up/i.test(e.message);
      reject(
        new DeviceHttpError(
          tls
            ? `TLS error: ${e.message} (install a trusted certificate or disable verification for this credential)`
            : reset
              ? `${e.code ?? 'ECONNRESET'}: ${t.host}:${t.port ?? opts.defaultPort} closed the connection (twice). The device is reachable but refused this request: check the protocol (HTTP/HTTPS) and port, whether the BMC limits sessions or allowed addresses (IP blocking / access list), or reset the BMC`
              : e.code?.startsWith('HPE_')
                ? `${t.host} answered with malformed HTTP (${e.code}: ${e.message}); this is usually older BMC firmware, and a firmware update fixes it`
                : e.code
                  ? `${e.code}: cannot reach ${t.host}`
                  : e.message,
          null,
        ),
      );
    });
    if (payload) req.write(payload);
    req.end();
  });
}

export function basicAuth(user: string | null | undefined, pass: string | null | undefined) {
  return `Basic ${Buffer.from(`${user ?? ''}:${pass ?? ''}`).toString('base64')}`;
}

/** Accepts "1500", 1500, "auto" → number | null. */
export function int(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v);
  return null;
}

export function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'yes' || v === 'up' || v === 'enabled') return true;
  if (v === 'false' || v === 'no' || v === 'down' || v === 'disabled') return false;
  return null;
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** "1G-baseT-full", "10Gbps", "10 Gb/s", "100M" → bit/s. */
export function speed(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/(\d+(?:\.\d+)?)\s*([KMGT])/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]!.toUpperCase() as 'K' | 'M' | 'G' | 'T'];
  return Math.round(Number(m[1]) * mult);
}

export function normalizeMac(v: unknown): string | null {
  const s = str(v)?.toLowerCase();
  if (!s) return null;
  const hex = s.replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/../g)!.join(':');
}

export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Counter value from an API ("12345", 12345) → bigint; null when absent or not a non-negative integer. */
export function counter(v: unknown): bigint | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? BigInt(Math.trunc(v)) : null;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}
