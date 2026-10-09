import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import {
  CABLEABLE_KINDS,
  NETWORK_CATEGORIES,
  expandInterfacePattern,
  type InterfaceInput,
  type interfaceBulkCreateSchema,
  type networkDetailsSchema,
} from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import {
  buildings,
  cableEnds,
  cables,
  circuits,
  datacenters,
  deviceCredentials,
  deviceModels,
  devices,
  discoveryRuns,
  interfaceTaggedVlans,
  interfaces,
  ipAddresses,
  manufacturers,
  neighborObservations,
  providers,
  racks,
  rooms,
  vlans,
  type Interface,
} from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';
import { deviceDatacenterId, like, notFound, ownDevice, ownInterface, ownVlans } from './common';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Network inventory: which devices are network gear, their ports (physical
 * and logical), LAG membership, VLAN assignment, and what is attached to each
 * port (cable peer, circuit, discovered neighbor, IP addresses).
 */
@Injectable()
export class InterfacesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Network devices
  // ---------------------------------------------------------------------------

  async listNetworkDevices(p: Principal, q: { q?: string; datacenterId?: string; all?: string }) {
    const conds: SQL[] = [eq(devices.orgId, p.orgId), sql`${devices.lifecycleState} <> 'retired'`];
    // By default network categories, plus any device that already has interfaces documented.
    if (q.all !== 'true') {
      conds.push(or(inArray(devices.category, [...NETWORK_CATEGORIES]), sql`exists (select 1 from interfaces i where i.device_id = "devices"."id")`)!);
    }
    if (q.q) conds.push(or(ilike(devices.hostname, like(q.q)), ilike(devices.assetTag, like(q.q)), ilike(devices.mgmtAddress, like(q.q)), ilike(deviceModels.name, like(q.q)))!);
    if (q.datacenterId) conds.push(eq(datacenters.id, q.datacenterId));
    const rows = await this.db
      .select({
        id: devices.id,
        assetTag: devices.assetTag,
        hostname: devices.hostname,
        category: devices.category,
        platform: devices.platform,
        networkRole: devices.networkRole,
        mgmtAddress: devices.mgmtAddress,
        os: devices.os,
        lifecycleState: devices.lifecycleState,
        modelName: deviceModels.name,
        manufacturerName: manufacturers.name,
        rackName: racks.name,
        positionU: devices.positionU,
        datacenterCode: datacenters.code,
        datacenterId: datacenters.id,
        interfaceCount: sql<number>`(select count(*)::int from interfaces i where i.device_id = "devices"."id")`,
        physicalCount: sql<number>`(select count(*)::int from interfaces i where i.device_id = "devices"."id" and i.kind in ('physical','management'))`,
        cabledCount: sql<number>`(select count(*)::int from interfaces i join cable_ends ce on ce.interface_id = i.id where i.device_id = "devices"."id")`,
        credentialKinds: sql<string[]>`coalesce((select array_agg(c.kind::text order by c.kind) from device_credentials c where c.device_id = "devices"."id"), '{}')`,
        lastDiscovery: sql<{ status: string; finishedAt: string | null; mode: string } | null>`(select json_build_object('status', r.status, 'finishedAt', r.finished_at, 'mode', r.mode) from discovery_runs r where r.device_id = "devices"."id" order by r.created_at desc limit 1)`,
      })
      .from(devices)
      .innerJoin(deviceModels, eq(deviceModels.id, devices.modelId))
      .innerJoin(manufacturers, eq(manufacturers.id, deviceModels.manufacturerId))
      .leftJoin(racks, eq(racks.id, devices.rackId))
      .leftJoin(rooms, eq(rooms.id, racks.roomId))
      .leftJoin(buildings, eq(buildings.id, rooms.buildingId))
      .leftJoin(datacenters, eq(datacenters.id, buildings.datacenterId))
      .where(and(...conds))
      .orderBy(asc(datacenters.code), asc(devices.hostname), asc(devices.assetTag));
    return rows;
  }

  async deviceSummary(p: Principal, deviceId: string) {
    const [row] = await this.listNetworkDevices(p, { all: 'true' }).then((list) => list.filter((d) => d.id === deviceId));
    if (!row) throw notFound('Device');
    const [credRows, runs] = await Promise.all([
      this.db
        .select({
          id: deviceCredentials.id,
          kind: deviceCredentials.kind,
          host: deviceCredentials.host,
          port: deviceCredentials.port,
          username: deviceCredentials.username,
          params: deviceCredentials.params,
          lastTestAt: deviceCredentials.lastTestAt,
          lastTestOk: deviceCredentials.lastTestOk,
          lastTestMessage: deviceCredentials.lastTestMessage,
          rotatedAt: deviceCredentials.rotatedAt,
        })
        .from(deviceCredentials)
        .where(eq(deviceCredentials.deviceId, deviceId))
        .orderBy(asc(deviceCredentials.kind)),
      this.db
        .select({
          id: discoveryRuns.id,
          mode: discoveryRuns.mode,
          status: discoveryRuns.status,
          credentialKind: discoveryRuns.credentialKind,
          createdAt: discoveryRuns.createdAt,
          finishedAt: discoveryRuns.finishedAt,
          error: discoveryRuns.error,
          appliedAt: discoveryRuns.appliedAt,
          requestedLabel: discoveryRuns.requestedLabel,
        })
        .from(discoveryRuns)
        .where(eq(discoveryRuns.deviceId, deviceId))
        .orderBy(sql`${discoveryRuns.createdAt} desc`)
        .limit(10),
    ]);
    // Facts from the most recent successful discovery (never shown as live data).
    const [facts] = await this.db
      .select({ result: discoveryRuns.result, finishedAt: discoveryRuns.finishedAt, credentialKind: discoveryRuns.credentialKind })
      .from(discoveryRuns)
      .where(and(eq(discoveryRuns.deviceId, deviceId), eq(discoveryRuns.status, 'succeeded'), eq(discoveryRuns.mode, 'discover')))
      .orderBy(sql`${discoveryRuns.finishedAt} desc`)
      .limit(1);
    return {
      device: row,
      credentials: credRows.map((c) => ({ ...c, secretConfigured: true })),
      runs,
      lastCollected: facts
        ? {
            at: facts.finishedAt,
            source: facts.credentialKind,
            facts: (facts.result as { facts?: unknown })?.facts ?? null,
            bgp: (facts.result as { bgp?: unknown[] })?.bgp ?? [],
            warnings: (facts.result as { warnings?: string[] })?.warnings ?? [],
          }
        : null,
    };
  }

  async setNetworkDetails(p: Principal, deviceId: string, input: z.infer<typeof networkDetailsSchema>, meta: RequestMeta) {
    const d = await ownDevice(this.db, p, deviceId);
    await this.db.transaction(async (tx) => {
      await tx.update(devices).set({ platform: input.platform ?? null, networkRole: input.networkRole ?? null }).where(eq(devices.id, deviceId));
      await this.audit.record(
        { orgId: p.orgId, actor: actorFrom(p), customerId: d.customerId, action: 'device.network_details', target: { type: 'device', id: deviceId }, outcome: 'success', meta, metadata: { before: { platform: d.platform, networkRole: d.networkRole }, after: input } },
        tx,
      );
    });
    return this.deviceSummary(p, deviceId);
  }

  // ---------------------------------------------------------------------------
  // Interfaces
  // ---------------------------------------------------------------------------

  async listForDevice(p: Principal, deviceId: string) {
    await ownDevice(this.db, p, deviceId);
    return this.views(p, sql`i.device_id = ${deviceId}`);
  }

  async get(p: Principal, id: string) {
    const [v] = await this.views(p, sql`i.id = ${id}`);
    if (!v) throw notFound('Interface');
    return v;
  }

  /** Interface rows with everything attached to them, in natural port order. */
  private async views(p: Principal, where: SQL) {
    const res = await this.db.execute(sql`
      select i.*, coalesce(d.hostname, d.asset_tag) as device_name,
             lag.name as lag_name, parent.name as parent_name,
             uv.vid as untagged_vid, uv.name as untagged_name,
             c.id as cable_id, c.status as cable_status, c.type as cable_type, c.label as cable_label,
             pi.id as peer_interface_id, pi.name as peer_interface_name,
             pd.id as peer_device_id, coalesce(pd.hostname, pd.asset_tag) as peer_device_name,
             ci.id as circuit_id, ci.cid as circuit_cid, pr.name as circuit_provider
      from interfaces i
      join devices d on d.id = i.device_id
      left join interfaces lag on lag.id = i.lag_id
      left join interfaces parent on parent.id = i.parent_id
      left join vlans uv on uv.id = i.untagged_vlan_id
      left join cable_ends ce on ce.interface_id = i.id
      left join cables c on c.id = ce.cable_id
      left join cable_ends pe on pe.cable_id = ce.cable_id and pe."end" <> ce."end"
      left join interfaces pi on pi.id = pe.interface_id
      left join devices pd on pd.id = pi.device_id
      left join circuits ci on ci.interface_id = i.id and ci.status <> 'decommissioned'
      left join providers pr on pr.id = ci.provider_id
      where i.org_id = ${p.orgId} and ${where}`);
    type Raw = Record<string, unknown> & { id: string };
    const rows = (res.rows as Raw[]).map((r) => ({
      i: {
        id: r.id,
        deviceId: r.device_id as string,
        name: r.name as string,
        kind: r.kind as Interface['kind'],
        media: r.media as Interface['media'],
        description: r.description as string | null,
        macAddress: r.mac_address as string | null,
        mtu: r.mtu as number | null,
        speedBps: r.speed_bps === null ? null : Number(r.speed_bps),
        enabled: r.enabled as boolean,
        lagId: r.lag_id as string | null,
        parentId: r.parent_id as string | null,
        mode: r.mode as Interface['mode'],
        untaggedVlanId: r.untagged_vlan_id as string | null,
        ifIndex: r.if_index as number | null,
        monitored: r.monitored as boolean,
        countInTotals: r.count_in_totals as boolean,
        discoveredAt: r.discovered_at as Date | null,
      },
      deviceName: r.device_name as string,
      lagName: r.lag_name as string | null,
      parentName: r.parent_name as string | null,
      untaggedVid: r.untagged_vid as number | null,
      untaggedName: r.untagged_name as string | null,
      cableId: r.cable_id as string | null,
      cableStatus: r.cable_status as string | null,
      cableType: r.cable_type as string | null,
      cableLabel: r.cable_label as string | null,
      peerInterfaceId: r.peer_interface_id as string | null,
      peerInterfaceName: r.peer_interface_name as string | null,
      peerDeviceId: r.peer_device_id as string | null,
      peerDeviceName: r.peer_device_name as string | null,
      circuitId: r.circuit_id as string | null,
      circuitCid: r.circuit_cid as string | null,
      circuitProvider: r.circuit_provider as string | null,
    }));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.i.id);
    const [tagged, neighbors, ips, members] = await Promise.all([
      this.db
        .select({ interfaceId: interfaceTaggedVlans.interfaceId, id: vlans.id, vid: vlans.vid, name: vlans.name })
        .from(interfaceTaggedVlans)
        .innerJoin(vlans, eq(vlans.id, interfaceTaggedVlans.vlanId))
        .where(inArray(interfaceTaggedVlans.interfaceId, ids))
        .orderBy(asc(vlans.vid)),
      this.db
        .select({
          n: neighborObservations,
          matchedInterfaceName: sql<string | null>`(select mi.name from interfaces mi where mi.id = ${neighborObservations.matchedInterfaceId})`,
          matchedDeviceId: sql<string | null>`(select mi.device_id from interfaces mi where mi.id = ${neighborObservations.matchedInterfaceId})`,
        })
        .from(neighborObservations)
        .where(inArray(neighborObservations.interfaceId, ids)),
      this.db
        .select({ interfaceId: ipAddresses.interfaceId, id: ipAddresses.id, address: ipAddresses.address, prefixLength: ipAddresses.prefixLength, status: ipAddresses.status })
        .from(ipAddresses)
        .where(and(inArray(ipAddresses.interfaceId, ids), sql`${ipAddresses.status} <> 'released'`)),
      this.db.select({ lagId: interfaces.lagId, id: interfaces.id, name: interfaces.name }).from(interfaces).where(inArray(interfaces.lagId, ids)),
    ]);
    const views = rows.map((r) => ({
      id: r.i.id,
      deviceId: r.i.deviceId,
      deviceName: r.deviceName,
      name: r.i.name,
      kind: r.i.kind,
      media: r.i.media,
      description: r.i.description,
      macAddress: r.i.macAddress,
      mtu: r.i.mtu,
      speedBps: r.i.speedBps,
      enabled: r.i.enabled,
      lag: r.i.lagId ? { id: r.i.lagId, name: r.lagName } : null,
      members: members.filter((m) => m.lagId === r.i.id).map((m) => ({ id: m.id, name: m.name })),
      parent: r.i.parentId ? { id: r.i.parentId, name: r.parentName } : null,
      mode: r.i.mode,
      untaggedVlan: r.i.untaggedVlanId ? { id: r.i.untaggedVlanId, vid: r.untaggedVid, name: r.untaggedName } : null,
      taggedVlans: tagged.filter((t) => t.interfaceId === r.i.id).map(({ id, vid, name }) => ({ id, vid, name })),
      ifIndex: r.i.ifIndex,
      monitored: r.i.monitored,
      countInTotals: r.i.countInTotals,
      discoveredAt: r.i.discoveredAt,
      cable: r.cableId
        ? { id: r.cableId, status: r.cableStatus, type: r.cableType, label: r.cableLabel, peer: r.peerInterfaceId ? { interfaceId: r.peerInterfaceId, interfaceName: r.peerInterfaceName, deviceId: r.peerDeviceId, deviceName: r.peerDeviceName } : null }
        : null,
      circuit: r.circuitId ? { id: r.circuitId, cid: r.circuitCid, provider: r.circuitProvider } : null,
      neighbors: neighbors
        .filter((n) => n.n.interfaceId === r.i.id)
        .map(({ n, matchedInterfaceName, matchedDeviceId }) => ({
          protocol: n.protocol,
          remoteSystemName: n.remoteSystemName,
          remotePortId: n.remotePortId,
          remotePortDescription: n.remotePortDescription,
          remoteChassisId: n.remoteChassisId,
          remoteMgmtAddress: n.remoteMgmtAddress,
          lastSeenAt: n.lastSeenAt,
          matched: n.matchedInterfaceId ? { interfaceId: n.matchedInterfaceId, interfaceName: matchedInterfaceName, deviceId: matchedDeviceId } : null,
        })),
      ipAddresses: ips.filter((x) => x.interfaceId === r.i.id).map(({ id, address, prefixLength, status }) => ({ id, address: address.split('/')[0], prefixLength, status })),
    }));
    return views.sort((a, b) => naturalCompare(a.name, b.name));
  }

  async create(p: Principal, input: InterfaceInput, meta: RequestMeta) {
    const device = await ownDevice(this.db, p, input.deviceId);
    try {
      const id = await this.db.transaction(async (tx) => {
        await this.checkRelations(tx, p, input, null);
        const [row] = await tx.insert(interfaces).values({ ...this.cols(input), orgId: p.orgId, deviceId: input.deviceId }).returning();
        await this.setTagged(tx, row!.id, input);
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: device.customerId, action: 'interface.create', target: { type: 'interface', id: row!.id }, outcome: 'success', meta, metadata: { device: device.assetTag, name: row!.name, kind: row!.kind } }, tx);
        return row!.id;
      });
      return this.get(p, id);
    } catch (err) {
      rethrowDbError(err);
    }
  }

  /** Creates many ports at once from a pattern such as "ether[1-12]". Existing names are skipped. */
  async bulkCreate(p: Principal, input: z.infer<typeof interfaceBulkCreateSchema>, meta: RequestMeta) {
    const device = await ownDevice(this.db, p, input.deviceId);
    let names: string[];
    try {
      names = expandInterfacePattern(input.pattern);
    } catch (e) {
      throw new BadRequestException({ error: 'invalid_pattern', message: (e as Error).message });
    }
    if (names.some((n) => !n.trim() || n.length > 64)) throw new BadRequestException({ error: 'invalid_pattern', message: 'Interface names must be 1–64 characters' });
    try {
      return await this.db.transaction(async (tx) => {
        const existing = new Set((await tx.select({ name: interfaces.name }).from(interfaces).where(eq(interfaces.deviceId, input.deviceId))).map((r) => r.name.toLowerCase()));
        const fresh = names.filter((n) => !existing.has(n.toLowerCase()));
        if (fresh.length) {
          await tx.insert(interfaces).values(
            fresh.map((name) => ({ orgId: p.orgId, deviceId: input.deviceId, name, kind: input.kind, media: input.media ?? null, speedBps: input.speedBps ?? null, countInTotals: false })),
          );
        }
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId: device.customerId, action: 'interface.bulk_create', target: { type: 'device', id: input.deviceId }, outcome: 'success', meta, metadata: { pattern: input.pattern, created: fresh.length, skipped: names.length - fresh.length } }, tx);
        return { created: fresh.length, skipped: names.length - fresh.length };
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async update(p: Principal, id: string, input: InterfaceInput, meta: RequestMeta) {
    const before = await ownInterface(this.db, p, id);
    if (before.deviceId !== input.deviceId) throw new BadRequestException({ error: 'interface_device_fixed', message: 'An interface cannot move to another device' });
    try {
      await this.db.transaction(async (tx) => {
        await this.checkRelations(tx, p, input, id);
        const [after] = await tx.update(interfaces).set(this.cols(input)).where(eq(interfaces.id, id)).returning();
        await this.setTagged(tx, id, input);
        const changed = Object.keys(this.cols(input)).filter((k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]));
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'interface.update', target: { type: 'interface', id }, outcome: 'success', meta, metadata: { name: after!.name, fields: changed } }, tx);
      });
    } catch (err) {
      rethrowDbError(err);
    }
    return this.get(p, id);
  }

  async remove(p: Principal, id: string, meta: RequestMeta) {
    const i = await ownInterface(this.db, p, id);
    try {
      await this.db.transaction(async (tx) => {
        const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(ipAddresses).where(and(eq(ipAddresses.interfaceId, id), sql`${ipAddresses.status} <> 'released'`));
        if (n > 0) throw new ConflictException({ error: 'interface_in_use', message: `${n} IP address(es) are bound to this interface; release or move them first` });
        await tx.delete(interfaces).where(eq(interfaces.id, id));
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'interface.delete', target: { type: 'interface', id }, outcome: 'success', meta, metadata: { name: i.name } }, tx);
      });
    } catch (err) {
      rethrowDbError(err, { fk: 'This port has a cable; remove the cable first' });
    }
  }

  // ---------------------------------------------------------------------------

  private cols(i: InterfaceInput) {
    const vlanCapable = i.mode !== null && i.mode !== undefined;
    return {
      name: i.name,
      kind: i.kind,
      media: i.media ?? null,
      description: i.description ?? null,
      macAddress: i.macAddress ?? null,
      mtu: i.mtu ?? null,
      speedBps: i.speedBps ?? null,
      enabled: i.enabled,
      lagId: i.lagId ?? null,
      parentId: i.parentId ?? null,
      mode: i.mode ?? null,
      untaggedVlanId: vlanCapable && i.mode !== 'tagged_all' ? (i.untaggedVlanId ?? null) : (i.untaggedVlanId ?? null),
      monitored: i.monitored,
      countInTotals: i.countInTotals,
    };
  }

  private async checkRelations(tx: Tx, p: Principal, input: InterfaceInput, selfId: string | null) {
    if (input.lagId) await ownInterface(tx, p, input.lagId);
    if (input.parentId) await ownInterface(tx, p, input.parentId);
    if (input.lagId && (input.kind === 'lag' || !CABLEABLE_KINDS.includes(input.kind))) {
      throw new BadRequestException({ error: 'invalid_lag_member', message: 'Only physical ports can be LAG members' });
    }
    if (input.mode === 'access' && input.taggedVlanIds.length) throw new BadRequestException({ error: 'invalid_vlans', message: 'An access port carries one untagged VLAN and no tagged VLANs' });
    if (!input.mode && (input.untaggedVlanId || input.taggedVlanIds.length)) throw new BadRequestException({ error: 'invalid_vlans', message: 'Choose a VLAN mode before assigning VLANs' });
    if (input.mode === 'tagged_all' && input.taggedVlanIds.length) throw new BadRequestException({ error: 'invalid_vlans', message: 'A trunk carrying all VLANs takes no explicit tagged list' });
    if (input.untaggedVlanId && input.taggedVlanIds.includes(input.untaggedVlanId)) throw new BadRequestException({ error: 'invalid_vlans', message: 'A VLAN cannot be both untagged and tagged on the same port' });
    if (selfId && input.lagId === selfId) throw new BadRequestException({ error: 'invalid_lag_member', message: 'A port cannot be a member of itself' });
    const vlanRows = await ownVlans(tx, p, [...input.taggedVlanIds, ...(input.untaggedVlanId ? [input.untaggedVlanId] : [])]);
    const scoped = vlanRows.filter((v) => v.datacenterId);
    if (scoped.length) {
      const dc = await deviceDatacenterId(tx, input.deviceId);
      const wrong = scoped.filter((v) => v.datacenterId !== dc);
      if (wrong.length) {
        throw new BadRequestException({ error: 'vlan_scope', message: `VLAN ${wrong[0]!.vid} (${wrong[0]!.name}) belongs to another datacenter${dc ? '' : '; this device is not installed in a rack yet'}` });
      }
    }
  }

  private async setTagged(tx: Tx, id: string, input: InterfaceInput) {
    await tx.delete(interfaceTaggedVlans).where(eq(interfaceTaggedVlans.interfaceId, id));
    const ids = [...new Set(input.taggedVlanIds)];
    if (ids.length) await tx.insert(interfaceTaggedVlans).values(ids.map((vlanId) => ({ interfaceId: id, vlanId })));
  }
}

/** Sorts ether2 before ether10 and Ethernet1/2 before Ethernet1/10. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export type InterfaceView = Awaited<ReturnType<InterfacesService['get']>>;
export type { Interface };
