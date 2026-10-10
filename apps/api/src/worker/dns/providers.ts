import type { DnsServer, DnsZone } from '../../db/schema';
import type { AdapterTarget } from '../../network/discovery/types';
import { deviceRequest } from '../adapters/http';

/**
 * DNS provider clients. They change only records DCIM manages: a record set
 * is "ours" when it carries the DCIM marker (PowerDNS comment account,
 * Cloudflare record comment). Anything else at the same name and type is a
 * conflict and is left untouched.
 */
/** Marks a record as created by this DCIM organization (two organizations sharing a zone never touch each other's records). */
// Kept as "Crapplet DCIM" after the rename to NexoraDC: it identifies the DNS records this system already created.
export const markerFor = (orgId: string) => `Managed by Crapplet DCIM (${orgId})`;
const accountFor = (orgId: string) => `crapplet-dcim:${orgId}`;
export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

export class DnsError extends Error {}

export interface WantedRecord {
  name: string; // fqdn, no trailing dot, lower case
  type: 'A' | 'AAAA' | 'PTR';
  content: string; // address, or PTR target without trailing dot
}

export interface DnsProvider {
  test(): Promise<string>;
  checkZone(zone: DnsZone): Promise<void>;
  add(zone: DnsZone, rec: WantedRecord): Promise<{ providerId?: string | null }>;
  remove(zone: DnsZone, rec: WantedRecord & { providerId?: string | null }): Promise<void>;
}

function target(baseUrl: string, verifyTls: boolean, timeoutMs: number): { t: AdapterTarget; prefix: string } {
  const u = new URL(baseUrl);
  return {
    t: { host: u.hostname, port: u.port ? Number(u.port) : null, params: { scheme: u.protocol === 'http:' ? 'http' : 'https', verifyTls, timeoutMs }, secret: {} },
    prefix: u.pathname.replace(/\/$/, ''),
  };
}

const errText = (json: unknown, status: number) => {
  const j = json as { error?: string; errors?: { message?: string }[] } | null;
  return j?.error ?? j?.errors?.[0]?.message ?? `HTTP ${status}`;
};

export function powerDns(server: DnsServer, apiKey: string, timeoutMs = 5000): DnsProvider {
  const MARKER = markerFor(server.orgId);
  const PDNS_ACCOUNT = accountFor(server.orgId);
  const { t, prefix } = target(server.url ?? '', server.verifyTls, timeoutMs);
  const sid = encodeURIComponent(server.serverId ?? 'localhost');
  const call = async (method: 'GET' | 'PATCH', path: string, body?: unknown) => {
    const r = await deviceRequest(t, method, `${prefix}/api/v1/servers/${sid}${path}`, { headers: { 'X-API-Key': apiKey }, body, defaultPort: t.params.scheme === 'http' ? 80 : 443, rawErrors: true });
    if (r.status === 401 || r.status === 403) throw new DnsError('PowerDNS rejected the API key');
    return r;
  };
  const zonePath = (z: DnsZone) => `/zones/${encodeURIComponent(`${z.name}.`)}`;
  const rrset = async (z: DnsZone, name: string, type: string) => {
    const r = await call('GET', `${zonePath(z)}?rrsets=true&rrset_name=${encodeURIComponent(`${name}.`)}&rrset_type=${type}`);
    if (r.status === 404) throw new DnsError(`Zone ${z.name} not found on the PowerDNS server`);
    if (r.status >= 400) throw new DnsError(`PowerDNS: ${errText(r.json, r.status)}`);
    const sets = ((r.json as { rrsets?: unknown[] })?.rrsets ?? []) as { name: string; type: string; records?: { content: string }[]; comments?: { account?: string }[] }[];
    return sets.find((x) => x.name.toLowerCase() === `${name}.` && x.type === type) ?? null;
  };
  const contentOf = (rec: WantedRecord) => (rec.type === 'PTR' ? `${rec.content}.` : rec.content);
  const write = async (z: DnsZone, name: string, type: string, contents: string[]) => {
    const r = await call('PATCH', zonePath(z), {
      rrsets: [
        contents.length
          ? { name: `${name}.`, type, ttl: z.ttl, changetype: 'REPLACE', records: contents.map((content) => ({ content, disabled: false })), comments: [{ content: MARKER, account: PDNS_ACCOUNT }] }
          : { name: `${name}.`, type, changetype: 'DELETE' },
      ],
    });
    if (r.status >= 400) throw new DnsError(`PowerDNS: ${errText(r.json, r.status)}`);
  };
  const managed = (s: { comments?: { account?: string }[] }) => (s.comments ?? []).some((c) => c.account === PDNS_ACCOUNT);
  return {
    async test() {
      const r = await call('GET', '');
      if (r.status >= 400) throw new DnsError(`PowerDNS: ${errText(r.json, r.status)}`);
      const j = r.json as { daemon_type?: string; version?: string };
      return `Connected: PowerDNS ${j.daemon_type ?? ''} ${j.version ?? ''}`.replace(/\s+/g, ' ').trim();
    },
    async checkZone(z) {
      const r = await call('GET', `${zonePath(z)}?rrsets=false`);
      if (r.status >= 400) throw new DnsError(r.status === 404 || r.status === 422 ? `Zone ${z.name} not found on the PowerDNS server` : `PowerDNS: ${errText(r.json, r.status)}`);
    },
    async add(z, rec) {
      const cur = await rrset(z, rec.name, rec.type);
      if (cur && !managed(cur)) throw new DnsError(`${rec.type} ${rec.name} already exists and is not managed by DCIM; left unchanged`);
      const contents = (cur?.records ?? []).map((r) => r.content);
      if (rec.type === 'PTR' && contents.length && !contents.includes(contentOf(rec))) throw new DnsError(`PTR ${rec.name} already points to ${contents[0]}`);
      if (!contents.includes(contentOf(rec))) await write(z, rec.name, rec.type, [...contents, contentOf(rec)]);
      return {};
    },
    async remove(z, rec) {
      const cur = await rrset(z, rec.name, rec.type);
      if (!cur || !managed(cur)) return; // gone, or taken over by someone else: not ours to delete
      const contents = (cur.records ?? []).map((r) => r.content).filter((c) => c !== contentOf(rec));
      await write(z, rec.name, rec.type, contents);
    },
  };
}

export function cloudflare(orgId: string, apiToken: string, baseUrl = CLOUDFLARE_API, timeoutMs = 5000): DnsProvider {
  const MARKER = markerFor(orgId);
  const { t, prefix } = target(baseUrl, true, timeoutMs);
  const call = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => {
    const r = await deviceRequest(t, method, `${prefix}${path}`, { headers: { Authorization: `Bearer ${apiToken}` }, body, defaultPort: t.params.scheme === 'http' ? 80 : 443, rawErrors: true });
    if (r.status === 401 || r.status === 403) throw new DnsError(`Cloudflare rejected the token (${errText(r.json, r.status)})`);
    return r;
  };
  const zid = (z: DnsZone) => {
    if (!z.providerZoneId) throw new DnsError(`Zone ${z.name} has no Cloudflare zone ID`);
    return encodeURIComponent(z.providerZoneId);
  };
  type CfRecord = { id: string; content: string; comment?: string | null };
  const list = async (z: DnsZone, rec: WantedRecord) => {
    const r = await call('GET', `/zones/${zid(z)}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}&per_page=100`);
    if (r.status >= 400 || !(r.json as { success?: boolean })?.success) throw new DnsError(`Cloudflare: ${errText(r.json, r.status)}`);
    return ((r.json as { result?: CfRecord[] }).result ?? []) as CfRecord[];
  };
  const norm = (c: string) => c.replace(/\.$/, '').toLowerCase();
  return {
    async test() {
      const r = await call('GET', '/user/tokens/verify');
      const j = r.json as { success?: boolean; result?: { status?: string } };
      if (r.status >= 400 || !j?.success) throw new DnsError(`Cloudflare: ${errText(r.json, r.status)}`);
      return `Connected: Cloudflare token ${j.result?.status ?? 'valid'}`;
    },
    async checkZone(z) {
      const r = await call('GET', `/zones/${zid(z)}`);
      const j = r.json as { success?: boolean; result?: { name?: string } };
      if (r.status >= 400 || !j?.success) throw new DnsError(`Cloudflare zone ${z.name}: ${errText(r.json, r.status)}`);
      if (j.result?.name && j.result.name.toLowerCase() !== z.name) throw new DnsError(`Cloudflare zone ID belongs to ${j.result.name}, not ${z.name}`);
    },
    async add(z, rec) {
      const cur = await list(z, rec);
      const foreign = cur.filter((r) => r.comment !== MARKER);
      if (foreign.length) throw new DnsError(`${rec.type} ${rec.name} already exists and is not managed by DCIM; left unchanged`);
      const same = cur.find((r) => norm(r.content) === norm(rec.content));
      if (same) return { providerId: same.id };
      if (rec.type === 'PTR' && cur.length) throw new DnsError(`PTR ${rec.name} already points to ${cur[0]!.content}`);
      const r = await call('POST', `/zones/${zid(z)}/dns_records`, { type: rec.type, name: rec.name, content: rec.content, ttl: z.ttl, proxied: false, comment: MARKER });
      const j = r.json as { success?: boolean; result?: { id?: string } };
      if (r.status >= 400 || !j?.success) throw new DnsError(`Cloudflare: ${errText(r.json, r.status)}`);
      return { providerId: j.result?.id ?? null };
    },
    async remove(z, rec) {
      const cur = await list(z, rec);
      for (const r of cur.filter((x) => x.comment === MARKER && norm(x.content) === norm(rec.content))) {
        const d = await call('DELETE', `/zones/${zid(z)}/dns_records/${encodeURIComponent(r.id)}`);
        if (d.status >= 400 && d.status !== 404) throw new DnsError(`Cloudflare: ${errText(d.json, d.status)}`);
      }
    },
  };
}
