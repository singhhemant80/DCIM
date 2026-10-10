import http from 'node:http';
import https from 'node:https';
import type { AdapterTarget } from '../../network/discovery/types';

export class DeviceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
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
  opts: { headers?: Record<string, string>; body?: unknown; defaultPort: number; /** Resolve error statuses (with the parsed body) instead of rejecting. */ rawErrors?: boolean },
): Promise<{ status: number; json: unknown }> {
  const scheme = t.params.scheme ?? 'https';
  const lib = scheme === 'https' ? https : http;
  const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
  const timeout = t.params.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: t.host.replace(/^\[|\]$/g, ''),
        port: t.port ?? opts.defaultPort,
        method,
        path,
        headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}), ...opts.headers },
        timeout,
        ...(scheme === 'https' ? { rejectUnauthorized: t.params.verifyTls !== false, servername: /^[\d.:[\]]+$/.test(t.host) ? undefined : t.host } : {}),
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
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const raw = Buffer.concat(chunks).toString('utf8');
          if (opts.rawErrors) {
            let json: unknown = null;
            try {
              json = raw ? JSON.parse(raw) : null;
            } catch {
              json = null;
            }
            return resolve({ status, json });
          }
          if (status === 401 || status === 403) return reject(new DeviceHttpError(`Authentication failed (HTTP ${status}); check the username, password or token and its permissions`, status));
          if (status === 404) return reject(new DeviceHttpError(`Not found (HTTP 404): ${path.split('?')[0]}`, status));
          if (status >= 400) return reject(new DeviceHttpError(`HTTP ${status} from ${path.split('?')[0]}`, status));
          try {
            resolve({ status, json: raw ? JSON.parse(raw) : null });
          } catch {
            reject(new DeviceHttpError(`Invalid JSON from ${path.split('?')[0]}`, status));
          }
        });
        res.on('error', reject);
      },
    );
    // `timeout` above is an idle timeout; this caps the whole request, so a device
    // that drips bytes slowly can't hold the worker past the limit.
    const deadline = setTimeout(() => req.destroy(new DeviceHttpError(`Timed out after ${timeout} ms`, null)), timeout);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new DeviceHttpError(`Timed out after ${timeout} ms`, null)));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e instanceof DeviceHttpError) return reject(e);
      const tls = /certificate|self[- ]signed|SSL|TLS/i.test(e.message);
      reject(new DeviceHttpError(tls ? `TLS error: ${e.message} (install a trusted certificate or disable verification for this credential)` : e.code ? `${e.code}: cannot reach ${t.host}` : e.message, null));
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
