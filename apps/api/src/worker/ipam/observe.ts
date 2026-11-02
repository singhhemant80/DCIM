import { promises as dnsPromises } from 'node:dns';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import type { CredentialKind } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { deviceCredentials } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { CHECKED_STATES } from '../../dcim/reachability';
import { credentialContext, type Adapter, type AdapterTarget, type NeighborEntry } from '../../network/discovery/types';
import { defaultAdapters, redact } from '../processor';
import { macVendor } from './oui';

export interface ObserveDeps {
  db: Db;
  secrets: SecretBox;
  logger: { warn: (o: object, m: string) => void };
  adapters?: Partial<Record<CredentialKind, Adapter>>;
  /** Reverse DNS; defaults to the system resolver. */
  reverse?: (ip: string) => Promise<string[]>;
}

/** How often routers are read and stale reverse-DNS names refreshed. */
export const OBSERVE_MINUTES = 10;

/**
 * Who is at each address of your prefixes: reads the ARP and IPv6 neighbour
 * tables and DHCP leases of your MikroTik routers in service (print / GET
 * only) and keeps, for addresses inside your IPAM prefixes, the MAC address,
 * its vendor and the DHCP host name; then refreshes reverse-DNS names for
 * recorded and observed addresses (each at most once a day).
 */
export async function observeAddresses(deps: ObserveDeps, ptrLimit = 300): Promise<{ routers: number; entries: number; ptr: number }> {
  const { db } = deps;
  const states = sql.join(
    CHECKED_STATES.map((s) => sql`${s}`),
    sql`, `,
  );
  const routers = await db.execute<{ device_id: string; org_id: string; kind: CredentialKind }>(sql`
    select distinct on (d.id) d.id as device_id, d.org_id, c.kind::text as kind
      from devices d join device_credentials c on c.device_id = d.id and c.kind in ('routeros_rest', 'routeros_api')
     where d.lifecycle_state in (${states})
     order by d.id, case c.kind when 'routeros_rest' then 0 else 1 end
     limit 20`);
  let entries = 0;
  for (const r of routers.rows) {
    let secret: Record<string, unknown> = {};
    try {
      const [cred] = await db
        .select()
        .from(deviceCredentials)
        .where(sql`${deviceCredentials.deviceId} = ${r.device_id} and ${deviceCredentials.kind} = ${r.kind}`);
      if (!cred?.host) continue;
      secret = JSON.parse(deps.secrets.decrypt(cred.secretEnc, credentialContext(cred.orgId, cred.deviceId, cred.kind, cred.host, cred.port))) as Record<string, unknown>;
      const adapter = (deps.adapters ?? defaultAdapters())[r.kind];
      if (!adapter?.neighbors) continue;
      const t: AdapterTarget = { host: cred.host, port: cred.port, username: cred.username, params: cred.params, secret: secret as AdapterTarget['secret'] };
      const got = await adapter.neighbors(t);
      entries += await store(db, r.org_id, r.device_id, got.entries);
    } catch (e) {
      deps.logger.warn({ deviceId: r.device_id, err: redact((e as Error).message || 'failed', secret) }, 'neighbour read failed');
    }
  }
  const ptr = await refreshPtr(deps, ptrLimit);
  return { routers: routers.rows.length, entries, ptr };
}

/** Merges ARP / neighbour / DHCP entries per address and keeps those inside the organization's IPAM prefixes (global table). */
async function store(db: Db, orgId: string, routerId: string, list: NeighborEntry[]) {
  const by = new Map<string, { address: string; mac: string | null; vendor: string | null; host: string | null; iface: string | null }>();
  for (const e of list) {
    if (!isIP(e.address)) continue;
    const cur = by.get(e.address) ?? { address: e.address, mac: null, vendor: null, host: null, iface: null };
    // ARP / neighbour entries show who is there now; a lease may be old.
    if (e.mac && (e.source !== 'dhcp' || !cur.mac)) cur.mac = e.mac;
    if (e.source !== 'dhcp' && e.interface) cur.iface = e.interface;
    if (e.hostName) cur.host = e.hostName.slice(0, 200);
    by.set(e.address, cur);
  }
  const rows = [...by.values()].map((x) => ({ ...x, vendor: macVendor(x.mac) }));
  if (!rows.length) return 0;
  const res = await db.execute(sql`
    insert into ip_observations (org_id, address, mac, vendor, dhcp_host_name, router_device_id, interface_name, seen_at)
    select ${orgId}, x.address::inet, x.mac, x.vendor, x.host, ${routerId}, x.iface, now()
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(address text, mac text, vendor text, host text, iface text)
     where exists (select 1 from prefixes p where p.org_id = ${orgId} and p.vrf_id is null and p.prefix >>= x.address::inet)
    on conflict (org_id, address) do update set
      mac = coalesce(excluded.mac, ip_observations.mac), vendor = coalesce(excluded.vendor, ip_observations.vendor),
      dhcp_host_name = coalesce(excluded.dhcp_host_name, ip_observations.dhcp_host_name),
      router_device_id = excluded.router_device_id, interface_name = coalesce(excluded.interface_name, ip_observations.interface_name), seen_at = now()`);
  return res.rowCount ?? rows.length;
}

/** Reverse DNS for recorded and observed addresses whose name is missing or a day old. */
async function refreshPtr(deps: ObserveDeps, limit: number) {
  const { db } = deps;
  const due = await db.execute<{ org_id: string; ip: string }>(sql`
    select x.org_id, x.ip from (
      select a.org_id, host(a.address) as ip from ip_addresses a where a.status <> 'released' and a.vrf_id is null
      union
      select o.org_id, host(o.address) from ip_observations o) x
    left join ip_observations o on o.org_id = x.org_id and o.address = x.ip::inet
    where o.ptr_at is null or o.ptr_at < now() - interval '1 day'
    order by o.ptr_at nulls first limit ${limit}`);
  const reverse = deps.reverse ?? ((ip: string) => dnsPromises.reverse(ip));
  const queue = [...due.rows];
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, queue.length) }, async () => {
      for (let x = queue.shift(); x; x = queue.shift()) {
        let name: string | null = null;
        try {
          let timer: NodeJS.Timeout | undefined;
          const names = await Promise.race([reverse(x.ip), new Promise<string[]>((_, j) => (timer = setTimeout(() => j(new Error('timeout')), 3000)))]).finally(() => clearTimeout(timer));
          name = names[0]?.replace(/\.$/, '').slice(0, 253) ?? null;
        } catch {
          name = null;
        }
        await db.execute(sql`
          insert into ip_observations (org_id, address, ptr, ptr_at) values (${x.org_id}, ${x.ip}::inet, ${name}, now())
          on conflict (org_id, address) do update set ptr = excluded.ptr, ptr_at = now()`);
        done++;
      }
    }),
  );
  return done;
}
