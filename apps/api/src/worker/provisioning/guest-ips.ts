import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/db';
import { parseIp, formatIp } from '@crapplet/shared';

const ZERO = '00000000-0000-0000-0000-000000000000';

export interface SyncedGuest {
  id: string;
  name: string;
  externalId: string;
  customerId: string | null;
  ipAddresses: string[];
}

/** "203.0.113.5/24" or "203.0.113.5" → canonical host address; link-local and malformed values are skipped. */
export function guestIp(raw: string): string | null {
  const p = parseIp(String(raw).split('/')[0]!.trim());
  if (!p) return null;
  const s = formatIp(p.family, p.value);
  if (p.family === 6 && /^fe[89ab]/i.test(s)) return null;
  if (p.family === 4 && s.startsWith('169.254.')) return null;
  return s;
}

/**
 * Records the addresses a hypervisor reports for its VMs in IPAM, inside
 * prefixes that already exist (prefixes are never created from a sync).
 *
 * - A new address is recorded as allocated, linked to the VM, with the VM's
 *   customer, or none (the organization's own) when the VM has no customer.
 * - An address recorded by a person is never changed.
 * - An address recorded by an earlier sync follows its VM; its customer is
 *   filled in only while it has none (a person's choice is kept).
 * - When the VM no longer reports an address, the sync-recorded row is released.
 */
export async function recordGuestAddresses(tx: DbOrTx, orgId: string, integrationName: string, kind: string, guests: SyncedGuest[]): Promise<{ recorded: number; released: number }> {
  let recorded = 0;
  let released = 0;
  for (const g of guests) {
    const ips = [...new Set(g.ipAddresses.map(guestIp).filter((x): x is string => !!x))];
    for (const ip of ips) {
      const pre = (
        await tx.execute<{ id: string; vrf_id: string | null; customer_id: string | null }>(sql`
          select id, vrf_id, customer_id from prefixes
           where org_id = ${orgId} and ${ip}::inet <<= prefix and status <> 'deprecated'
           order by (vrf_id is null) desc, masklen(prefix) desc limit 1`)
      ).rows[0];
      if (!pre) continue;
      // A customer subnet keeps its customer; a VM of another customer in it is recorded without one (to review).
      const customer = pre.customer_id ? (g.customerId === null || g.customerId === pre.customer_id ? pre.customer_id : null) : g.customerId;
      const cur = (
        await tx.execute<{ id: string; source: string; status: string; customer_id: string | null; guest_id: string | null }>(sql`
          select id, source, status::text as status, customer_id, guest_id from ip_addresses
           where org_id = ${orgId} and coalesce(vrf_id, ${ZERO}::uuid) = coalesce(${pre.vrf_id}::uuid, ${ZERO}::uuid) and address = ${ip}::inet`)
      ).rows[0];
      const ref = `${kind}:${g.externalId}`;
      if (!cur) {
        const ins = await tx.execute<{ id: string }>(sql`
          insert into ip_addresses (org_id, vrf_id, address, status, customer_id, guest_id, service_ref, source, notes)
          values (${orgId}, ${pre.vrf_id}, ${ip}::inet, 'allocated', ${customer}, ${g.id}, ${ref}, 'hypervisor', ${`Recorded from the ${integrationName} sync (VM ${g.name})`})
          on conflict do nothing returning id`);
        const id = ins.rows[0]?.id;
        if (id) {
          recorded++;
          await tx.execute(sql`insert into ip_events (org_id, ip_id, actor_label, action, summary, data)
            values (${orgId}, ${id}, ${`${integrationName} sync`}, 'record', ${`Recorded for VM ${g.name} from ${integrationName}`}, ${JSON.stringify({ guestId: g.id, ref })}::jsonb)`);
        }
        continue;
      }
      if (cur.source !== 'hypervisor') continue;
      if (cur.status === 'released') {
        await tx.execute(sql`update ip_addresses set status = 'allocated', guest_id = ${g.id}, service_ref = ${ref}, customer_id = ${customer}, updated_at = now() where id = ${cur.id}`);
        await tx.execute(sql`insert into ip_events (org_id, ip_id, actor_label, action, summary, data)
          values (${orgId}, ${cur.id}, ${`${integrationName} sync`}, 'record', ${`Recorded again for VM ${g.name} from ${integrationName}`}, ${JSON.stringify({ guestId: g.id, ref })}::jsonb)`);
        recorded++;
        continue;
      }
      if (cur.guest_id !== g.id || (cur.customer_id === null && customer !== null)) {
        await tx.execute(sql`update ip_addresses set guest_id = ${g.id}, service_ref = ${ref}, customer_id = coalesce(customer_id, ${customer}), updated_at = now() where id = ${cur.id}`);
      }
    }
    // Addresses this VM no longer reports (recorded by a sync only).
    const keep = ips.length ? sql`and host(address) not in (${sql.join(ips.map((x) => sql`${x}`), sql`, `)})` : sql``;
    const gone = await tx.execute<{ id: string; ip: string }>(sql`
      update ip_addresses set status = 'released', customer_id = null, guest_id = null, device_id = null, interface_id = null, updated_at = now()
       where org_id = ${orgId} and source = 'hypervisor' and guest_id = ${g.id} and status <> 'released' ${keep}
      returning id, host(address) as ip`);
    for (const r of gone.rows) {
      released++;
      await tx.execute(sql`insert into ip_events (org_id, ip_id, actor_label, action, summary, data)
        values (${orgId}, ${r.id}, ${`${integrationName} sync`}, 'release', ${`Released: VM ${g.name} no longer reports ${r.ip}`}, ${JSON.stringify({ guestId: g.id })}::jsonb)`);
    }
  }
  return { recorded, released };
}
