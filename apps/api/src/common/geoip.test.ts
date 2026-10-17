import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GeoIp, isSpecialAddress } from './geoip';
import { updateGeoIp } from '../worker/geoip/update';
import { PeerCounter } from '../worker/flows/collector';

const FIX = join(__dirname, '../../test/fixtures/geoip');
const quiet = { info: () => undefined, warn: () => undefined };

describe('GeoIp (local MaxMind-format databases)', () => {
  it('ASN and location from the files; private ranges are not looked up; no files means unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-'));
    const empty = new GeoIp(dir);
    expect(await empty.status()).toEqual({ city: null, asn: null });
    expect(await empty.lookup('81.2.69.142')).toMatchObject({ asn: null, country: null });

    copyFileSync(join(FIX, 'GeoIP2-City-Test.mmdb'), join(dir, 'GeoLite2-City.mmdb'));
    copyFileSync(join(FIX, 'GeoLite2-ASN-Test.mmdb'), join(dir, 'GeoLite2-ASN.mmdb'));
    const g = new GeoIp(dir);
    expect(await g.lookup('81.2.69.142')).toMatchObject({ country: 'GB', countryName: 'United Kingdom', city: 'London' });
    expect(await g.lookup('1.128.0.1')).toMatchObject({ asn: 1221, asName: 'Telstra Pty Ltd' });
    expect(await g.lookup('10.1.2.3')).toMatchObject({ private: true, asn: null });
    expect(await g.lookup('not-an-ip')).toMatchObject({ private: true });
    expect((await g.status()).city?.file).toBe('GeoLite2-City.mmdb');
    const m = await g.lookupMany(['81.2.69.142', '81.2.69.142', '1.128.0.1']);
    expect(m.size).toBe(2);
  });

  it('special ranges', () => {
    for (const a of ['192.168.1.1', '100.64.0.1', '127.0.0.1', 'fe80::1', 'fd00::1', '2001:db8::1', '239.1.1.1']) expect(isSpecialAddress(a)).toBe(true);
    for (const a of ['8.8.8.8', '2606:4700::1', '163.52.252.251']) expect(isSpecialAddress(a)).toBe(false);
  });
});

describe('updateGeoIp (DB-IP Lite monthly download)', () => {
  const body = (file: string) => new Response(gzipSync(readFileSync(join(FIX, file))));

  it("downloads this month's release, falls back to last month's, and keeps a recent file", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-'));
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      if (u.includes('2026-10')) return new Response('missing', { status: 404 });
      return body(u.includes('asn') ? 'GeoLite2-ASN-Test.mmdb' : 'GeoIP2-City-Test.mmdb');
    }) as unknown as typeof fetch;
    const sets: string[] = [];
    const r = await updateGeoIp({ dir, logger: quiet, fetchImpl, now: new Date('2026-10-17T00:00:00Z'), redis: { set: (async (_k: string, v: string) => (sets.push(v), 'OK')) as never } });
    expect(r).toMatchObject({ city: { ok: true, release: '2026-09' }, asn: { ok: true, release: '2026-09' } });
    expect(urls).toEqual([
      'https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz',
      'https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz',
      'https://download.db-ip.com/free/dbip-asn-lite-2026-10.mmdb.gz',
      'https://download.db-ip.com/free/dbip-asn-lite-2026-09.mmdb.gz',
    ]);
    expect(sets).toHaveLength(1);
    expect(await new GeoIp(dir).lookup('1.128.0.1')).toMatchObject({ asn: 1221 });
    // Fresh files: nothing to do.
    urls.length = 0;
    expect(await updateGeoIp({ dir, logger: quiet, fetchImpl, now: new Date('2026-10-17T00:00:00Z') })).toEqual({});
    expect(urls).toEqual([]);
  });

  it('a broken download never replaces the file and is reported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-'));
    const fetchImpl = (async () => new Response(gzipSync(Buffer.from('not a database')))) as unknown as typeof fetch;
    const r = await updateGeoIp({ dir, logger: quiet, fetchImpl, now: new Date('2026-10-17T00:00:00Z') });
    expect(r.city).toMatchObject({ ok: false });
    expect(r.city!.error).toContain('download.db-ip.com');
    expect(existsSync(join(dir, 'dbip-city-lite.mmdb'))).toBe(false);
    expect(existsSync(join(dir, 'dbip-city-lite.mmdb.download'))).toBe(false);
  });
});

describe('PeerCounter (busiest remote addresses per address)', () => {
  it('counts per direction and keeps the heavy hitters when full', () => {
    const c = new PeerCounter(3, 100);
    c.add('a', 'p1', 0, 100);
    c.add('a', 'p1', 1, 50);
    c.add('a', 'p2', 0, 10);
    c.add('a', 'p3', 0, 5);
    // Full: the smallest (p3, 5) is replaced; the newcomer inherits its count.
    c.add('a', 'p4', 0, 1000);
    expect(c.top('a', 2)).toEqual([
      ['p4', [1005, 0]],
      ['p1', [100, 50]],
    ]);
    expect(c.top('a', 10).map((x) => x[0])).not.toContain('p3');
    expect(c.top('nobody', 5)).toEqual([]);
  });

  it('a total cap bounds memory', () => {
    const c = new PeerCounter(100, 2);
    c.add('a', 'p1', 0, 1);
    c.add('b', 'p1', 0, 1);
    c.add('c', 'p1', 0, 1);
    expect(c.entries).toBe(2);
    expect(c.top('c', 5)).toEqual([]);
  });
});
