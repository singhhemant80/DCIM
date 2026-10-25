import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { parseCidr, routingSkipReason, type AsnRoutingData, type BgpAsnInput, type PrefixRoutingData } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { bgpAsns, prefixes } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Principal, RequestMeta } from '../auth/principal';
import { ROUTING_CANDIDATE } from '../worker/routing/check';

/**
 * Global routing (BGP) check: the organization's ASNs and each public
 * prefix's last check. The worker reads RIPEstat; this only reads the
 * stored results. Nothing here announces, withdraws or changes a route.
 */
@Injectable()
export class RoutingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async overview(p: Principal) {
    const asns = await this.db.select().from(bgpAsns).where(eq(bgpAsns.orgId, p.orgId)).orderBy(bgpAsns.asn);
    // Announced by our ASNs but not recorded in IPAM's global table (neither exactly nor inside a recorded prefix).
    const announced = [...new Set(asns.flatMap((a) => a.data?.prefixes ?? []))].filter((x) => parseCidr(x));
    const documented = new Set(
      announced.length
        ? (
            await this.db.execute<{ p: string }>(sql`
              select a.p::text as p from unnest(array[${sql.join(
                announced.map((x) => sql`${x}`),
                sql`, `,
              )}]::cidr[]) as a(p)
               where exists (select 1 from prefixes x where x.org_id = ${p.orgId} and x.vrf_id is null and x.prefix >>= a.p)`)
          ).rows.map((r) => String(r.p))
        : [],
    );
    const rows = (
      await this.db.execute<Record<string, unknown>>(sql`
        select x.id, x.prefix::text as prefix, x.status::text as status, x.description, x.origin_asn, x.routing_check, cu.name as customer_name,
               r.status as check_status, r.level, r.checked_at, r.next_at, r.data, r.last_error, r.last_attempt_at,
               (${ROUTING_CANDIDATE}) as candidate
          from prefixes x left join prefix_routing r on r.prefix_id = x.id left join customers cu on cu.id = x.customer_id
         where x.org_id = ${p.orgId} and x.vrf_id is null
         order by family(x.prefix), x.prefix`)
    ).rows;
    const items = rows
      .map((r) => {
        const skip = routingSkipReason(String(r.prefix));
        const data = (r.data as PrefixRoutingData | null) ?? null;
        return {
          id: String(r.id),
          prefix: String(r.prefix),
          status: String(r.status),
          description: (r.description as string | null) ?? null,
          customerName: (r.customer_name as string | null) ?? null,
          originAsn: r.origin_asn === null ? null : Number(r.origin_asn),
          routingCheck: r.routing_check !== false,
          checked: !!r.candidate,
          skipReason: r.candidate ? null : !r.routing_check ? 'Routing check turned off' : (skip ?? (['active', 'container'].includes(String(r.status)) ? 'Add your ASN to check it' : `Status ${String(r.status)}: not checked`)),
          running: r.check_status === 'running',
          level: (r.level as string | null) ?? null,
          checkedAt: (r.checked_at as string | null) ?? null,
          nextAt: (r.next_at as string | null) ?? null,
          error: (r.last_error as string | null) ?? null,
          data,
        };
      })
      // Long and private prefixes are listed only on the IPAM pages, not here.
      .filter((x) => x.checked || !routingSkipReason(x.prefix) || x.skipReason === 'Routing check turned off');
    const checked = items.filter((x) => x.checked && x.level);
    return {
      enabled: this.config.CDCIM_ROUTING_CHECK === 'true',
      source: 'RIPEstat: RIPE RIS route collectors, RIPE NCC RPKI validator, routing registries (IRR)',
      asns: asns.map((a) => ({
        id: a.id,
        asn: a.asn,
        name: a.name,
        notes: a.notes,
        checkedAt: a.checkedAt,
        nextAt: a.nextAt,
        running: a.status === 'running',
        error: a.lastError,
        data: a.data as AsnRoutingData | null,
        notInIpam: (a.data?.prefixes ?? []).filter((x) => !documented.has(x)),
      })),
      totals: {
        prefixes: items.filter((x) => x.checked).length,
        ok: checked.filter((x) => x.level === 'ok').length,
        warning: checked.filter((x) => x.level === 'warning').length,
        critical: checked.filter((x) => x.level === 'critical').length,
        pending: items.filter((x) => x.checked && !x.level).length,
      },
      items,
    };
  }

  async prefix(p: Principal, id: string) {
    const [row] = (
      await this.db.execute<Record<string, unknown>>(sql`
        select x.prefix::text as prefix, (${ROUTING_CANDIDATE}) as candidate, r.status, r.level, r.checked_at, r.next_at, r.data, r.last_error
          from prefixes x left join prefix_routing r on r.prefix_id = x.id where x.id = ${id} and x.org_id = ${p.orgId}`)
    ).rows;
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'Prefix not found' });
    return {
      checked: !!row.candidate,
      skipReason: row.candidate ? null : (routingSkipReason(String(row.prefix)) ?? 'Not checked: global table, status active or container, routing check on, and an ASN entered are needed'),
      running: row.status === 'running',
      level: (row.level as string | null) ?? null,
      checkedAt: (row.checked_at as string | null) ?? null,
      nextAt: (row.next_at as string | null) ?? null,
      error: (row.last_error as string | null) ?? null,
      data: (row.data as PrefixRoutingData | null) ?? null,
    };
  }

  async addAsn(p: Principal, input: BgpAsnInput, meta: RequestMeta) {
    try {
      const [row] = await this.db
        .insert(bgpAsns)
        .values({ orgId: p.orgId, asn: input.asn, name: input.name ?? null, notes: input.notes ?? null, nextAt: new Date() })
        .returning();
      // Prefixes are checked again against the new list of origins.
      await this.db.execute(sql`update prefix_routing set next_at = now() where org_id = ${p.orgId}`);
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'routing.asn_create', target: { type: 'bgp_asn', id: row!.id }, outcome: 'success', meta, metadata: { asn: input.asn } });
      return row;
    } catch (err) {
      if ((err as { code?: string }).code === '23505' || String((err as { cause?: { code?: string } }).cause?.code) === '23505') throw new BadRequestException({ error: 'duplicate', message: `AS${input.asn} is already added` });
      rethrowDbError(err);
    }
  }

  async updateAsn(p: Principal, id: string, input: BgpAsnInput, meta: RequestMeta) {
    const [row] = await this.db
      .update(bgpAsns)
      .set({ asn: input.asn, name: input.name ?? null, notes: input.notes ?? null, nextAt: new Date() })
      .where(and(eq(bgpAsns.id, id), eq(bgpAsns.orgId, p.orgId)))
      .returning();
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'ASN not found' });
    await this.db.execute(sql`update prefix_routing set next_at = now() where org_id = ${p.orgId}`);
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'routing.asn_update', target: { type: 'bgp_asn', id }, outcome: 'success', meta, metadata: { asn: input.asn } });
    return row;
  }

  async removeAsn(p: Principal, id: string, meta: RequestMeta) {
    const [row] = await this.db
      .delete(bgpAsns)
      .where(and(eq(bgpAsns.id, id), eq(bgpAsns.orgId, p.orgId)))
      .returning();
    if (!row) throw new NotFoundException({ error: 'not_found', message: 'ASN not found' });
    await this.db.execute(sql`update prefix_routing set next_at = now() where org_id = ${p.orgId}`);
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'routing.asn_delete', target: { type: 'bgp_asn', id }, outcome: 'success', meta, metadata: { asn: row.asn } });
  }

  /** Check now: one prefix, one ASN, or everything. */
  async checkNow(p: Principal, input: { prefixId?: string; asnId?: string }) {
    if (input.prefixId) {
      const [x] = await this.db
        .select({ id: prefixes.id, orgId: prefixes.orgId })
        .from(prefixes)
        .where(and(eq(prefixes.id, input.prefixId), eq(prefixes.orgId, p.orgId)));
      if (!x) throw new NotFoundException({ error: 'not_found', message: 'Prefix not found' });
      await this.db.execute(sql`insert into prefix_routing (prefix_id, org_id, next_at) values (${x.id}, ${p.orgId}, now()) on conflict (prefix_id) do update set next_at = now()`);
    } else if (input.asnId) {
      await this.db
        .update(bgpAsns)
        .set({ nextAt: new Date() })
        .where(and(eq(bgpAsns.id, input.asnId), eq(bgpAsns.orgId, p.orgId)));
    } else {
      await this.db.execute(sql`update prefix_routing set next_at = now() where org_id = ${p.orgId}`);
      await this.db.update(bgpAsns).set({ nextAt: new Date() }).where(eq(bgpAsns.orgId, p.orgId));
    }
    return { queued: true };
  }
}
