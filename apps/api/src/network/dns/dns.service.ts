import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { DnsServerInput, dnsZoneSchema } from '@crapplet/shared';
import { DB, type Db } from '../../db/db';
import { dnsServers, dnsZones, ipAddresses, type DnsServer } from '../../db/schema';
import { AuditService, actorFrom } from '../../audit/audit.service';
import { SecretBox } from '../../common/secret-box';
import { rethrowDbError } from '../../common/pg-errors';
import type { Principal, RequestMeta } from '../../auth/principal';
import { DiscoveryQueue } from '../discovery/queue';
import { notFound } from '../common';
import { dnsServerContext } from './context';

/**
 * DNS servers and zones that IPAM keeps records in. API keys are write-only
 * (encrypted, bound to the server row and its URL). The API never talks to a
 * DNS server: it marks addresses as pending and the worker pushes them, only
 * into enabled zones, and only touching records DCIM created.
 */
@Injectable()
export class DnsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
    private readonly queue: DiscoveryQueue,
  ) {}

  static view(s: DnsServer) {
    return { id: s.id, name: s.name, kind: s.kind, url: s.url, serverId: s.serverId, verifyTls: s.verifyTls, secretConfigured: true as const, lastTestAt: s.lastTestAt, lastTestOk: s.lastTestOk, lastTestMessage: s.lastTestMessage, updatedAt: s.updatedAt };
  }

  async listServers(p: Principal) {
    const rows = await this.db.select().from(dnsServers).where(eq(dnsServers.orgId, p.orgId)).orderBy(asc(dnsServers.name));
    return rows.map(DnsService.view);
  }

  private cols(input: DnsServerInput) {
    return input.kind === 'powerdns'
      ? { name: input.name, kind: input.kind, url: input.url.replace(/\/+$/, ''), serverId: input.serverId, verifyTls: input.verifyTls, secret: input.apiKey }
      : { name: input.name, kind: input.kind, url: null, serverId: null, verifyTls: true, secret: input.apiToken };
  }

  async createServer(p: Principal, input: DnsServerInput, meta: RequestMeta) {
    const { secret, ...c } = this.cols(input);
    const id = randomUUID();
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(dnsServers)
          .values({ ...c, id, orgId: p.orgId, secretEnc: this.secrets.encrypt(secret, dnsServerContext(p.orgId, id, c.kind, c.url)) })
          .returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'dns_server.create', target: { type: 'dns_server', id }, outcome: 'success', meta, metadata: { name: c.name, kind: c.kind, url: c.url } }, tx);
        return DnsService.view(row!);
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  /** Replaces settings and the key (the key must be entered again; it can't be read back). */
  async updateServer(p: Principal, id: string, input: DnsServerInput, meta: RequestMeta) {
    const before = await this.ownServer(p, id);
    if (before.kind !== input.kind) throw new BadRequestException({ error: 'kind_fixed', message: 'The server type cannot change; add a new server instead' });
    const { secret, ...c } = this.cols(input);
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(dnsServers)
          .set({ ...c, secretEnc: this.secrets.encrypt(secret, dnsServerContext(p.orgId, id, c.kind, c.url)), lastTestAt: null, lastTestOk: null, lastTestMessage: null })
          .where(eq(dnsServers.id, id))
          .returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'dns_server.update', target: { type: 'dns_server', id }, outcome: 'success', meta, metadata: { name: c.name, url: c.url } }, tx);
        return DnsService.view(row!);
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async deleteServer(p: Principal, id: string, meta: RequestMeta) {
    const s = await this.ownServer(p, id);
    try {
      await this.db.transaction(async (tx) => {
        await tx.delete(dnsServers).where(eq(dnsServers.id, id));
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'dns_server.delete', target: { type: 'dns_server', id }, outcome: 'success', meta, metadata: { name: s.name } }, tx);
      });
    } catch (err) {
      rethrowDbError(err, { fk: 'Remove this server’s zones first' });
    }
  }

  /** Queues a credential and zone check in the worker; the result appears on the server. */
  async testServer(p: Principal, id: string) {
    await this.ownServer(p, id);
    await this.db.update(dnsServers).set({ lastTestAt: null, lastTestOk: null, lastTestMessage: 'Checking…' }).where(eq(dnsServers.id, id));
    try {
      await this.queue.addJob('dns-test', { serverId: id });
    } catch {
      await this.db.update(dnsServers).set({ lastTestAt: new Date(), lastTestOk: false, lastTestMessage: 'The job queue (Redis) is unavailable; is the worker running?' }).where(eq(dnsServers.id, id));
    }
    return { queued: true };
  }

  private async ownServer(p: Principal, id: string) {
    const [s] = await this.db.select().from(dnsServers).where(and(eq(dnsServers.id, id), eq(dnsServers.orgId, p.orgId)));
    if (!s) throw notFound('DNS server');
    return s;
  }

  // ---------------------------------------------------------------- zones

  async listZones(p: Principal) {
    const rows = await this.db.execute(sql`
      select z.id, z.server_id, z.name, z.kind, z.provider_zone_id, z.ttl, z.enabled, z.updated_at, s.name as server_name, s.kind as server_kind,
             (select count(*)::int from ip_addresses a where a.org_id = z.org_id and a.dns_records @> jsonb_build_array(jsonb_build_object('zoneId', z.id::text))) as record_count
      from dns_zones z join dns_servers s on s.id = z.server_id where z.org_id = ${p.orgId} order by z.kind, z.name`);
    return (rows.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      serverId: r.server_id as string,
      serverName: r.server_name as string,
      serverKind: r.server_kind as string,
      name: r.name as string,
      kind: r.kind as 'forward' | 'reverse',
      providerZoneId: r.provider_zone_id as string | null,
      ttl: r.ttl as number,
      enabled: r.enabled as boolean,
      recordCount: r.record_count as number,
    }));
  }

  async saveZone(p: Principal, id: string | null, input: z.infer<typeof dnsZoneSchema>, meta: RequestMeta) {
    const server = await this.ownServer(p, input.serverId);
    if (server.kind === 'cloudflare' && !input.providerZoneId) throw new BadRequestException({ error: 'invalid_zone', message: 'Cloudflare zones need the zone ID (Zone overview → API)' });
    if (input.kind === 'reverse' && !/\.(in-addr|ip6)\.arpa$/.test(input.name)) throw new BadRequestException({ error: 'invalid_zone', message: 'A reverse zone ends in .in-addr.arpa or .ip6.arpa' });
    if (input.kind === 'forward' && /\.arpa$/.test(input.name)) throw new BadRequestException({ error: 'invalid_zone', message: '.arpa zones are reverse zones' });
    const cols = { serverId: input.serverId, name: input.name, kind: input.kind, providerZoneId: input.providerZoneId ?? null, ttl: input.ttl, enabled: input.enabled };
    try {
      return await this.db.transaction(async (tx) => {
        if (id) {
          const [before] = await tx.select().from(dnsZones).where(and(eq(dnsZones.id, id), eq(dnsZones.orgId, p.orgId))).for('update');
          if (!before) throw notFound('DNS zone');
          if ((before.name !== cols.name || before.serverId !== cols.serverId || (before.providerZoneId ?? null) !== cols.providerZoneId) && (await this.zoneInUse(tx, id))) {
            throw new ConflictException({ error: 'zone_in_use', message: 'DCIM has records in this zone; disable it instead of renaming or moving it' });
          }
        }
        const [row] = id ? await tx.update(dnsZones).set(cols).where(eq(dnsZones.id, id)).returning() : await tx.insert(dnsZones).values({ ...cols, orgId: p.orgId }).returning();
        // Any zone change can change where names belong (a new or re-enabled zone, a disabled one, a new TTL):
        // queue every published or named address for the worker to re-check.
        await tx.execute(sql`
          update ip_addresses set dns_status = 'pending', dns_error = null
          where org_id = ${p.orgId} and vrf_id is null and dns_status <> 'syncing'
            and (dns_name is not null or reverse_dns is not null or jsonb_array_length(dns_records) > 0)`);
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: id ? 'dns_zone.update' : 'dns_zone.create', target: { type: 'dns_zone', id: row!.id }, outcome: 'success', meta, metadata: { name: cols.name, kind: cols.kind, enabled: cols.enabled } }, tx);
        return row!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  private async zoneInUse(tx: Parameters<Parameters<Db['transaction']>[0]>[0], zoneId: string) {
    const r = await tx.execute(sql`select 1 from ip_addresses where dns_records @> jsonb_build_array(jsonb_build_object('zoneId', ${zoneId}::text)) limit 1`);
    return r.rows.length > 0;
  }

  async deleteZone(p: Principal, id: string, meta: RequestMeta) {
    await this.db.transaction(async (tx) => {
      const [z] = await tx.select().from(dnsZones).where(and(eq(dnsZones.id, id), eq(dnsZones.orgId, p.orgId))).for('update');
      if (!z) throw notFound('DNS zone');
      if (await this.zoneInUse(tx, id)) throw new ConflictException({ error: 'zone_in_use', message: 'DCIM still has records in this zone. Remove the names from those addresses (or release them) and let the sync finish, or disable the zone.' });
      await tx.delete(dnsZones).where(eq(dnsZones.id, id));
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'dns_zone.delete', target: { type: 'dns_zone', id }, outcome: 'success', meta, metadata: { name: z.name } }, tx);
    });
  }

  /** Marks every published address for a fresh push (after adding or enabling a zone). */
  async resyncAll(p: Principal, meta: RequestMeta) {
    const res = await this.db.execute(sql`
      update ip_addresses set dns_status = 'pending', dns_error = null
      where org_id = ${p.orgId} and vrf_id is null and (dns_name is not null or reverse_dns is not null or jsonb_array_length(dns_records) > 0)
      returning id`);
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'dns.resync', target: { type: 'organization', id: p.orgId }, outcome: 'success', meta, metadata: { addresses: res.rows.length } });
    return { pending: res.rows.length };
  }

  async resyncAddress(p: Principal, id: string) {
    const [row] = await this.db
      .update(ipAddresses)
      .set({ dnsStatus: 'pending', dnsError: null })
      .where(and(eq(ipAddresses.id, id), eq(ipAddresses.orgId, p.orgId)))
      .returning({ id: ipAddresses.id });
    if (!row) throw notFound('IP address');
    return { pending: true };
  }
}
