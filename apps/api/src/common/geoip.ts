import { promises as fs } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { Reader, type AsnResponse, type CityResponse } from 'maxmind';

/**
 * ASN and location of an IP address from offline MaxMind-format databases:
 * DB-IP "IP to City Lite" and "IP to ASN Lite" (CC BY 4.0, downloaded monthly
 * by the worker), or MaxMind GeoLite2 City / ASN files placed in the same
 * directory. Lookups are local: no address leaves the server. Locations are
 * approximate (country is reliable; city often is not).
 */

export interface GeoInfo {
  /** Private, loopback, CGNAT, link-local, multicast or documentation range: no lookup. */
  private?: boolean;
  asn: number | null;
  asName: string | null;
  country: string | null;
  countryName: string | null;
  region: string | null;
  city: string | null;
}

export const GEO_FILES = { city: ['dbip-city-lite.mmdb', 'GeoLite2-City.mmdb'], asn: ['dbip-asn-lite.mmdb', 'GeoLite2-ASN.mmdb'] } as const;

const special = new BlockList();
for (const [a, l] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['0.0.0.0', 8],
  ['224.0.0.0', 3],
  ['192.0.2.0', 24],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
] as const)
  special.addSubnet(a, l, 'ipv4');
for (const [a, l] of [
  ['fc00::', 7],
  ['fe80::', 10],
  ['::1', 128],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  special.addSubnet(a, l, 'ipv6');

export function isSpecialAddress(ip: string) {
  const f = isIP(ip);
  return f === 0 || special.check(ip, f === 4 ? 'ipv4' : 'ipv6');
}

const EMPTY: GeoInfo = { asn: null, asName: null, country: null, countryName: null, region: null, city: null };

export class GeoIp {
  private city: { reader: Reader<CityResponse>; file: string; mtime: number } | null = null;
  private asn: { reader: Reader<AsnResponse>; file: string; mtime: number } | null = null;
  private checkedAt = 0;
  private loading: Promise<void> | null = null;
  private cache = new Map<string, GeoInfo>();

  constructor(private readonly dir: string) {}

  /** Re-reads the files when they changed (checked at most once a minute). */
  private async refresh() {
    if (Date.now() - this.checkedAt < 60_000) return;
    this.checkedAt = Date.now();
    const pick = async (names: readonly string[]) => {
      for (const n of names) {
        const st = await fs.stat(join(this.dir, n)).catch(() => null);
        if (st?.isFile()) return { file: join(this.dir, n), mtime: st.mtimeMs };
      }
      return null;
    };
    const [c, a] = await Promise.all([pick(GEO_FILES.city), pick(GEO_FILES.asn)]);
    if (c && (c.file !== this.city?.file || c.mtime !== this.city.mtime)) {
      try {
        this.city = { reader: new Reader<CityResponse>(await fs.readFile(c.file)), ...c };
        this.cache.clear();
      } catch {
        /* a damaged file is ignored; the previous one stays in use */
      }
    }
    if (a && (a.file !== this.asn?.file || a.mtime !== this.asn.mtime)) {
      try {
        this.asn = { reader: new Reader<AsnResponse>(await fs.readFile(a.file)), ...a };
        this.cache.clear();
      } catch {
        /* as above */
      }
    }
  }

  private async ready() {
    if (!this.loading) this.loading = this.refresh().finally(() => (this.loading = null));
    await this.loading;
  }

  async status() {
    await this.ready();
    const info = async (x: { file: string } | null) => (x ? { file: x.file.split('/').pop()!, updatedAt: new Date((await fs.stat(x.file)).mtimeMs).toISOString() } : null);
    return { city: await info(this.city), asn: await info(this.asn) };
  }

  async lookup(ip: string): Promise<GeoInfo> {
    if (isSpecialAddress(ip)) return { ...EMPTY, private: true };
    await this.ready();
    const hit = this.cache.get(ip);
    if (hit) return hit;
    let out: GeoInfo = { ...EMPTY };
    try {
      const c = this.city?.reader.get(ip);
      if (c) {
        out = {
          ...out,
          country: c.country?.iso_code ?? c.registered_country?.iso_code ?? null,
          countryName: c.country?.names?.en ?? c.registered_country?.names?.en ?? null,
          region: c.subdivisions?.[0]?.names?.en ?? null,
          city: c.city?.names?.en ?? null,
        };
      }
      const a = this.asn?.reader.get(ip);
      if (a) out = { ...out, asn: a.autonomous_system_number ?? null, asName: a.autonomous_system_organization ?? null };
    } catch {
      /* not found / malformed: unknown */
    }
    if (this.cache.size > 50_000) this.cache.clear();
    this.cache.set(ip, out);
    return out;
  }

  async lookupMany(ips: string[]): Promise<Map<string, GeoInfo>> {
    const m = new Map<string, GeoInfo>();
    for (const ip of new Set(ips)) m.set(ip, await this.lookup(ip));
    return m;
  }
}
