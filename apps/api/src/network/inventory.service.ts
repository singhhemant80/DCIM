import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { CABLEABLE_KINDS, NETWORK_CATEGORIES, type cableSchema, type cableUpdateSchema, type circuitSchema, type providerSchema, type vlanSchema, type vrfSchema } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { cableEnds, cables, circuitEvents, circuits, customers, datacenters, providers, vlans, vrfs } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';
import { notFound, ownCustomer, ownDatacenter, ownInterface } from './common';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

@Injectable()
export class NetworkInventoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  /** Runs a change and its audit record in one transaction and translates constraint errors. */
  private async write<T extends { id: string }>(p: Principal, meta: RequestMeta, action: string, targetType: string, fn: (tx: Tx) => Promise<T>, metadata: (r: T) => Record<string, unknown> = () => ({}), fk?: string): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        const r = await fn(tx);
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action, target: { type: targetType, id: r.id }, outcome: 'success', meta, metadata: metadata(r) }, tx);
        return r;
      });
    } catch (err) {
      rethrowDbError(err, { fk });
    }
  }

  // ---------------------------------------------------------------------------
  // Cables
  // ---------------------------------------------------------------------------

  async listCables(p: Principal, q: { deviceId?: string }) {
    const res = await this.db.execute(sql`
      select c.*, a.interface_id as a_id, ai.name as a_name, ad.id as a_device_id, coalesce(ad.hostname, ad.asset_tag) as a_device,
                  b.interface_id as b_id, bi.name as b_name, bd.id as b_device_id, coalesce(bd.hostname, bd.asset_tag) as b_device
      from cables c
      join cable_ends a on a.cable_id = c.id and a."end" = 'a'
      join cable_ends b on b.cable_id = c.id and b."end" = 'b'
      join interfaces ai on ai.id = a.interface_id join devices ad on ad.id = ai.device_id
      join interfaces bi on bi.id = b.interface_id join devices bd on bd.id = bi.device_id
      where c.org_id = ${p.orgId} ${q.deviceId ? sql`and (ad.id = ${q.deviceId} or bd.id = ${q.deviceId})` : sql``}
      order by a_device, a_name`);
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      type: r.type,
      status: r.status,
      label: r.label,
      color: r.color,
      lengthM: r.length_m === null ? null : Number(r.length_m),
      notes: r.notes,
      a: { interfaceId: r.a_id, interfaceName: r.a_name, deviceId: r.a_device_id, deviceName: r.a_device },
      b: { interfaceId: r.b_id, interfaceName: r.b_name, deviceId: r.b_device_id, deviceName: r.b_device },
    }));
  }

  async createCable(p: Principal, input: z.infer<typeof cableSchema>, meta: RequestMeta) {
    const [a, b] = await Promise.all([ownInterface(this.db, p, input.aInterfaceId), ownInterface(this.db, p, input.bInterfaceId)]);
    for (const i of [a, b]) {
      if (!CABLEABLE_KINDS.includes(i.kind)) throw new BadRequestException({ error: 'not_cableable', message: `${i.name} is a ${i.kind} interface; only physical or management ports take a cable` });
    }
    return this.write(
      p,
      meta,
      'cable.create',
      'cable',
      async (tx) => {
        const [c] = await tx
          .insert(cables)
          .values({ orgId: p.orgId, type: input.type ?? null, status: input.status, label: input.label ?? null, color: input.color ?? null, lengthM: input.lengthM == null ? null : String(input.lengthM), notes: input.notes ?? null })
          .returning();
        await tx.insert(cableEnds).values([
          { cableId: c!.id, end: 'a', interfaceId: a.id },
          { cableId: c!.id, end: 'b', interfaceId: b.id },
        ]);
        return c!;
      },
      () => ({ a: a.name, b: b.name }),
    );
  }

  async updateCable(p: Principal, id: string, input: z.infer<typeof cableUpdateSchema>, meta: RequestMeta) {
    await this.ownCable(p, id);
    return this.write(p, meta, 'cable.update', 'cable', async (tx) => {
      const [c] = await tx
        .update(cables)
        .set({ type: input.type ?? null, status: input.status, label: input.label ?? null, color: input.color ?? null, lengthM: input.lengthM == null ? null : String(input.lengthM), notes: input.notes ?? null })
        .where(eq(cables.id, id))
        .returning();
      return c!;
    });
  }

  async deleteCable(p: Principal, id: string, meta: RequestMeta) {
    await this.ownCable(p, id);
    await this.write(p, meta, 'cable.delete', 'cable', async (tx) => {
      await tx.delete(cables).where(eq(cables.id, id));
      return { id };
    });
  }

  private async ownCable(p: Principal, id: string) {
    const [c] = await this.db.select().from(cables).where(and(eq(cables.id, id), eq(cables.orgId, p.orgId)));
    if (!c) throw notFound('Cable');
    return c;
  }

  // ---------------------------------------------------------------------------
  // VLANs
  // ---------------------------------------------------------------------------

  async listVlans(p: Principal, q: { datacenterId?: string }) {
    const rows = await this.db
      .select({
        v: vlans,
        datacenterCode: datacenters.code,
        customerName: customers.name,
        ports: sql<number>`((select count(*) from interfaces i where i.untagged_vlan_id = "vlans"."id") + (select count(*) from interface_tagged_vlans t where t.vlan_id = "vlans"."id"))::int`,
        prefixCount: sql<number>`(select count(*)::int from prefixes x where x.vlan_id = "vlans"."id")`,
      })
      .from(vlans)
      .leftJoin(datacenters, eq(datacenters.id, vlans.datacenterId))
      .leftJoin(customers, eq(customers.id, vlans.customerId))
      .where(and(eq(vlans.orgId, p.orgId), q.datacenterId ? sql`(${vlans.datacenterId} = ${q.datacenterId} or ${vlans.datacenterId} is null)` : undefined))
      .orderBy(asc(vlans.vid), asc(datacenters.code));
    return rows.map((r) => ({ ...r.v, datacenterCode: r.datacenterCode, customerName: r.customerName, portCount: r.ports, prefixCount: r.prefixCount }));
  }

  async vlanPorts(p: Principal, id: string) {
    await this.ownVlan(p, id);
    const res = await this.db.execute(sql`
      select i.id, i.name, d.id as device_id, coalesce(d.hostname, d.asset_tag) as device_name,
             case when i.untagged_vlan_id = ${id} then 'untagged' else 'tagged' end as membership
      from interfaces i join devices d on d.id = i.device_id
      where i.org_id = ${p.orgId} and (i.untagged_vlan_id = ${id} or exists (select 1 from interface_tagged_vlans t where t.interface_id = i.id and t.vlan_id = ${id}))
      order by device_name, i.name`);
    return res.rows;
  }

  async createVlan(p: Principal, input: z.infer<typeof vlanSchema>, meta: RequestMeta) {
    await ownDatacenter(this.db, p, input.datacenterId);
    await ownCustomer(this.db, p, input.customerId);
    return this.write(p, meta, 'vlan.create', 'vlan', async (tx) => (await tx.insert(vlans).values({ ...this.vlanCols(input), orgId: p.orgId }).returning())[0]!, (r) => ({ vid: r.vid, name: r.name }));
  }

  async updateVlan(p: Principal, id: string, input: z.infer<typeof vlanSchema>, meta: RequestMeta) {
    const before = await this.ownVlan(p, id);
    await ownDatacenter(this.db, p, input.datacenterId);
    await ownCustomer(this.db, p, input.customerId);
    if ((input.datacenterId ?? null) !== before.datacenterId && input.datacenterId) {
      // Narrowing a VLAN to one datacenter must not strand ports in other sites.
      const res = await this.db.execute(sql`
        select count(*)::int as n from interfaces i
        join devices d on d.id = i.device_id
        left join racks r on r.id = d.rack_id left join rooms rm on rm.id = r.room_id left join buildings b on b.id = rm.building_id
        where (i.untagged_vlan_id = ${id} or exists (select 1 from interface_tagged_vlans t where t.interface_id = i.id and t.vlan_id = ${id}))
          and b.datacenter_id is distinct from ${input.datacenterId}`);
      const n = (res.rows[0] as { n: number }).n;
      if (n > 0) throw new ConflictException({ error: 'vlan_in_use', message: `${n} port(s) outside that datacenter use this VLAN` });
    }
    return this.write(p, meta, 'vlan.update', 'vlan', async (tx) => (await tx.update(vlans).set(this.vlanCols(input)).where(eq(vlans.id, id)).returning())[0]!, (r) => ({ vid: r.vid, name: r.name }));
  }

  async deleteVlan(p: Principal, id: string, meta: RequestMeta) {
    const v = await this.ownVlan(p, id);
    await this.write(p, meta, 'vlan.delete', 'vlan', async (tx) => (await tx.delete(vlans).where(eq(vlans.id, id)).returning())[0]!, () => ({ vid: v.vid, name: v.name }), 'Ports or prefixes still use this VLAN');
  }

  private vlanCols(i: z.infer<typeof vlanSchema>) {
    return { vid: i.vid, name: i.name, datacenterId: i.datacenterId ?? null, status: i.status, customerId: i.customerId ?? null, description: i.description ?? null };
  }

  private async ownVlan(p: Principal, id: string) {
    const [v] = await this.db.select().from(vlans).where(and(eq(vlans.id, id), eq(vlans.orgId, p.orgId)));
    if (!v) throw notFound('VLAN');
    return v;
  }

  // ---------------------------------------------------------------------------
  // VRFs
  // ---------------------------------------------------------------------------

  async listVrfs(p: Principal) {
    const rows = await this.db
      .select({ v: vrfs, prefixCount: sql<number>`(select count(*)::int from prefixes x where x.vrf_id = "vrfs"."id")`, addressCount: sql<number>`(select count(*)::int from ip_addresses a where a.vrf_id = "vrfs"."id" and a.status <> 'released')` })
      .from(vrfs)
      .where(eq(vrfs.orgId, p.orgId))
      .orderBy(asc(vrfs.name));
    return rows.map((r) => ({ ...r.v, prefixCount: r.prefixCount, addressCount: r.addressCount }));
  }

  async createVrf(p: Principal, input: z.infer<typeof vrfSchema>, meta: RequestMeta) {
    return this.write(p, meta, 'vrf.create', 'vrf', async (tx) => (await tx.insert(vrfs).values({ orgId: p.orgId, name: input.name, rd: input.rd ?? null, description: input.description ?? null }).returning())[0]!, (r) => ({ name: r.name }));
  }

  async updateVrf(p: Principal, id: string, input: z.infer<typeof vrfSchema>, meta: RequestMeta) {
    await this.ownVrf(p, id);
    return this.write(p, meta, 'vrf.update', 'vrf', async (tx) => (await tx.update(vrfs).set({ name: input.name, rd: input.rd ?? null, description: input.description ?? null }).where(eq(vrfs.id, id)).returning())[0]!);
  }

  async deleteVrf(p: Principal, id: string, meta: RequestMeta) {
    const v = await this.ownVrf(p, id);
    await this.write(p, meta, 'vrf.delete', 'vrf', async (tx) => (await tx.delete(vrfs).where(eq(vrfs.id, id)).returning())[0]!, () => ({ name: v.name }), 'Prefixes or addresses still use this VRF');
  }

  private async ownVrf(p: Principal, id: string) {
    const [v] = await this.db.select().from(vrfs).where(and(eq(vrfs.id, id), eq(vrfs.orgId, p.orgId)));
    if (!v) throw notFound('VRF');
    return v;
  }

  // ---------------------------------------------------------------------------
  // Providers and circuits
  // ---------------------------------------------------------------------------

  async listProviders(p: Principal) {
    const rows = await this.db
      .select({ pr: providers, circuitCount: sql<number>`(select count(*)::int from circuits c where c.provider_id = "providers"."id" and c.status <> 'decommissioned')` })
      .from(providers)
      .where(eq(providers.orgId, p.orgId))
      .orderBy(asc(providers.name));
    return rows.map((r) => ({ ...r.pr, circuitCount: r.circuitCount }));
  }

  async createProvider(p: Principal, input: z.infer<typeof providerSchema>, meta: RequestMeta) {
    return this.write(p, meta, 'provider.create', 'provider', async (tx) => (await tx.insert(providers).values({ ...this.providerCols(input), orgId: p.orgId }).returning())[0]!, (r) => ({ name: r.name }));
  }

  async updateProvider(p: Principal, id: string, input: z.infer<typeof providerSchema>, meta: RequestMeta) {
    await this.ownProvider(p, id);
    return this.write(p, meta, 'provider.update', 'provider', async (tx) => (await tx.update(providers).set(this.providerCols(input)).where(eq(providers.id, id)).returning())[0]!);
  }

  async deleteProvider(p: Principal, id: string, meta: RequestMeta) {
    const pr = await this.ownProvider(p, id);
    await this.write(p, meta, 'provider.delete', 'provider', async (tx) => (await tx.delete(providers).where(eq(providers.id, id)).returning())[0]!, () => ({ name: pr.name }), 'This provider still has circuits');
  }

  private providerCols(i: z.infer<typeof providerSchema>) {
    return { name: i.name, asn: i.asn ?? null, accountNumber: i.accountNumber ?? null, portalUrl: i.portalUrl ?? null, nocEmail: i.nocEmail ?? null, nocPhone: i.nocPhone ?? null, notes: i.notes ?? null };
  }

  private async ownProvider(p: Principal, id: string) {
    const [pr] = await this.db.select().from(providers).where(and(eq(providers.id, id), eq(providers.orgId, p.orgId)));
    if (!pr) throw notFound('Provider');
    return pr;
  }

  async listCircuits(p: Principal, q: { providerId?: string; status?: string }) {
    const res = await this.db.execute(sql`
      select c.*, pr.name as provider_name, pr.asn as provider_asn, dc.code as datacenter_code, cu.name as customer_name,
             i.name as interface_name, d.id as device_id, coalesce(d.hostname, d.asset_tag) as device_name
      from circuits c
      join providers pr on pr.id = c.provider_id
      left join datacenters dc on dc.id = c.datacenter_id
      left join customers cu on cu.id = c.customer_id
      left join interfaces i on i.id = c.interface_id
      left join devices d on d.id = i.device_id
      where c.org_id = ${p.orgId}
        ${q.providerId ? sql`and c.provider_id = ${q.providerId}` : sql``}
        ${q.status ? sql`and c.status = ${q.status}` : sql``}
      order by pr.name, c.cid`);
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      providerName: r.provider_name,
      providerAsn: r.provider_asn === null ? null : Number(r.provider_asn),
      cid: r.cid,
      type: r.type,
      status: r.status,
      commitBps: r.commit_bps === null ? null : Number(r.commit_bps),
      portSpeedBps: r.port_speed_bps === null ? null : Number(r.port_speed_bps),
      installDate: r.install_date,
      termEndDate: r.term_end_date,
      datacenterId: r.datacenter_id,
      datacenterCode: r.datacenter_code,
      interfaceId: r.interface_id,
      interfaceName: r.interface_name,
      deviceId: r.device_id,
      deviceName: r.device_name,
      zSide: r.z_side,
      customerId: r.customer_id,
      customerName: r.customer_name,
      description: r.description,
      notes: r.notes,
    }));
  }

  async circuitEventsFor(p: Principal, id: string) {
    await this.ownCircuit(p, id);
    return this.db.select().from(circuitEvents).where(eq(circuitEvents.circuitId, id)).orderBy(desc(circuitEvents.id)).limit(200);
  }

  async createCircuit(p: Principal, input: z.infer<typeof circuitSchema>, meta: RequestMeta) {
    await this.checkCircuitRefs(p, input);
    return this.write(
      p,
      meta,
      'circuit.create',
      'circuit',
      async (tx) => {
        const [c] = await tx.insert(circuits).values({ ...this.circuitCols(input), orgId: p.orgId }).returning();
        await tx.insert(circuitEvents).values({ orgId: p.orgId, circuitId: c!.id, kind: 'created', summary: `Circuit ${c!.cid} added (${c!.status})`, actorId: p.userId, actorLabel: p.email });
        return c!;
      },
      (r) => ({ cid: r.cid }),
    );
  }

  async updateCircuit(p: Principal, id: string, input: z.infer<typeof circuitSchema>, meta: RequestMeta) {
    const before = await this.ownCircuit(p, id);
    await this.checkCircuitRefs(p, input);
    return this.write(p, meta, 'circuit.update', 'circuit', async (tx) => {
      const [c] = await tx.update(circuits).set(this.circuitCols(input)).where(eq(circuits.id, id)).returning();
      const changes: string[] = [];
      if (before.status !== c!.status) changes.push(`status ${before.status} → ${c!.status}`);
      if (before.interfaceId !== c!.interfaceId) changes.push('termination port changed');
      if (before.commitBps !== c!.commitBps) changes.push('commitment changed');
      if (changes.length) await tx.insert(circuitEvents).values({ orgId: p.orgId, circuitId: id, kind: 'updated', summary: changes.join(', '), actorId: p.userId, actorLabel: p.email });
      return c!;
    });
  }

  async deleteCircuit(p: Principal, id: string, meta: RequestMeta) {
    const c = await this.ownCircuit(p, id);
    if (c.status !== 'decommissioned' && c.status !== 'planned') throw new ConflictException({ error: 'circuit_active', message: 'Mark the circuit decommissioned before deleting it (its history is kept until then)' });
    await this.write(p, meta, 'circuit.delete', 'circuit', async (tx) => (await tx.delete(circuits).where(eq(circuits.id, id)).returning())[0]!, () => ({ cid: c.cid }));
  }

  private circuitCols(i: z.infer<typeof circuitSchema>) {
    return {
      providerId: i.providerId,
      cid: i.cid,
      type: i.type,
      status: i.status,
      commitBps: i.commitBps ?? null,
      portSpeedBps: i.portSpeedBps ?? null,
      installDate: i.installDate ?? null,
      termEndDate: i.termEndDate ?? null,
      datacenterId: i.datacenterId ?? null,
      interfaceId: i.interfaceId ?? null,
      zSide: i.zSide ?? null,
      customerId: i.customerId ?? null,
      description: i.description ?? null,
      notes: i.notes ?? null,
    };
  }

  private async checkCircuitRefs(p: Principal, i: z.infer<typeof circuitSchema>) {
    await this.ownProvider(p, i.providerId).catch(() => {
      throw new BadRequestException({ error: 'invalid_provider', message: 'Provider does not exist' });
    });
    await ownDatacenter(this.db, p, i.datacenterId);
    await ownCustomer(this.db, p, i.customerId);
    if (i.interfaceId) await ownInterface(this.db, p, i.interfaceId);
  }

  private async ownCircuit(p: Principal, id: string) {
    const [c] = await this.db.select().from(circuits).where(and(eq(circuits.id, id), eq(circuits.orgId, p.orgId)));
    if (!c) throw notFound('Circuit');
    return c;
  }

  // ---------------------------------------------------------------------------
  // Topology
  // ---------------------------------------------------------------------------

  /**
   * Nodes and links built only from verifiable sources: documented cables,
   * discovered LLDP/CDP neighbors, and circuits to providers. Nothing is
   * inferred. Each link says where it came from; a discovered neighbor that
   * we can't match to a known device becomes an "unknown" node.
   */
  async topology(p: Principal, q: { datacenterId?: string }) {
    const devRes = await this.db.execute(sql`
      select d.id, coalesce(d.hostname, d.asset_tag) as name, d.category, d.platform, d.network_role, d.mgmt_address,
             b.datacenter_id, dc.code as datacenter_code, r.name as rack_name
      from devices d
      left join racks r on r.id = d.rack_id left join rooms rm on rm.id = r.room_id
      left join buildings b on b.id = rm.building_id left join datacenters dc on dc.id = b.datacenter_id
      where d.org_id = ${p.orgId} and d.lifecycle_state <> 'retired'
        and (d.category in (${sql.join(NETWORK_CATEGORIES.map((c) => sql`${c}`), sql`, `)}) or exists (select 1 from interfaces i join cable_ends ce on ce.interface_id = i.id where i.device_id = d.id))
        ${q.datacenterId ? sql`and b.datacenter_id = ${q.datacenterId}` : sql``}`);
    const nodes = (devRes.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      kind: 'device' as const,
      label: r.name as string,
      category: r.category as string,
      platform: r.platform as string | null,
      role: r.network_role as string | null,
      datacenterCode: r.datacenter_code as string | null,
      rackName: r.rack_name as string | null,
    }));
    const nodeIds = new Set(nodes.map((n) => n.id));

    const cableRes = await this.db.execute(sql`
      select c.id, c.status, c.type, ai.device_id as a_dev, ai.name as a_port, bi.device_id as b_dev, bi.name as b_port, ai.speed_bps as a_speed, bi.speed_bps as b_speed,
             ai.id as a_if, bi.id as b_if
      from cables c
      join cable_ends a on a.cable_id = c.id and a."end" = 'a' join interfaces ai on ai.id = a.interface_id
      join cable_ends b on b.cable_id = c.id and b."end" = 'b' join interfaces bi on bi.id = b.interface_id
      where c.org_id = ${p.orgId}`);
    type Link = { id: string; source: string; target: string; sourcePort: string; targetPort: string; kind: 'cable' | 'neighbor' | 'circuit'; status: string; verifiedByNeighbor?: boolean; speedBps?: number | null; label?: string };
    const links: Link[] = [];
    const cablePairs = new Map<string, Link>();
    for (const r of cableRes.rows as Record<string, string>[]) {
      if (!nodeIds.has(r.a_dev!) || !nodeIds.has(r.b_dev!)) continue;
      const link: Link = { id: `cable:${r.id}`, source: r.a_dev!, target: r.b_dev!, sourcePort: r.a_port!, targetPort: r.b_port!, kind: 'cable', status: r.status!, verifiedByNeighbor: false, speedBps: r.a_speed ? Number(r.a_speed) : r.b_speed ? Number(r.b_speed) : null };
      cablePairs.set([r.a_if, r.b_if].sort().join('|'), link);
      links.push(link);
    }

    const obsRes = await this.db.execute(sql`
      select n.id, n.protocol, n.remote_system_name, n.remote_port_id, n.remote_chassis_id, n.matched_interface_id, n.last_seen_at,
             li.device_id as local_dev, li.name as local_port, li.id as local_if, mi.device_id as remote_dev, mi.name as remote_port
      from neighbor_observations n
      join interfaces li on li.id = n.interface_id
      left join interfaces mi on mi.id = n.matched_interface_id
      where n.org_id = ${p.orgId}`);
    const seenNeighborPairs = new Set<string>();
    for (const r of obsRes.rows as Record<string, string | null>[]) {
      if (!nodeIds.has(r.local_dev!)) continue;
      if (r.remote_dev && r.local_if && r.matched_interface_id) {
        const pair = [r.local_if, r.matched_interface_id].sort().join('|');
        const cabled = cablePairs.get(pair);
        if (cabled) {
          cabled.verifiedByNeighbor = true;
          continue;
        }
        if (seenNeighborPairs.has(pair) || !nodeIds.has(r.remote_dev)) continue;
        seenNeighborPairs.add(pair);
        links.push({ id: `nbr:${r.id}`, source: r.local_dev!, target: r.remote_dev, sourcePort: r.local_port!, targetPort: r.remote_port ?? r.remote_port_id ?? '', kind: 'neighbor', status: `seen via ${r.protocol?.toUpperCase()}` });
      } else {
        // Neighbor we don't have in inventory: show it honestly as unknown.
        const unknownId = `unknown:${r.remote_chassis_id || r.remote_system_name}`;
        if (!nodeIds.has(unknownId)) {
          nodes.push({ id: unknownId, kind: 'device', label: r.remote_system_name || r.remote_chassis_id || 'Unknown device', category: 'unknown', platform: null, role: null, datacenterCode: null, rackName: null });
          nodeIds.add(unknownId);
        }
        links.push({ id: `nbr:${r.id}`, source: r.local_dev!, target: unknownId, sourcePort: r.local_port!, targetPort: r.remote_port_id ?? '', kind: 'neighbor', status: `seen via ${r.protocol?.toUpperCase()}, not in inventory` });
      }
    }

    const circRes = await this.db.execute(sql`
      select c.id, c.cid, c.type, c.status, c.commit_bps, c.port_speed_bps, pr.id as provider_id, pr.name as provider_name, pr.asn, i.device_id, i.name as port
      from circuits c join providers pr on pr.id = c.provider_id join interfaces i on i.id = c.interface_id
      where c.org_id = ${p.orgId} and c.status <> 'decommissioned'`);
    for (const r of circRes.rows as Record<string, string | null>[]) {
      if (!nodeIds.has(r.device_id!)) continue;
      const pid = `provider:${r.provider_id}`;
      if (!nodeIds.has(pid)) {
        nodes.push({ id: pid, kind: 'device', label: `${r.provider_name}${r.asn ? ` (AS${r.asn})` : ''}`, category: 'provider', platform: null, role: null, datacenterCode: null, rackName: null });
        nodeIds.add(pid);
      }
      links.push({ id: `circuit:${r.id}`, source: r.device_id!, target: pid, sourcePort: r.port!, targetPort: r.cid!, kind: 'circuit', status: r.status!, speedBps: r.port_speed_bps ? Number(r.port_speed_bps) : null, label: r.cid! });
    }
    return { nodes, links, generatedAt: new Date().toISOString() };
  }

  /** Counts for the overview dashboard. */
  async summary(p: Principal) {
    const res = await this.db.execute(sql`
      select
        (select count(*)::int from devices d where d.org_id = ${p.orgId} and d.lifecycle_state <> 'retired' and d.category in (${sql.join(NETWORK_CATEGORIES.map((c) => sql`${c}`), sql`, `)})) as network_devices,
        (select count(*)::int from interfaces where org_id = ${p.orgId}) as interfaces,
        (select count(*)::int from interfaces where org_id = ${p.orgId} and kind in ('physical','management')) as physical_interfaces,
        (select count(*)::int from cables where org_id = ${p.orgId}) as cables,
        (select count(*)::int from vlans where org_id = ${p.orgId}) as vlans,
        (select count(*)::int from circuits where org_id = ${p.orgId} and status = 'active') as active_circuits,
        (select coalesce(sum(commit_bps), 0)::bigint from circuits where org_id = ${p.orgId} and status = 'active' and type in ('internet_transit','ip_peering')) as committed_bps`);
    const r = res.rows[0] as Record<string, number | string>;
    return {
      networkDevices: Number(r.network_devices),
      interfaces: Number(r.interfaces),
      physicalInterfaces: Number(r.physical_interfaces),
      cables: Number(r.cables),
      vlans: Number(r.vlans),
      activeCircuits: Number(r.active_circuits),
      committedTransitBps: Number(r.committed_bps),
    };
  }
}
