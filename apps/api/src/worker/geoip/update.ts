import { createWriteStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Reader } from 'maxmind';
import type Redis from 'ioredis';
import type { Logger } from 'pino';

/**
 * Keeps the DB-IP Lite databases (IP to City Lite, IP to ASN Lite; CC BY 4.0)
 * current: downloads this month's (or last month's) release when a file is
 * missing or older than 35 days, checks that it opens as a MaxMind-format
 * database, then swaps it in. The API re-reads it within a minute. Lookups
 * themselves are local; only the monthly download leaves the server.
 */
export const GEOIP_STATUS_KEY = 'cdcim:geoip:status';
const KINDS = [
  { kind: 'city', file: 'dbip-city-lite.mmdb' },
  { kind: 'asn', file: 'dbip-asn-lite.mmdb' },
] as const;
const MAX_BYTES = 600 * 1024 ** 2;

const month = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

async function fetchDb(url: string, dest: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  let n = 0;
  const cap = new Transform({
    transform(c: Buffer, _e, cb) {
      n += c.length;
      cb(n > MAX_BYTES ? new Error('larger than expected') : null, c);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createGunzip(), cap, createWriteStream(dest));
  // Must open and answer a lookup before it replaces the current file.
  new Reader(await fs.readFile(dest)).get('8.8.8.8');
}

export async function updateGeoIp(deps: { dir: string; logger: Pick<Logger, 'info' | 'warn'>; redis?: Pick<Redis, 'set'>; fetchImpl?: typeof fetch; now?: Date; force?: boolean }) {
  const now = deps.now ?? new Date();
  await fs.mkdir(deps.dir, { recursive: true });
  const result: Record<string, { ok: boolean; release?: string; error?: string; at: string }> = {};
  for (const k of KINDS) {
    const target = join(deps.dir, k.file);
    const st = await fs.stat(target).catch(() => null);
    if (!deps.force && st && now.getTime() - st.mtimeMs < 35 * 86_400_000) continue;
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const errors: string[] = [];
    for (const release of [month(now), month(prev)]) {
      const url = `https://download.db-ip.com/free/dbip-${k.kind}-lite-${release}.mmdb.gz`;
      const tmp = `${target}.download`;
      try {
        await fetchDb(url, tmp, deps.fetchImpl ?? fetch);
        await fs.rename(tmp, target);
        result[k.kind] = { ok: true, release, at: now.toISOString() };
        deps.logger.info({ kind: k.kind, release }, 'geoip: database updated');
        break;
      } catch (e) {
        await fs.rm(tmp, { force: true });
        errors.push(`${release}: ${(e as Error).message}`);
      }
    }
    if (!result[k.kind]) {
      result[k.kind] = { ok: false, error: `Could not download the DB-IP ${k.kind} database (${errors.join('; ')}); the server needs HTTPS access to download.db-ip.com`, at: now.toISOString() };
      deps.logger.warn({ kind: k.kind, errors }, 'geoip: download failed');
    }
  }
  if (Object.keys(result).length && deps.redis) await deps.redis.set(GEOIP_STATUS_KEY, JSON.stringify(result), 'EX', 40 * 86_400);
  return result;
}
