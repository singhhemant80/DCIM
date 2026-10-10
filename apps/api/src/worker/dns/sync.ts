import { eq, sql } from 'drizzle-orm';
import { formatIp, parseIp, ptrName } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { dnsServers, dnsZones, type DnsServer, type DnsZone, type ManagedDnsRecord } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { dnsServerContext, zoneFor } from '../../network/dns/context';
import { cloudflare, powerDns, type DnsProvider, type WantedRecord } from './providers';
import { redact } from '../processor';

export interface DnsDeps {
  db: Db;
  secrets: SecretBox;
  /** Overridable for tests. */
  cloudflareBase?: string;
  timeoutMs?: number;
}

function provider(deps: DnsDeps, s: DnsServer): { p: DnsProvider; secret: string } {
  const raw = deps.secrets.decrypt(s.secretEnc, dnsServerContext(s.orgId, s.id, s.kind, s.url));
  return { p: s.kind === 'powerdns' ? powerDns(s, raw, deps.timeoutMs) : cloudflare(s.orgId, raw, deps.cloudflareBase, deps.timeoutMs), secret: raw };
}

const key = (r: { zoneId: string; name: string; type: string; content: string }) => `${r.zoneId}|${r.name}|${r.type}|${r.content}`;

/**
 * Records an address should have. The most specific zone for a name decides,
 * enabled or not: a disabled child zone means "don't publish these names",
 * never "publish them in the parent zone instead". Only the global table is
 * published, and only allocated or deprecated addresses.
 */
export function desiredRecords(a: { address: string; status: string; vrfId: string | null; dnsName: string | null; reverseDns: string | null }, zones: DnsZone[]): (WantedRecord & { zoneId: string })[] {
  if (a.vrfId || (a.status !== 'allocated' && a.status !== 'deprecated')) return [];
  const ip = parseIp(a.address.split('/')[0]!);
  if (!ip) return [];
  const out: (WantedRecord & { zoneId: string })[] = [];
  const name = a.dnsName?.toLowerCase().replace(/\.$/, '') ?? null;
  if (name) {
    const z = zoneFor(zones.filter((x) => x.kind === 'forward'), name);
    if (z?.enabled) out.push({ zoneId: z.id, name, type: ip.family === 4 ? 'A' : 'AAAA', content: formatIp(ip.family, ip.value) });
  }
  const ptrTarget = (a.reverseDns ?? a.dnsName)?.toLowerCase().replace(/\.$/, '') ?? null;
  if (ptrTarget) {
    const ptr = ptrName(ip);
    const z = zoneFor(zones.filter((x) => x.kind === 'reverse'), ptr);
    if (z?.enabled) out.push({ zoneId: z.id, name: ptr, type: 'PTR', content: ptrTarget });
  }
  return out;
}

/** A sync claimed this long ago without finishing (worker crashed) is picked up again. */
const STALE_SYNC = "interval '5 minutes'";

/**
 * Brings one address's DNS records in line with IPAM.
 *
 * 1. Claim the row (pending → syncing) in a short transaction, so a second
 *    sweeper skips it and user edits are never blocked by DNS calls.
 * 2. In a second transaction, take advisory locks on every (zone, name, type)
 *    involved, in sorted order. Two addresses sharing a name (round robin)
 *    therefore never read-modify-write the same record set concurrently.
 * 3. Remove records DCIM created that are no longer wanted, add wanted ones.
 * 4. Store what is now published. If the address was edited meanwhile, the
 *    edit's trigger already set it back to pending and that status is kept,
 *    so the next sweep re-syncs it.
 */
export async function syncAddress(deps: DnsDeps, ipId: string): Promise<'synced' | 'failed' | 'none' | 'skipped'> {
  const claimed = await deps.db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      select *, host(address) as ip from ip_addresses
      where id = ${ipId} and (dns_status = 'pending' or (dns_status = 'syncing' and updated_at < now() - ${sql.raw(STALE_SYNC)}))
      for update skip locked`);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    await tx.execute(sql`update ip_addresses set dns_status = 'syncing' where id = ${ipId}`);
    return row;
  });
  if (!claimed) return 'skipped';
  const row = claimed;
  const orgId = row.org_id as string;
  return deps.db.transaction(async (tx) => {
    const zones = await tx.select().from(dnsZones).where(eq(dnsZones.orgId, orgId));
    const servers = new Map((await tx.select().from(dnsServers).where(eq(dnsServers.orgId, orgId))).map((s) => [s.id, s]));
    const zoneById = new Map(zones.map((z) => [z.id, z]));
    const current = (row.dns_records as ManagedDnsRecord[]) ?? [];
    const wanted = desiredRecords({ address: row.ip as string, status: row.status as string, vrfId: row.vrf_id as string | null, dnsName: row.dns_name as string | null, reverseDns: row.reverse_dns as string | null }, zones);
    const lockKeys = [...new Set([...current, ...wanted].map((r) => `dns:${r.zoneId}|${r.name}|${r.type}`))].sort();
    for (const k of lockKeys) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${k}, 0))`);
    const wantedKeys = new Set(wanted.map(key));
    const applied = [...current];
    const providers = new Map<string, { p: DnsProvider; secret: string }>();
    const get = (z: DnsZone) => {
      if (!providers.has(z.serverId)) providers.set(z.serverId, provider(deps, servers.get(z.serverId)!));
      return providers.get(z.serverId)!;
    };
    const errors: string[] = [];
    const notes: string[] = [];
    const secrets: Record<string, string> = {};
    for (const r of current.filter((c) => !wantedKeys.has(key(c)))) {
      const z = zoneById.get(r.zoneId);
      if (!z) {
        applied.splice(applied.indexOf(r), 1); // zone deleted from DCIM: forget the record
        continue;
      }
      if (!z.enabled) {
        notes.push(`${r.type} ${r.name} is in disabled zone ${z.name} and was left unchanged`);
        continue;
      }
      try {
        const pr = get(z);
        secrets[z.serverId] = pr.secret;
        await pr.p.remove(z, r);
        applied.splice(applied.indexOf(r), 1);
      } catch (e) {
        errors.push(`remove ${r.type} ${r.name}: ${(e as Error).message}`);
      }
    }
    const currentKeys = new Set(applied.map(key));
    for (const w of wanted) {
      const z = zoneById.get(w.zoneId)!;
      try {
        const pr = get(z);
        secrets[z.serverId] = pr.secret;
        const { providerId } = await pr.p.add(z, w);
        if (!currentKeys.has(key(w))) applied.push({ zoneId: w.zoneId, name: w.name, type: w.type, content: w.content, providerId: providerId ?? null });
      } catch (e) {
        errors.push(`${w.type} ${w.name}: ${(e as Error).message}`);
      }
    }
    // Not in sync if anything failed, or if stale records had to be left in a disabled zone.
    const status = errors.length || notes.length ? 'failed' : applied.length || wanted.length ? 'synced' : 'none';
    const message = errors.length || notes.length ? redact([...errors, ...notes].join('; '), secrets) : null;
    await tx.execute(sql`
      update ip_addresses set
        dns_records = ${JSON.stringify(applied)}::jsonb,
        dns_status = case when dns_status = 'syncing' then ${status}::dns_sync_status
                          when dns_status = 'none' and ${applied.length} > 0 then 'pending'::dns_sync_status
                          else dns_status end,
        dns_error = case when dns_status = 'syncing' then ${message} else dns_error end,
        dns_synced_at = case when ${status} = 'synced' then now() else dns_synced_at end
      where id = ${ipId}`);
    return status;
  });
}

/** Processes pending addresses (and syncs a crashed worker left half-done); returns how many were handled. */
export async function sweepDns(deps: DnsDeps, limit = 100): Promise<number> {
  const res = await deps.db.execute(sql`
    select id from ip_addresses
    where dns_status = 'pending' or (dns_status = 'syncing' and updated_at < now() - ${sql.raw(STALE_SYNC)})
    order by updated_at limit ${limit}`);
  let n = 0;
  for (const r of res.rows as { id: string }[]) {
    if ((await syncAddress(deps, r.id)) !== 'skipped') n++;
  }
  return n;
}

/** Checks a DNS server's credentials and that each of its zones exists there. */
export async function testDnsServer(deps: DnsDeps, serverId: string): Promise<{ ok: boolean; message: string }> {
  const [s] = await deps.db.select().from(dnsServers).where(eq(dnsServers.id, serverId));
  if (!s) return { ok: false, message: 'Server not found' };
  let result: { ok: boolean; message: string };
  let secret = '';
  try {
    const pr = provider(deps, s);
    secret = pr.secret;
    const msg = await pr.p.test();
    const zones = await deps.db.select().from(dnsZones).where(eq(dnsZones.serverId, s.id));
    const problems: string[] = [];
    for (const z of zones) {
      try {
        await pr.p.checkZone(z);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    result = problems.length ? { ok: false, message: `${msg}; ${problems.join('; ')}` } : { ok: true, message: `${msg}${zones.length ? `; ${zones.length} zone(s) found` : ''}` };
  } catch (e) {
    result = { ok: false, message: (e as Error).message.includes('decrypt') || (e as Error).message.includes('Unsupported state') ? 'The stored key could not be decrypted; enter it again' : (e as Error).message };
  }
  result.message = redact(result.message, { secret });
  await deps.db.update(dnsServers).set({ lastTestAt: new Date(), lastTestOk: result.ok, lastTestMessage: result.message }).where(eq(dnsServers.id, s.id));
  return result;
}
