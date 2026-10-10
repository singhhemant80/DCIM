import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  IP_ROLES,
  PREFIX_STATUSES,
  cidrSize,
  formatCidr,
  formatIp,
  ipAssignSchema,
  parseCidr,
  parseIp,
  prefixSchema,
  ptrName,
  usableRange,
  type Paginated,
  type ParsedCidr,
  type ipAllocateNextSchema,
  type ipListQuerySchema,
  type ipUpdateSchema,
  type prefixListQuerySchema,
  type prefixUpdateSchema,
} from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { ipAddresses, ipEvents, prefixes, type IpAddress, type Prefix } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import { parseCsvObjects, toCsv } from '../dcim/csv';
import type { Principal, RequestMeta } from '../auth/principal';
import { ZERO_UUID, like, notFound, ownCustomer, ownDatacenter, ownDevice, ownInterface, ownVlans, ownVrf } from './common';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type PrefixInput = z.infer<typeof prefixSchema>;
type AssignInput = z.infer<typeof ipAssignSchema>;
type Assignment = Omit<AssignInput, 'address' | 'vrfId'>;

class DryRunRollback extends Error {}

/** Statuses that occupy an address (a lapsed reservation does not). */
const HOLDS = sql.raw(`(a.status in ('allocated','deprecated') or (a.status = 'reserved' and (a.reserved_until is null or a.reserved_until > now())))`);
const sameVrf = (a: string, b: string) => sql.raw(`coalesce(${a}.vrf_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${b}.vrf_id, '00000000-0000-0000-0000-000000000000'::uuid)`);

/**
 * IPv4 and IPv6 address management.
 *
 * Integrity: prefixes and addresses are unique per VRF (database indexes);
 * addresses are stored as host addresses; every allocation locks the most
 * specific prefix row, so concurrent allocations from the same subnet are
 * serialized and can never hand out the same address. Releasing keeps the row
 * (status "released") so history survives and the address can be reused.
 * Nothing here talks to routers: allocating an address never changes device
 * configuration or BGP announcements.
 */
@Injectable()
export class IpamService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Prefixes
  // ---------------------------------------------------------------------------

  async listPrefixes(p: Principal, q: z.infer<typeof prefixListQuerySchema>) {
    const conds: SQL[] = [sql`x.org_id = ${p.orgId}`];
    if (p.userType !== 'staff') conds.push(sql`x.customer_id = ${p.customerId}`);
    else if (q.customerId) conds.push(sql`x.customer_id = ${q.customerId}`);
    if (q.vrfId === 'global') conds.push(sql`x.vrf_id is null`);
    else if (q.vrfId) conds.push(sql`x.vrf_id = ${q.vrfId}`);
    if (q.family) conds.push(sql`family(x.prefix) = ${Number(q.family)}`);
    if (q.q) {
      const asCidr = parseCidr(q.q, true);
      const asIp = parseIp(q.q);
      if (asCidr) conds.push(sql`(x.prefix >>= ${formatCidr(asCidr)}::cidr or x.prefix <<= ${formatCidr(asCidr)}::cidr)`);
      else if (asIp) conds.push(sql`x.prefix >>= ${formatIp(asIp.family, asIp.value)}::inet`);
      else conds.push(sql`(x.description ilike ${like(q.q)} or cu.name ilike ${like(q.q)} or v.name ilike ${like(q.q)})`);
    }
    const res = await this.db.execute(sql`
      select x.*, v.name as vrf_name, dc.code as datacenter_code, vl.vid as vlan_vid, vl.name as vlan_name, cu.name as customer_name,
             (select count(*)::int from prefixes c where c.org_id = x.org_id and ${sameVrf('c', 'x')} and c.prefix << x.prefix) as descendant_count,
             (select count(*)::int from prefixes c where c.org_id = x.org_id and ${sameVrf('c', 'x')} and c.prefix >> x.prefix) as depth,
             (select count(*)::int from ip_addresses a where a.org_id = x.org_id and ${sameVrf('a', 'x')} and a.address <<= x.prefix and ${HOLDS}
                ${p.userType === 'staff' ? sql`` : sql`and a.customer_id = ${p.customerId}`}) as used
      from prefixes x
      left join vrfs v on v.id = x.vrf_id
      left join datacenters dc on dc.id = x.datacenter_id
      left join vlans vl on vl.id = x.vlan_id
      left join customers cu on cu.id = x.customer_id
      where ${sql.join(conds, sql` and `)}
      order by v.name nulls first, family(x.prefix), x.prefix`);
    const rows = res.rows as Record<string, unknown>[];
    const parsed = rows.map((r) => ({ r, c: parseCidr(String(r.prefix))! }));
    return parsed.map(({ r, c }) => {
      // Coverage by direct children (largest more-specific prefixes), counted once.
      const children = parsed.filter((o) => o.r.vrf_id === r.vrf_id && o.c.family === c.family && o.c.length > c.length && o.c.network >= c.network && o.c.network <= c.network + cidrSize(c) - 1n);
      const direct = children.filter((ch) => !children.some((o) => o !== ch && o.c.length < ch.c.length && ch.c.network >= o.c.network && ch.c.network <= o.c.network + cidrSize(o.c) - 1n));
      const covered = direct.reduce((a, ch) => a + cidrSize(ch.c), 0n);
      return this.prefixView(p, r, c, Number(r.used), covered, direct.length);
    });
  }

  private prefixView(p: Principal, r: Record<string, unknown>, c: ParsedCidr, used: number, covered: bigint, childCount: number) {
    const usable = usableRange(c, r.is_pool as boolean).count;
    const size = cidrSize(c);
    const base = {
      id: r.id as string,
      prefix: formatCidr(c),
      family: c.family,
      vrfId: r.vrf_id as string | null,
      vrfName: (r.vrf_name as string | null) ?? null,
      status: r.status as Prefix['status'],
      isPool: r.is_pool as boolean,
      gateway: r.gateway ? String(r.gateway).split('/')[0] : null,
      description: r.description as string | null,
      customerId: r.customer_id as string | null,
      customerName: r.customer_name as string | null,
      datacenterId: r.datacenter_id as string | null,
      datacenterCode: r.datacenter_code as string | null,
      vlan: r.vlan_id ? { id: r.vlan_id as string, vid: r.vlan_vid as number, name: r.vlan_name as string } : null,
      depth: Number(r.depth ?? 0),
      childCount,
      size: size.toString(),
      usable: usable.toString(),
      usedAddresses: used,
      /** Share of usable addresses that are allocated or held (IPv6 values are usually ~0). */
      addressUtilization: usable > 0n ? Number((BigInt(used) * 1_000_000n) / usable) / 10_000 : 0,
      /** Share of the prefix covered by more-specific child prefixes. */
      childCoverage: Number((covered * 1_000_000n) / size) / 10_000,
    };
    return p.userType === 'staff' ? base : { ...base, description: null, datacenterId: null, datacenterCode: null, depth: 0, childCount: 0 };
  }

  async getPrefix(p: Principal, id: string) {
    const pre = await this.ownPrefix(p, id, true);
    const all = await this.listPrefixes(p, { q: formatCidr(parseCidr(String(pre.prefix))!) } as z.infer<typeof prefixListQuerySchema>);
    const self = all.find((x) => x.id === id);
    if (!self) throw notFound('Prefix');
    const c = parseCidr(self.prefix)!;
    const same = (x: (typeof all)[number]) => x.vrfId === self.vrfId && x.id !== id;
    const parents = all.filter((x) => same(x) && x.depth < self.depth).sort((a, b) => a.depth - b.depth);
    const children = all.filter((x) => same(x) && x.depth === self.depth + 1);
    return { ...self, parents, children, available: p.userType === 'staff' ? await this.availableRanges(this.db, pre, c, 20) : [], ptrZone: reverseZone(c) };
  }

  async createPrefix(p: Principal, input: PrefixInput, meta: RequestMeta) {
    await this.checkPrefixRefs(p, input);
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(prefixes).values({ ...this.prefixCols(input), orgId: p.orgId, prefix: input.prefix, vrfId: input.vrfId ?? null }).returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: row!.customerId, action: 'prefix.create', target: { type: 'prefix', id: row!.id }, outcome: 'success', meta, metadata: { prefix: input.prefix, status: input.status } }, tx);
        return row!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async updatePrefix(p: Principal, id: string, input: z.infer<typeof prefixUpdateSchema>, meta: RequestMeta) {
    const before = await this.ownPrefix(p, id);
    await this.checkPrefixRefs(p, { ...input, prefix: String(before.prefix), vrfId: before.vrfId }, id);
    if (input.customerId && input.customerId !== before.customerId) {
      // Every address already used in the prefix must belong to the new customer (or nobody).
      const res = await this.db.execute(sql`select count(*)::int as n from ip_addresses a where a.org_id = ${p.orgId} and coalesce(a.vrf_id, ${ZERO_UUID}) = coalesce(${before.vrfId}::uuid, ${ZERO_UUID}) and a.address <<= ${String(before.prefix)}::cidr and ${HOLDS} and a.customer_id is distinct from ${input.customerId} and a.customer_id is not null`);
      const n = (res.rows[0] as { n: number }).n;
      if (n > 0) throw new ConflictException({ error: 'customer_mismatch', message: `${n} address(es) in this prefix belong to another customer` });
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.update(prefixes).set(this.prefixCols({ ...input, prefix: String(before.prefix) })).where(eq(prefixes.id, id)).returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: row!.customerId, action: 'prefix.update', target: { type: 'prefix', id }, outcome: 'success', meta, metadata: { prefix: String(before.prefix), before: { status: before.status, customerId: before.customerId }, after: { status: row!.status, customerId: row!.customerId } } }, tx);
        return row!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async deletePrefix(p: Principal, id: string, meta: RequestMeta) {
    const pre = await this.ownPrefix(p, id);
    await this.db.transaction(async (tx) => {
      await tx.select({ id: prefixes.id }).from(prefixes).where(eq(prefixes.id, id)).for('update');
      // Addresses that would be left outside every prefix.
      const res = await tx.execute(sql`
        select count(*)::int as n from ip_addresses a
        where a.org_id = ${p.orgId} and coalesce(a.vrf_id, ${ZERO_UUID}) = coalesce(${pre.vrfId}::uuid, ${ZERO_UUID}) and a.address <<= ${String(pre.prefix)}::cidr and a.status <> 'released'
          and not exists (select 1 from prefixes o where o.id <> ${id} and o.org_id = a.org_id and ${sameVrf('o', 'a')} and a.address <<= o.prefix)`);
      const n = (res.rows[0] as { n: number }).n;
      if (n > 0) throw new ConflictException({ error: 'prefix_in_use', message: `${n} address(es) are only covered by this prefix; release them first` });
      await tx.delete(prefixes).where(eq(prefixes.id, id));
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: pre.customerId, action: 'prefix.delete', target: { type: 'prefix', id }, outcome: 'success', meta, metadata: { prefix: String(pre.prefix) } }, tx);
    });
  }

  private prefixCols(i: z.infer<typeof prefixUpdateSchema> & { prefix: string }) {
    return {
      status: i.status,
      isPool: i.isPool,
      datacenterId: i.datacenterId ?? null,
      vlanId: i.vlanId ?? null,
      customerId: i.customerId ?? null,
      gateway: i.gateway ?? null,
      description: i.description ?? null,
    };
  }

  private async checkPrefixRefs(p: Principal, i: z.infer<typeof prefixUpdateSchema> & { prefix: string; vrfId?: string | null }, selfId?: string) {
    await ownVrf(this.db, p, i.vrfId);
    await ownDatacenter(this.db, p, i.datacenterId);
    await ownCustomer(this.db, p, i.customerId);
    if (i.vlanId) await ownVlans(this.db, p, [i.vlanId]);
    if (i.customerId) {
      // A prefix can't be assigned to one customer while a covering or covered prefix belongs to another.
      const res = await this.db.execute(sql`
        select x.prefix::text as prefix from prefixes x
        where x.org_id = ${p.orgId} and coalesce(x.vrf_id, ${ZERO_UUID}) = coalesce(${i.vrfId ?? null}::uuid, ${ZERO_UUID})
          and (x.prefix >> ${i.prefix}::cidr or x.prefix << ${i.prefix}::cidr)
          and x.customer_id is not null and x.customer_id <> ${i.customerId}
          ${selfId ? sql`and x.id <> ${selfId}` : sql``}
        limit 1`);
      const other = (res.rows[0] as { prefix?: string } | undefined)?.prefix;
      if (other) throw new ConflictException({ error: 'customer_mismatch', message: `${other} belongs to another customer` });
    }
    if (i.gateway) {
      const c = parseCidr(i.prefix)!;
      const g = parseIp(i.gateway)!;
      if (g.family !== c.family || g.value < c.network || g.value > c.network + cidrSize(c) - 1n) {
        throw new BadRequestException({ error: 'invalid_gateway', message: 'The gateway must be an address inside the prefix' });
      }
    }
  }

  private async ownPrefix(p: Principal, id: string, allowCustomer = false): Promise<Prefix> {
    const conds = [eq(prefixes.id, id), eq(prefixes.orgId, p.orgId)];
    if (p.userType !== 'staff') {
      if (!allowCustomer) throw notFound('Prefix');
      conds.push(eq(prefixes.customerId, p.customerId!));
    }
    const [row] = await this.db.select().from(prefixes).where(and(...conds));
    if (!row) throw notFound('Prefix');
    return row;
  }

  /** Free ranges inside a prefix: not used by addresses, child prefixes or the gateway. */
  private async availableRanges(db: DbOrTx, pre: Prefix, c: ParsedCidr, limit: number) {
    const blocked = await this.blockedIntervals(db, pre, c);
    const range = usableRange(c, pre.isPool);
    const out: { first: string; last: string; count: string }[] = [];
    let cursor = range.first;
    for (const [a, b] of blocked) {
      if (b < cursor) continue;
      if (a > range.last) break;
      if (a > cursor) out.push(this.rangeView(c.family, cursor, (a - 1n < range.last ? a - 1n : range.last)));
      cursor = b + 1n > cursor ? b + 1n : cursor;
      if (out.length >= limit) return out;
    }
    if (cursor <= range.last && out.length < limit) out.push(this.rangeView(c.family, cursor, range.last));
    return out;
  }

  private rangeView(family: 4 | 6, a: bigint, b: bigint) {
    return { first: formatIp(family, a), last: formatIp(family, b), count: (b - a + 1n).toString() };
  }

  /** Sorted, merged intervals of addresses that can't be handed out from this prefix. */
  private async blockedIntervals(db: DbOrTx, pre: Prefix, c: ParsedCidr): Promise<[bigint, bigint][]> {
    const [used, children] = await Promise.all([
      db.execute(sql`select host(a.address) as ip from ip_addresses a where a.org_id = ${pre.orgId} and coalesce(a.vrf_id, ${ZERO_UUID}) = coalesce(${pre.vrfId}::uuid, ${ZERO_UUID}) and a.address <<= ${String(pre.prefix)}::cidr and ${HOLDS}`),
      db.execute(sql`select c.prefix::text as prefix from prefixes c where c.org_id = ${pre.orgId} and coalesce(c.vrf_id, ${ZERO_UUID}) = coalesce(${pre.vrfId}::uuid, ${ZERO_UUID}) and c.prefix << ${String(pre.prefix)}::cidr`),
    ]);
    const intervals: [bigint, bigint][] = [];
    for (const r of used.rows as { ip: string }[]) {
      const v = parseIp(r.ip)!.value;
      intervals.push([v, v]);
    }
    for (const r of children.rows as { prefix: string }[]) {
      const ch = parseCidr(r.prefix)!;
      intervals.push([ch.network, ch.network + cidrSize(ch) - 1n]);
    }
    if (pre.gateway) {
      const g = parseIp(String(pre.gateway).split('/')[0]!)!.value;
      intervals.push([g, g]);
    }
    void c;
    intervals.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    const merged: [bigint, bigint][] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1n) last[1] = iv[1] > last[1] ? iv[1] : last[1];
      else merged.push([iv[0], iv[1]]);
    }
    return merged;
  }

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  async listAddresses(p: Principal, q: z.infer<typeof ipListQuerySchema>): Promise<Paginated<ReturnType<IpamService['addressView']>>> {
    const conds: SQL[] = [sql`a.org_id = ${p.orgId}`];
    if (p.userType !== 'staff') conds.push(sql`a.customer_id = ${p.customerId}`, sql`a.status <> 'released'`);
    else if (q.customerId) conds.push(sql`a.customer_id = ${q.customerId}`);
    // Released rows are history; they are listed only when asked for explicitly.
    if (q.status) conds.push(sql`a.status = ${q.status}`);
    else conds.push(sql`a.status <> 'released'`);
    if (q.deviceId) conds.push(sql`a.device_id = ${q.deviceId}`);
    if (q.vrfId) conds.push(sql`a.vrf_id = ${q.vrfId}`);
    if (q.prefixId) {
      const pre = await this.ownPrefix(p, q.prefixId, true);
      conds.push(sql`a.address <<= ${String(pre.prefix)}::cidr and coalesce(a.vrf_id, ${ZERO_UUID}) = coalesce(${pre.vrfId}::uuid, ${ZERO_UUID})`);
    }
    if (q.q) {
      const asIp = parseIp(q.q);
      const asCidr = parseCidr(q.q, true);
      if (asIp) conds.push(sql`a.address = ${formatIp(asIp.family, asIp.value)}::inet`);
      else if (asCidr) conds.push(sql`a.address <<= ${formatCidr(asCidr)}::cidr`);
      else conds.push(sql`(a.dns_name ilike ${like(q.q)} or d.hostname ilike ${like(q.q)} or d.asset_tag ilike ${like(q.q)} or cu.name ilike ${like(q.q)} or a.service_ref ilike ${like(q.q)})`);
    }
    const where = sql.join(conds, sql` and `);
    const [rows, total] = await Promise.all([
      this.db.execute(sql`${this.addressSelect()} where ${where} order by family(a.address), a.address limit ${q.pageSize} offset ${(q.page - 1) * q.pageSize}`),
      this.db.execute(sql`select count(*)::int as n from ip_addresses a left join devices d on d.id = a.device_id left join customers cu on cu.id = a.customer_id where ${where}`),
    ]);
    return { items: (rows.rows as Record<string, unknown>[]).map((r) => this.addressView(p, r)), page: q.page, pageSize: q.pageSize, total: (total.rows[0] as { n: number }).n };
  }

  private addressSelect() {
    return sql`
      select a.*, host(a.address) as ip, v.name as vrf_name, cu.name as customer_name, coalesce(d.hostname, d.asset_tag) as device_name, i.name as interface_name,
             d.customer_id as device_customer_id,
             (select x.customer_id from prefixes x where x.org_id = a.org_id and ${sameVrf('x', 'a')} and a.address <<= x.prefix order by masklen(x.prefix) desc limit 1) as prefix_customer_id,
             (select x.id from prefixes x where x.org_id = a.org_id and ${sameVrf('x', 'a')} and a.address <<= x.prefix order by masklen(x.prefix) desc limit 1) as prefix_id,
             (select x.prefix::text from prefixes x where x.org_id = a.org_id and ${sameVrf('x', 'a')} and a.address <<= x.prefix order by masklen(x.prefix) desc limit 1) as prefix
      from ip_addresses a
      left join vrfs v on v.id = a.vrf_id
      left join customers cu on cu.id = a.customer_id
      left join devices d on d.id = a.device_id
      left join interfaces i on i.id = a.interface_id`;
  }

  addressView(p: Principal, r: Record<string, unknown>) {
    const expired = r.status === 'reserved' && !!r.reserved_until && new Date(r.reserved_until as string).getTime() <= Date.now();
    const ip = String(r.ip);
    const base = {
      id: r.id as string,
      address: ip,
      family: ip.includes(':') ? 6 : 4,
      prefixLength: r.prefix_length as number | null,
      vrfId: r.vrf_id as string | null,
      vrfName: r.vrf_name as string | null,
      status: r.status as IpAddress['status'],
      reservationExpired: expired,
      role: r.role as IpAddress['role'],
      dnsName: r.dns_name as string | null,
      reverseDns: r.reverse_dns as string | null,
      customerId: r.customer_id as string | null,
      customerName: r.customer_name as string | null,
      deviceId: r.device_id as string | null,
      deviceName: r.device_name as string | null,
      interfaceId: r.interface_id as string | null,
      interfaceName: r.interface_name as string | null,
      serviceRef: r.service_ref as string | null,
      reservedUntil: r.reserved_until as string | null,
      prefixId: r.prefix_id as string | null,
      prefix: r.prefix as string | null,
      updatedAt: r.updated_at as string,
    };
    if (p.userType === 'staff') {
      return {
        ...base,
        notes: r.notes as string | null,
        dns: { status: r.dns_status as string, error: r.dns_error as string | null, syncedAt: r.dns_synced_at as string | null, records: (r.dns_records as { name: string; type: string; content: string }[]).map(({ name, type, content }) => ({ name, type, content })) },
      };
    }
    // Customers see infrastructure details only when they own them (their device, their subnet).
    const ownDevice = r.device_customer_id === p.customerId;
    const ownPrefix = r.prefix_customer_id === p.customerId;
    return {
      ...base,
      prefixId: null,
      prefix: ownPrefix ? base.prefix : null,
      deviceId: ownDevice ? base.deviceId : null,
      deviceName: ownDevice ? base.deviceName : null,
      interfaceId: ownDevice ? base.interfaceId : null,
      interfaceName: ownDevice ? base.interfaceName : null,
    };
  }

  async getAddress(p: Principal, id: string) {
    const conds = [sql`a.id = ${id}`, sql`a.org_id = ${p.orgId}`];
    if (p.userType !== 'staff') conds.push(sql`a.customer_id = ${p.customerId}`);
    const res = await this.db.execute(sql`${this.addressSelect()} where ${sql.join(conds, sql` and `)}`);
    if (!res.rows[0]) throw notFound('IP address');
    return this.addressView(p, res.rows[0] as Record<string, unknown>);
  }

  async history(p: Principal, id: string) {
    await this.getAddress(p, id);
    return this.db.select().from(ipEvents).where(eq(ipEvents.ipId, id)).orderBy(sql`${ipEvents.id} desc`).limit(200);
  }

  /** Reserves or allocates one specific address. */
  async assign(p: Principal, input: AssignInput, meta: RequestMeta, tx?: Tx) {
    const run = async (t: Tx) => {
      const ip = parseIp(input.address)!;
      const pre = await this.mostSpecificPrefix(t, p, input.vrfId ?? null, input.address, true);
      if (!pre) throw new BadRequestException({ error: 'no_prefix', message: `No prefix${input.vrfId ? ' in that VRF' : ''} contains ${input.address}; add the prefix first` });
      const c = parseCidr(String(pre.prefix))!;
      const range = usableRange(c, pre.isPool);
      if (ip.value < range.first || ip.value > range.last) {
        throw new BadRequestException({ error: 'reserved_address', message: `${input.address} is the ${ip.value === c.network ? 'network' : 'broadcast'} address of ${formatCidr(c)}` });
      }
      this.checkPrefixUsable(pre);
      const a = await this.resolveAssignment(t, p, input, pre);
      const id = await this.upsert(t, p, input.vrfId ?? null, input.address, a, c.length);
      if (!id) throw new ConflictException({ error: 'address_in_use', message: `${input.address} is already ${await this.holderDescription(t, p, input.vrfId ?? null, input.address)}` });
      await this.event(t, p, id, a.status, `${a.status === 'reserved' ? 'Reserved' : 'Allocated'}${this.assignmentSummary(a)}`, { prefix: formatCidr(c) });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: a.customerId ?? null, action: `ip.${a.status === 'reserved' ? 'reserve' : 'allocate'}`, target: { type: 'ip_address', id }, outcome: 'success', meta, metadata: { address: input.address } }, t);
      return id;
    };
    try {
      const id = tx ? await run(tx) : await this.db.transaction(run);
      return tx ? { id } : this.getAddress(p, id);
    } catch (err) {
      rethrowDbError(err);
    }
  }

  /** Allocates the next N free addresses in a prefix, atomically. */
  async allocateNext(p: Principal, input: z.infer<typeof ipAllocateNextSchema>, meta: RequestMeta) {
    const pre0 = await this.ownPrefix(p, input.prefixId);
    try {
      const ids = await this.db.transaction(async (tx) => {
        // The lock serializes every allocation in this prefix.
        const [pre] = await tx.select().from(prefixes).where(eq(prefixes.id, pre0.id)).for('update');
        this.checkPrefixUsable(pre!);
        const c = parseCidr(String(pre!.prefix))!;
        const blocked = await this.blockedIntervals(tx, pre!, c);
        const range = usableRange(c, pre!.isPool);
        const picked: bigint[] = [];
        let cursor = range.first;
        let bi = 0;
        while (picked.length < input.count && cursor <= range.last) {
          while (bi < blocked.length && blocked[bi]![1] < cursor) bi++;
          const b = blocked[bi];
          if (b && cursor >= b[0] && cursor <= b[1]) {
            cursor = b[1] + 1n;
            continue;
          }
          picked.push(cursor);
          cursor++;
        }
        if (picked.length < input.count) {
          throw new ConflictException({ error: 'prefix_full', message: picked.length ? `Only ${picked.length} free address(es) left in ${formatCidr(c)}` : `No free addresses left in ${formatCidr(c)}` });
        }
        const a = await this.resolveAssignment(tx, p, input, pre!);
        const out: string[] = [];
        for (const v of picked) {
          const address = formatIp(c.family, v);
          const id = await this.upsert(tx, p, pre!.vrfId, address, a, c.length);
          if (!id) throw new ConflictException({ error: 'address_in_use', message: `${address} was taken concurrently; try again` });
          await this.event(tx, p, id, a.status, `${a.status === 'reserved' ? 'Reserved' : 'Allocated'} as next free address in ${formatCidr(c)}${this.assignmentSummary(a)}`, { prefix: formatCidr(c) });
          out.push(id);
        }
        await this.audit.record(
          { orgId: p.orgId, actor: actorFrom(p), customerId: a.customerId ?? null, action: `ip.${a.status === 'reserved' ? 'reserve' : 'allocate'}_next`, target: { type: 'prefix', id: pre!.id }, outcome: 'success', meta, metadata: { prefix: formatCidr(c), addresses: picked.map((v) => formatIp(c.family, v)) } },
          tx,
        );
        return out;
      });
      return Promise.all(ids.map((id) => this.getAddress(p, id)));
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async updateAddress(p: Principal, id: string, input: z.infer<typeof ipUpdateSchema>, meta: RequestMeta) {
    const before = await this.ownAddress(p, id);
    if (before.status === 'released') throw new BadRequestException({ error: 'address_released', message: 'This address was released; reserve or allocate it again instead' });
    try {
      await this.db.transaction(async (tx) => {
        const ip = String(before.address).split('/')[0]!;
        const pre = await this.mostSpecificPrefix(tx, p, before.vrfId, ip, true);
        // PATCH: fields left out keep their current value; send null to clear one.
        const current: Assignment = {
          status: 'allocated',
          prefixLength: before.prefixLength,
          role: before.role,
          dnsName: before.dnsName,
          reverseDns: before.reverseDns,
          customerId: before.customerId,
          deviceId: before.deviceId,
          interfaceId: before.interfaceId,
          serviceRef: before.serviceRef,
          reservedUntil: before.reservedUntil ? before.reservedUntil.toISOString() : null,
          notes: before.notes,
        };
        const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<Assignment>;
        const merged = { ...current, ...given, status: input.status === 'reserved' ? 'reserved' : 'allocated' } as Assignment;
        const a = await this.resolveAssignment(tx, p, merged, pre);
        const [after] = await tx
          .update(ipAddresses)
          .set({ ...this.assignmentCols(a), status: input.status })
          .where(eq(ipAddresses.id, id))
          .returning();
        const changed = (['status', 'customerId', 'deviceId', 'interfaceId', 'dnsName', 'reverseDns', 'role', 'serviceRef', 'reservedUntil', 'prefixLength'] as const).filter(
          (k) => JSON.stringify(before[k]) !== JSON.stringify(after![k]),
        );
        if (changed.length) await this.event(tx, p, id, 'updated', `Changed ${changed.join(', ')}`, { before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after![k]])) });
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: after!.customerId ?? before.customerId, action: 'ip.update', target: { type: 'ip_address', id }, outcome: 'success', meta, metadata: { address: ip, fields: changed } }, tx);
      });
    } catch (err) {
      rethrowDbError(err);
    }
    return this.getAddress(p, id);
  }

  async release(p: Principal, id: string, reason: string | undefined, meta: RequestMeta) {
    const before = await this.ownAddress(p, id);
    if (before.status === 'released') throw new BadRequestException({ error: 'address_released', message: 'Already released' });
    await this.db.transaction(async (tx) => {
      await tx
        .update(ipAddresses)
        .set({ status: 'released', customerId: null, deviceId: null, interfaceId: null, serviceRef: null, role: null, reservedUntil: null, dnsName: null, reverseDns: null })
        .where(eq(ipAddresses.id, id));
      await this.event(tx, p, id, 'released', `Released${reason ? `: ${reason}` : ''}`, { before: { status: before.status, customerId: before.customerId, deviceId: before.deviceId, dnsName: before.dnsName } });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: before.customerId, action: 'ip.release', target: { type: 'ip_address', id }, outcome: 'success', meta, metadata: { address: String(before.address).split('/')[0], reason: reason ?? null } }, tx);
    });
    return this.getAddress(p, id);
  }

  // ---------------------------------------------------------------------------

  private checkPrefixUsable(pre: Prefix) {
    if (pre.status === 'deprecated') throw new BadRequestException({ error: 'prefix_deprecated', message: `${pre.prefix} is deprecated; no new addresses can be assigned from it` });
    if (pre.status === 'container') throw new BadRequestException({ error: 'prefix_container', message: `${pre.prefix} is a container; assign addresses from one of its subnets` });
  }

  private async mostSpecificPrefix(db: DbOrTx, p: Principal, vrfId: string | null, address: string, lock: boolean): Promise<Prefix | null> {
    await ownVrf(db, p, vrfId);
    const res = await db.execute(sql`
      select id from prefixes x
      where x.org_id = ${p.orgId} and coalesce(x.vrf_id, ${ZERO_UUID}) = coalesce(${vrfId}::uuid, ${ZERO_UUID}) and ${address}::inet <<= x.prefix
      order by masklen(x.prefix) desc limit 1`);
    const id = (res.rows[0] as { id?: string } | undefined)?.id;
    if (!id) return null;
    const q = db.select().from(prefixes).where(eq(prefixes.id, id));
    const [row] = lock ? await q.for('update') : await q;
    return row ?? null;
  }

  /** Validates references and inherits the customer from the device when not given. */
  private async resolveAssignment(db: DbOrTx, p: Principal, input: Assignment, pre: Prefix | null): Promise<Assignment> {
    const a = { ...input };
    if (a.interfaceId) {
      const i = await ownInterface(db, p, a.interfaceId);
      if (a.deviceId && a.deviceId !== i.deviceId) throw new BadRequestException({ error: 'interface_device_mismatch', message: 'That interface is on a different device' });
      a.deviceId = i.deviceId;
    }
    if (a.deviceId) {
      const d = await ownDevice(db, p, a.deviceId);
      if (!a.customerId && d.customerId) a.customerId = d.customerId;
      if (a.customerId && d.customerId && d.customerId !== a.customerId) throw new BadRequestException({ error: 'customer_mismatch', message: 'The device is assigned to a different customer' });
    }
    await ownCustomer(db, p, a.customerId);
    if (pre?.customerId && a.customerId && a.customerId !== pre.customerId) {
      throw new BadRequestException({ error: 'customer_mismatch', message: `${pre.prefix} is assigned to another customer` });
    }
    if (pre?.customerId && !a.customerId) a.customerId = pre.customerId;
    if (a.status === 'allocated') a.reservedUntil = null;
    return a;
  }

  private assignmentCols(a: Assignment) {
    return {
      prefixLength: a.prefixLength ?? null,
      role: a.role ?? null,
      dnsName: a.dnsName ?? null,
      reverseDns: a.reverseDns ?? null,
      customerId: a.customerId ?? null,
      deviceId: a.deviceId ?? null,
      interfaceId: a.interfaceId ?? null,
      serviceRef: a.serviceRef ?? null,
      reservedUntil: a.reservedUntil ? new Date(a.reservedUntil) : null,
      notes: a.notes ?? null,
    };
  }

  /**
   * Inserts the address, or takes over a released / lapsed-reservation row for
   * it. Returns null when someone else holds the address.
   */
  private async upsert(tx: Tx, p: Principal, vrfId: string | null, address: string, a: Assignment, defaultLength: number): Promise<string | null> {
    const c = this.assignmentCols(a);
    const res = await tx.execute(sql`
      insert into ip_addresses (org_id, vrf_id, address, status, prefix_length, role, dns_name, reverse_dns, customer_id, device_id, interface_id, service_ref, reserved_until, notes)
      values (${p.orgId}, ${vrfId}, ${address}::inet, ${a.status}, ${c.prefixLength ?? defaultLength}, ${c.role}, ${c.dnsName}, ${c.reverseDns}, ${c.customerId}, ${c.deviceId}, ${c.interfaceId}, ${c.serviceRef}, ${c.reservedUntil?.toISOString() ?? null}::timestamptz, ${c.notes})
      on conflict (org_id, (coalesce(vrf_id, '00000000-0000-0000-0000-000000000000'::uuid)), address) do update set
        status = excluded.status, prefix_length = excluded.prefix_length, role = excluded.role, dns_name = excluded.dns_name, reverse_dns = excluded.reverse_dns,
        customer_id = excluded.customer_id, device_id = excluded.device_id, interface_id = excluded.interface_id, service_ref = excluded.service_ref,
        reserved_until = excluded.reserved_until, notes = excluded.notes
      where ip_addresses.status = 'released' or (ip_addresses.status = 'reserved' and ip_addresses.reserved_until is not null and ip_addresses.reserved_until <= now())
      returning id`);
    return (res.rows[0] as { id?: string } | undefined)?.id ?? null;
  }

  private async holderDescription(db: DbOrTx, p: Principal, vrfId: string | null, address: string) {
    const res = await db.execute(sql`select a.status, coalesce(d.hostname, d.asset_tag) as device, cu.name as customer from ip_addresses a left join devices d on d.id = a.device_id left join customers cu on cu.id = a.customer_id where a.org_id = ${p.orgId} and coalesce(a.vrf_id, ${ZERO_UUID}) = coalesce(${vrfId}::uuid, ${ZERO_UUID}) and a.address = ${address}::inet`);
    const r = res.rows[0] as { status: string; device: string | null; customer: string | null } | undefined;
    if (!r) return 'in use';
    return `${r.status}${r.device ? ` to ${r.device}` : r.customer ? ` to ${r.customer}` : ''}`;
  }

  private assignmentSummary(a: Assignment) {
    const parts = [a.dnsName && `DNS ${a.dnsName}`, a.serviceRef && `service ${a.serviceRef}`].filter(Boolean);
    return parts.length ? ` (${parts.join(', ')})` : '';
  }

  private async event(tx: DbOrTx, p: Principal, ipId: string, action: string, summary: string, data: Record<string, unknown> = {}) {
    await tx.insert(ipEvents).values({ orgId: p.orgId, ipId, action, summary, data, actorId: p.userId, actorLabel: p.email });
  }

  private async ownAddress(p: Principal, id: string): Promise<IpAddress> {
    const [a] = await this.db.select().from(ipAddresses).where(and(eq(ipAddresses.id, id), eq(ipAddresses.orgId, p.orgId)));
    if (!a) throw notFound('IP address');
    return a;
  }

  // ---------------------------------------------------------------------------
  // Conflicts and summary
  // ---------------------------------------------------------------------------

  /** Problems worth an operator's attention; nothing here is changed automatically. */
  async conflicts(p: Principal) {
    const res = await this.db.execute(sql`
      with a as (
        select a.*, host(a.address) as ip, coalesce(d.hostname, d.asset_tag) as device_name,
               (select x.id from prefixes x where x.org_id = a.org_id and ${sameVrf('x', 'a')} and a.address <<= x.prefix order by masklen(x.prefix) desc limit 1) as px
        from ip_addresses a left join devices d on d.id = a.device_id
        where a.org_id = ${p.orgId} and a.status <> 'released'
      )
      select a.id, a.ip, a.status, a.device_name, a.prefix_length, a.reserved_until, a.customer_id,
             x.prefix::text as prefix, x.is_pool, x.customer_id as prefix_customer, cu.name as prefix_customer_name, au.name as address_customer_name
      from a left join prefixes x on x.id = a.px
      left join customers cu on cu.id = x.customer_id left join customers au on au.id = a.customer_id`);
    type Row = { id: string; ip: string; status: string; device_name: string | null; prefix_length: number | null; reserved_until: string | null; customer_id: string | null; prefix: string | null; is_pool: boolean | null; prefix_customer: string | null; prefix_customer_name: string | null; address_customer_name: string | null };
    const issues: { kind: string; severity: 'warning' | 'error'; addressId: string; address: string; message: string }[] = [];
    for (const r of res.rows as Row[]) {
      const ip = parseIp(r.ip)!;
      if (!r.prefix) {
        issues.push({ kind: 'orphan', severity: 'error', addressId: r.id, address: r.ip, message: 'Not inside any prefix' });
        continue;
      }
      const c = parseCidr(r.prefix)!;
      const range = usableRange(c, !!r.is_pool);
      if (ip.value < range.first || ip.value > range.last) issues.push({ kind: 'network_or_broadcast', severity: 'error', addressId: r.id, address: r.ip, message: `Is the network or broadcast address of ${r.prefix}` });
      if (r.prefix_customer && r.customer_id && r.prefix_customer !== r.customer_id) {
        issues.push({ kind: 'customer_mismatch', severity: 'error', addressId: r.id, address: r.ip, message: `Assigned to ${r.address_customer_name} but ${r.prefix} belongs to ${r.prefix_customer_name}` });
      }
      if (r.prefix_length !== null && r.prefix_length !== c.length) {
        issues.push({ kind: 'length_mismatch', severity: 'warning', addressId: r.id, address: r.ip, message: `Configured as /${r.prefix_length} but its subnet is ${r.prefix}` });
      }
      if (r.status === 'reserved' && r.reserved_until && new Date(r.reserved_until).getTime() <= Date.now()) {
        issues.push({ kind: 'reservation_expired', severity: 'warning', addressId: r.id, address: r.ip, message: `Reservation expired ${new Date(r.reserved_until).toISOString().slice(0, 10)}; the address can be allocated again` });
      }
    }
    return { checkedAt: new Date().toISOString(), issues };
  }

  async summary(p: Principal) {
    const res = await this.db.execute(sql`
      select
        (select count(*)::int from prefixes where org_id = ${p.orgId}) as prefixes,
        (select count(*)::int from ip_addresses a where a.org_id = ${p.orgId} and a.status = 'allocated') as allocated,
        (select count(*)::int from ip_addresses a where a.org_id = ${p.orgId} and ${HOLDS} and a.status = 'reserved') as reserved`);
    const r = res.rows[0] as Record<string, number>;
    // IPv4 utilization over active, non-container leaf prefixes (IPv6 percentages are not meaningful in aggregate).
    const list = await this.listPrefixes(p, { family: '4' } as z.infer<typeof prefixListQuerySchema>);
    const leaves = list.filter((x) => x.status === 'active' && x.childCount === 0);
    const usable = leaves.reduce((a, x) => a + Number(x.usable), 0);
    const used = leaves.reduce((a, x) => a + x.usedAddresses, 0);
    return { prefixes: r.prefixes, allocated: r.allocated, reserved: r.reserved, ipv4: { usable, used, utilization: usable ? Math.round((used / usable) * 1000) / 10 : 0 }, fullest: [...leaves].sort((a, b) => b.addressUtilization - a.addressUtilization).slice(0, 5) };
  }

  // ---------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------

  static readonly PREFIX_HEADERS = ['prefix', 'vrf', 'status', 'is_pool', 'datacenter', 'vlan', 'customer_code', 'gateway', 'description'];
  static readonly ADDRESS_HEADERS = ['address', 'vrf', 'status', 'prefix_length', 'role', 'dns_name', 'reverse_dns', 'customer_code', 'device', 'interface', 'service_ref', 'reserved_until', 'notes'];

  async exportCsv(p: Principal, kind: 'prefixes' | 'addresses') {
    if (kind === 'prefixes') {
      const res = await this.db.execute(sql`
        select x.prefix::text as prefix, v.name as vrf, x.status, x.is_pool, dc.code as datacenter, vl.vid as vlan, cu.code as customer_code, host(x.gateway) as gateway, x.description
        from prefixes x left join vrfs v on v.id = x.vrf_id left join datacenters dc on dc.id = x.datacenter_id left join vlans vl on vl.id = x.vlan_id left join customers cu on cu.id = x.customer_id
        where x.org_id = ${p.orgId} order by v.name nulls first, family(x.prefix), x.prefix`);
      return toCsv(IpamService.PREFIX_HEADERS, (res.rows as Record<string, unknown>[]).map((r) => IpamService.PREFIX_HEADERS.map((h) => r[h])));
    }
    const res = await this.db.execute(sql`
      select host(a.address) as address, v.name as vrf, a.status, a.prefix_length, a.role, a.dns_name, a.reverse_dns, cu.code as customer_code,
             d.asset_tag as device, i.name as interface, a.service_ref, a.reserved_until, a.notes
      from ip_addresses a left join vrfs v on v.id = a.vrf_id left join customers cu on cu.id = a.customer_id left join devices d on d.id = a.device_id left join interfaces i on i.id = a.interface_id
      where a.org_id = ${p.orgId} and a.status <> 'released' order by v.name nulls first, family(a.address), a.address limit 200000`);
    return toCsv(IpamService.ADDRESS_HEADERS, (res.rows as Record<string, unknown>[]).map((r) => IpamService.ADDRESS_HEADERS.map((h) => r[h])));
  }

  /** CSV import with the same semantics as the forms; each row in a savepoint; dry run rolls back. */
  async importCsv(p: Principal, kind: 'prefixes' | 'addresses', csv: string, dryRun: boolean, meta: RequestMeta) {
    let parsed: ReturnType<typeof parseCsvObjects>;
    try {
      parsed = parseCsvObjects(csv);
    } catch (e) {
      throw new BadRequestException({ error: 'invalid_csv', message: (e as Error).message });
    }
    const required = kind === 'prefixes' ? ['prefix'] : ['address'];
    const missing = required.filter((h) => !parsed.headers.includes(h));
    if (missing.length) throw new BadRequestException({ error: 'invalid_csv', message: `Missing column(s): ${missing.join(', ')}` });
    if (parsed.rows.length > 10_000) throw new BadRequestException({ error: 'too_many_rows', message: 'Import at most 10,000 rows at a time' });
    // Prefixes first sorted by length, so parents exist before their children in the same file.
    const rows = parsed.rows.map((r, i) => ({ r, line: i + 2 }));
    if (kind === 'prefixes') rows.sort((a, b) => (parseCidr(a.r.prefix ?? '', true)?.length ?? 999) - (parseCidr(b.r.prefix ?? '', true)?.length ?? 999));
    const results: { line: number; key: string; ok: boolean; message: string }[] = [];
    try {
      await this.db.transaction(async (tx) => {
        for (const { r, line } of rows) {
          try {
            await tx.transaction(async (sp) => {
              await (kind === 'prefixes' ? this.importPrefixRow(p, r, sp, meta) : this.importAddressRow(p, r, sp, meta));
            });
            results.push({ line, key: r.prefix ?? r.address ?? '', ok: true, message: 'Created' });
          } catch (err) {
            results.push({ line, key: r.prefix ?? r.address ?? '', ok: false, message: safeMessage(err) });
          }
        }
        if (!dryRun) await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: `ipam.import_${kind}`, target: { type: kind, id: null }, outcome: 'success', meta, metadata: { rows: rows.length, created: results.filter((x) => x.ok).length } }, tx);
        if (dryRun) throw new DryRunRollback();
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
    results.sort((a, b) => a.line - b.line);
    return { dryRun, total: results.length, created: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
  }

  private async lookups(tx: Tx, p: Principal, r: Record<string, string>) {
    const v = (k: string) => (r[k] ?? '').trim().replace(/^'(?=[=+\-@])/, '') || null;
    const one = async (q: SQL, what: string) => {
      const res = await tx.execute(q);
      const id = (res.rows[0] as { id?: string } | undefined)?.id;
      if (!id) throw new BadRequestException({ error: 'invalid_row', message: what });
      return id;
    };
    const vrfId = v('vrf') ? await one(sql`select id from vrfs where org_id = ${p.orgId} and name = ${v('vrf')}`, `Unknown VRF ${v('vrf')}`) : null;
    const customerId = v('customer_code') ? await one(sql`select id from customers where org_id = ${p.orgId} and code = ${v('customer_code')!.toUpperCase()}`, `Unknown customer code ${v('customer_code')}`) : null;
    return { v, vrfId, customerId, one };
  }

  private async importPrefixRow(p: Principal, r: Record<string, string>, tx: Tx, meta: RequestMeta) {
    const { v, vrfId, customerId, one } = await this.lookups(tx, p, r);
    const datacenterId = v('datacenter') ? await one(sql`select id from datacenters where org_id = ${p.orgId} and code = ${v('datacenter')!.toUpperCase()}`, `Unknown datacenter ${v('datacenter')}`) : null;
    const vlanId = v('vlan')
      ? await one(sql`select id from vlans where org_id = ${p.orgId} and vid = ${Number(v('vlan'))} and (datacenter_id is not distinct from ${datacenterId}::uuid or datacenter_id is null) order by datacenter_id nulls last limit 1`, `Unknown VLAN ${v('vlan')}`)
      : null;
    const checked = prefixSchema.safeParse({
      prefix: v('prefix') ?? '',
      vrfId,
      status: v('status') ?? 'active',
      isPool: ['true', 'yes', '1'].includes((v('is_pool') ?? '').toLowerCase()),
      datacenterId,
      vlanId,
      customerId,
      gateway: v('gateway'),
      description: v('description'),
    });
    if (!checked.success) throw new BadRequestException({ error: 'invalid_row', message: `${checked.error.issues[0]!.path.join('.') || 'prefix'}: ${checked.error.issues[0]!.message}` });
    if (!PREFIX_STATUSES.includes(checked.data.status)) throw new BadRequestException({ error: 'invalid_row', message: 'Invalid status' });
    await tx.insert(prefixes).values({ ...this.prefixCols(checked.data), orgId: p.orgId, prefix: checked.data.prefix, vrfId });
    void meta;
  }

  private async importAddressRow(p: Principal, r: Record<string, string>, tx: Tx, meta: RequestMeta) {
    const { v, vrfId, customerId, one } = await this.lookups(tx, p, r);
    const deviceId = v('device') ? await one(sql`select id from devices where org_id = ${p.orgId} and lower(asset_tag) = lower(${v('device')})`, `Unknown device asset tag ${v('device')}`) : null;
    const interfaceId = v('interface')
      ? await one(sql`select id from interfaces where org_id = ${p.orgId} and device_id = ${deviceId}::uuid and lower(name) = lower(${v('interface')})`, deviceId ? `Device has no interface ${v('interface')}` : 'interface needs a device column')
      : null;
    const role = v('role');
    if (role && !(IP_ROLES as readonly string[]).includes(role)) throw new BadRequestException({ error: 'invalid_row', message: `role must be one of ${IP_ROLES.join(', ')}` });
    const checked = ipAssignSchema.safeParse({
      address: v('address') ?? '',
      vrfId,
      status: v('status') ?? 'allocated',
      prefixLength: v('prefix_length') ? Number(v('prefix_length')) : null,
      role,
      dnsName: v('dns_name'),
      reverseDns: v('reverse_dns'),
      customerId,
      deviceId,
      interfaceId,
      serviceRef: v('service_ref'),
      reservedUntil: v('reserved_until') ? new Date(v('reserved_until')!).toISOString() : null,
      notes: v('notes'),
    });
    if (!checked.success) throw new BadRequestException({ error: 'invalid_row', message: `${checked.error.issues[0]!.path.join('.') || 'address'}: ${checked.error.issues[0]!.message}` });
    await this.assign(p, checked.data, meta, tx);
  }
}

/** Reverse-DNS zone that covers the prefix on an octet/nibble boundary, e.g. 113.0.203.in-addr.arpa for 203.0.113.0/24. */
export function reverseZone(c: ParsedCidr): string {
  const full = ptrName({ family: c.family, value: c.network });
  const labels = full.split('.');
  const suffix = 2; // in-addr.arpa / ip6.arpa
  const keep = c.family === 4 ? Math.floor(c.length / 8) : Math.floor(c.length / 4);
  const total = labels.length - suffix;
  return labels.slice(total - keep).join('.');
}

function safeMessage(err: unknown): string {
  const http = (err as { response?: { message?: unknown } }).response;
  if (http && typeof http.message === 'string') return http.message;
  try {
    rethrowDbError(err);
  } catch (mapped) {
    const m = (mapped as { response?: { message?: unknown } }).response?.message;
    if (typeof m === 'string') return m;
  }
  return 'This row could not be saved';
}
