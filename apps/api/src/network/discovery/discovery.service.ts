import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { parseCidr, parseIp, formatIp, type CredentialKind, type discoveryApplySchema } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../../db/db';
import { deviceCredentials, devices, discoveryRuns, interfaces, neighborObservations, type DiscoveryRun } from '../../db/schema';
import { AuditService, actorFrom } from '../../audit/audit.service';
import { rethrowDbError } from '../../common/pg-errors';
import type { Principal, RequestMeta } from '../../auth/principal';
import { notFound, ownDevice } from '../common';
import { DiscoveryQueue } from './queue';
import type { DiscoveredInterface, DiscoveredNeighbor, DiscoveryResult } from './types';

/** A run still queued or running after this long is considered lost (worker down or crashed). */
export const STALE_RUN_MS = 15 * 60_000;

type ExistingIface = { id: string; name: string; kind: string; description: string | null; macAddress: string | null; mtu: number | null; speedBps: number | null; enabled: boolean; ifIndex: number | null };

/**
 * Discovery runs: test a credential or collect interfaces, neighbors, BGP
 * sessions and device facts. Collection is read-only. Nothing collected is
 * written to inventory until an operator reviews the preview and applies it;
 * interfaces missing from the device are reported, never deleted.
 */
@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly queue: DiscoveryQueue,
  ) {}

  async start(p: Principal, deviceId: string, kind: CredentialKind, mode: 'test' | 'discover', meta: RequestMeta) {
    await ownDevice(this.db, p, deviceId);
    const [cred] = await this.db.select({ host: deviceCredentials.host }).from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, kind)));
    if (!cred) throw new BadRequestException({ error: 'no_credential', message: 'Add a credential of this type to the device first' });
    if (!cred.host) throw new BadRequestException({ error: 'no_address', message: 'This credential has no host; enter it again' });
    // Runs whose worker vanished would otherwise block the device forever.
    await this.db
      .update(discoveryRuns)
      .set({ status: 'failed', finishedAt: new Date(), error: 'Timed out waiting for the discovery worker' })
      .where(and(eq(discoveryRuns.deviceId, deviceId), inArray(discoveryRuns.status, ['queued', 'running']), sql`${discoveryRuns.createdAt} < now() - make_interval(secs => ${STALE_RUN_MS / 1000})`));
    let run: DiscoveryRun;
    try {
      run = await this.db.transaction(async (tx) => {
        const [r] = await tx.insert(discoveryRuns).values({ orgId: p.orgId, deviceId, credentialKind: kind, mode, requestedBy: p.userId, requestedLabel: p.email }).returning();
        await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: `discovery.${mode}`, target: { type: 'device', id: deviceId }, outcome: 'success', meta, metadata: { kind, runId: r!.id } }, tx);
        return r!;
      });
    } catch (err) {
      rethrowDbError(err);
    }
    try {
      await this.queue.add(run.id);
    } catch {
      const [failed] = await this.db.update(discoveryRuns).set({ status: 'failed', finishedAt: new Date(), error: 'The job queue (Redis) is unavailable; is the worker installed and Redis running?' }).where(eq(discoveryRuns.id, run.id)).returning();
      return DiscoveryService.view(failed!);
    }
    return DiscoveryService.view(run);
  }

  static view(r: DiscoveryRun) {
    return {
      id: r.id,
      deviceId: r.deviceId,
      credentialKind: r.credentialKind,
      mode: r.mode,
      status: r.status,
      requestedLabel: r.requestedLabel,
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      error: r.error,
      appliedAt: r.appliedAt,
      appliedBy: r.appliedBy,
    };
  }

  private async ownRun(db: DbOrTx, p: Principal, id: string, lock = false) {
    const q = db.select().from(discoveryRuns).where(and(eq(discoveryRuns.id, id), eq(discoveryRuns.orgId, p.orgId)));
    const [r] = lock ? await q.for('update') : await q;
    if (!r) throw notFound('Discovery run');
    return r;
  }

  async listRuns(p: Principal, deviceId: string) {
    await ownDevice(this.db, p, deviceId);
    const rows = await this.db.select().from(discoveryRuns).where(eq(discoveryRuns.deviceId, deviceId)).orderBy(desc(discoveryRuns.createdAt)).limit(25);
    return rows.map(DiscoveryService.view);
  }

  /** Run status, its raw (measured) result and, for a finished discovery, the diff against inventory. */
  async getRun(p: Principal, id: string) {
    const r = await this.ownRun(this.db, p, id);
    const base = { ...DiscoveryService.view(r), result: r.result ?? null };
    if (r.mode !== 'discover' || r.status !== 'succeeded' || !r.result) return { ...base, preview: null };
    return { ...base, preview: await this.preview(this.db, p, r.deviceId, r.result as unknown as DiscoveryResult) };
  }

  private async existing(db: DbOrTx, deviceId: string): Promise<Map<string, ExistingIface>> {
    const rows = await db
      .select({ id: interfaces.id, name: interfaces.name, kind: interfaces.kind, description: interfaces.description, macAddress: interfaces.macAddress, mtu: interfaces.mtu, speedBps: interfaces.speedBps, enabled: interfaces.enabled, ifIndex: interfaces.ifIndex })
      .from(interfaces)
      .where(eq(interfaces.deviceId, deviceId));
    return new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  }

  private diffFields(d: DiscoveredInterface, e: ExistingIface) {
    const want = this.ifaceCols(d);
    const changed: { field: string; from: unknown; to: unknown }[] = [];
    for (const k of ['description', 'macAddress', 'mtu', 'speedBps', 'enabled', 'ifIndex'] as const) {
      const to = want[k];
      if (to === undefined || to === null) continue; // never blank out what the device didn't report
      const from = k === 'macAddress' && e.macAddress ? e.macAddress.toLowerCase() : e[k];
      if (from !== to) changed.push({ field: k, from, to });
    }
    return changed;
  }

  private ifaceCols(d: DiscoveredInterface) {
    return {
      description: d.description?.trim() ? d.description.trim().slice(0, 200) : undefined,
      macAddress: d.macAddress && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(d.macAddress) && d.macAddress !== '00:00:00:00:00:00' ? d.macAddress.toLowerCase() : undefined,
      mtu: d.mtu && d.mtu >= 64 && d.mtu <= 65535 ? d.mtu : undefined,
      speedBps: d.speedBps && d.speedBps > 0 ? d.speedBps : undefined,
      enabled: typeof d.adminUp === 'boolean' ? d.adminUp : undefined,
      ifIndex: typeof d.ifIndex === 'number' && d.ifIndex > 0 && d.ifIndex < 2 ** 31 ? d.ifIndex : undefined,
    };
  }

  async preview(db: DbOrTx, p: Principal, deviceId: string, result: DiscoveryResult) {
    const existing = await this.existing(db, deviceId);
    const seen = new Set<string>();
    const ifaces = result.interfaces.map((d) => {
      const e = existing.get(d.name.toLowerCase());
      seen.add(d.name.toLowerCase());
      const changes = e ? this.diffFields(d, e) : [];
      return {
        name: d.name,
        kind: d.kind,
        action: !e ? ('create' as const) : changes.length ? ('update' as const) : ('unchanged' as const),
        interfaceId: e?.id ?? null,
        existingKind: e?.kind ?? null,
        changes,
        operUp: d.operUp ?? null,
        adminUp: d.adminUp ?? null,
        speedBps: d.speedBps ?? null,
        description: d.description ?? null,
        lagName: d.lagName ?? null,
        addresses: d.addresses ?? [],
      };
    });
    const missing = [...existing.values()].filter((e) => !seen.has(e.name.toLowerCase())).map((e) => ({ interfaceId: e.id, name: e.name, kind: e.kind }));
    const neighbors = await this.matchNeighbors(db, p, deviceId, result.neighbors);
    const addresses = await this.addressStatus(db, p, deviceId, result.interfaces);
    return {
      interfaces: ifaces,
      missing,
      neighbors,
      addresses,
      counts: { create: ifaces.filter((i) => i.action === 'create').length, update: ifaces.filter((i) => i.action === 'update').length, unchanged: ifaces.filter((i) => i.action === 'unchanged').length, missing: missing.length },
    };
  }

  /**
   * Matches LLDP/CDP neighbors to known devices by system name (hostname,
   * with or without domain) or management address, then to an interface by
   * port id or port description. Unmatched neighbors stay "unknown"; nothing
   * is guessed.
   */
  private async matchNeighbors(db: DbOrTx, p: Principal, deviceId: string, neighbors: DiscoveredNeighbor[]) {
    const out = [];
    for (const n of neighbors) {
      const sys = (n.remoteSystemName ?? '').trim().toLowerCase();
      const short = sys.split('.')[0] ?? '';
      const mgmt = n.remoteMgmtAddress ? parseIp(n.remoteMgmtAddress) : null;
      const mgmtText = mgmt ? formatIp(mgmt.family, mgmt.value) : null;
      const cands = await db.execute(sql`
        select d.id, coalesce(d.hostname, d.asset_tag) as name from devices d
        where d.org_id = ${p.orgId} and d.id <> ${deviceId} and (
          -- Names: exact (case-insensitive), or the neighbor reports a bare host name and ours is its FQDN.
          -- A neighbor "core1.isp.net" never matches our "core1.dc.example" by its first label alone.
          (${sys} <> '' and (lower(d.hostname) = ${sys} or (position('.' in ${sys}) = 0 and lower(split_part(d.hostname, '.', 1)) = ${short})))
          -- Management address in the global table (VRF addresses overlap between tenants).
          or (${mgmtText}::text is not null and (d.mgmt_address = ${mgmtText} or exists (select 1 from ip_addresses a where a.device_id = d.id and a.vrf_id is null and host(a.address) = ${mgmtText} and a.status <> 'released'))))
        limit 2`);
      const devs = cands.rows as { id: string; name: string }[];
      let matched: { deviceId: string; deviceName: string; interfaceId: string | null; interfaceName: string | null } | null = null;
      let note: string | null = null;
      if (devs.length === 1) {
        const d = devs[0]!;
        const res = await db.execute(sql`
          select id, name from interfaces where device_id = ${d.id} and (lower(name) = lower(${n.remotePortId}) or lower(name) = lower(${n.remotePortDescription ?? ''}))
          order by (lower(name) = lower(${n.remotePortId})) desc limit 1`);
        const i = res.rows[0] as { id: string; name: string } | undefined;
        matched = { deviceId: d.id, deviceName: d.name, interfaceId: i?.id ?? null, interfaceName: i?.name ?? null };
        if (!i) note = `${d.name} has no interface named ${n.remotePortId}`;
      } else if (devs.length > 1) note = 'Several devices match this neighbor; not linked';
      // Compare against documented cabling.
      let cable: 'verified' | 'mismatch' | 'none' | null = null;
      if (matched?.interfaceId) {
        const res = await db.execute(sql`
          select peer.interface_id as peer from interfaces li
          join cable_ends mine on mine.interface_id = li.id
          join cable_ends peer on peer.cable_id = mine.cable_id and peer."end" <> mine."end"
          where li.device_id = ${deviceId} and lower(li.name) = lower(${n.localInterface}) limit 1`);
        const peer = (res.rows[0] as { peer?: string } | undefined)?.peer;
        cable = !peer ? 'none' : peer === matched.interfaceId ? 'verified' : 'mismatch';
      }
      out.push({ ...n, matched, cable, note });
    }
    return out;
  }

  /** IPAM status of addresses seen on interfaces (informational; never written automatically). */
  private async addressStatus(db: DbOrTx, p: Principal, deviceId: string, ifaces: DiscoveredInterface[]) {
    const out: { interface: string; address: string; status: 'documented' | 'other_device' | 'not_in_ipam' | 'no_prefix'; detail: string | null }[] = [];
    for (const i of ifaces) {
      for (const a of i.addresses ?? []) {
        const c = parseCidr(a, true);
        if (!c) continue;
        const host = formatIp(c.family, parseIp(a.split('/')[0]!)!.value);
        if (c.family === 6 && host.toLowerCase().startsWith('fe80')) continue; // link-local
        const res = await db.execute(sql`
          select a.device_id, coalesce(d.hostname, d.asset_tag) as device, a.status from ip_addresses a left join devices d on d.id = a.device_id
          where a.org_id = ${p.orgId} and a.vrf_id is null and a.address = ${host}::inet and a.status <> 'released' limit 1`);
        const r = res.rows[0] as { device_id: string | null; device: string | null; status: string } | undefined;
        if (r) {
          out.push({ interface: i.name, address: `${host}/${c.length}`, status: !r.device_id || r.device_id === deviceId ? 'documented' : 'other_device', detail: r.device_id && r.device_id !== deviceId ? `Recorded in IPAM for ${r.device}` : `IPAM: ${r.status}` });
          continue;
        }
        const pre = await db.execute(sql`select 1 from prefixes x where x.org_id = ${p.orgId} and x.vrf_id is null and ${host}::inet <<= x.prefix limit 1`);
        out.push({ interface: i.name, address: `${host}/${c.length}`, status: pre.rows.length ? 'not_in_ipam' : 'no_prefix', detail: null });
      }
    }
    return out;
  }

  /** Writes the selected parts of a discovery into inventory, in one transaction. */
  async apply(p: Principal, runId: string, input: z.infer<typeof discoveryApplySchema>, meta: RequestMeta) {
    try {
      return await this.db.transaction(async (tx) => {
        const run = await this.ownRun(tx, p, runId, true);
        // Serialize applies per device so an older run can't land after a newer one.
        await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, run.deviceId)).for('update');
        if (run.mode !== 'discover' || run.status !== 'succeeded' || !run.result) throw new BadRequestException({ error: 'not_applicable', message: 'Only a successful discovery can be applied' });
        if (run.appliedAt) throw new ConflictException({ error: 'already_applied', message: 'This discovery was already applied; run a new one' });
        // A newer applied run would be overwritten with older data.
        const [newer] = await tx
          .select({ id: discoveryRuns.id })
          .from(discoveryRuns)
          .where(and(eq(discoveryRuns.deviceId, run.deviceId), sql`${discoveryRuns.appliedAt} is not null`, sql`${discoveryRuns.finishedAt} > ${run.finishedAt}`))
          .limit(1);
        if (newer) throw new ConflictException({ error: 'stale_run', message: 'A newer discovery has already been applied to this device' });
        const result = run.result as unknown as DiscoveryResult;
        const wanted = new Set(input.interfaces.map((n) => n.toLowerCase()));
        const existing = await this.existing(tx, run.deviceId);
        let created = 0;
        let updated = 0;
        const warnings: string[] = [];
        const now = new Date();
        for (const d of result.interfaces) {
          if (!wanted.has(d.name.toLowerCase())) continue;
          const cols = this.ifaceCols(d);
          const set = Object.fromEntries(Object.entries(cols).filter(([, v]) => v !== undefined));
          const e = existing.get(d.name.toLowerCase());
          if (e) {
            if (this.diffFields(d, e).length || !e.ifIndex) {
              await tx.update(interfaces).set({ ...set, discoveredAt: now }).where(eq(interfaces.id, e.id));
              updated++;
            } else await tx.update(interfaces).set({ discoveredAt: now }).where(eq(interfaces.id, e.id));
          } else {
            const [row] = await tx
              .insert(interfaces)
              .values({ ...set, orgId: p.orgId, deviceId: run.deviceId, name: d.name.slice(0, 64), kind: d.kind, enabled: cols.enabled ?? true, discoveredAt: now })
              .returning();
            existing.set(d.name.toLowerCase(), { ...row!, macAddress: row!.macAddress ?? null });
            created++;
          }
        }
        // LAG membership, each in a savepoint so one platform quirk can't sink the apply.
        for (const d of result.interfaces) {
          if (!d.lagName || !wanted.has(d.name.toLowerCase())) continue;
          const member = existing.get(d.name.toLowerCase());
          const lag = existing.get(d.lagName.toLowerCase());
          if (!member || !lag) continue;
          if (lag.kind !== 'lag' || (member.kind !== 'physical' && member.kind !== 'management')) {
            warnings.push(`${d.name}: not added to ${d.lagName} (only physical ports can join a LAG interface)`);
            continue;
          }
          try {
            await tx.transaction((sp) => sp.update(interfaces).set({ lagId: lag.id }).where(eq(interfaces.id, member.id)));
          } catch (err) {
            warnings.push(`${d.name}: not added to ${d.lagName} (${(err as Error).message.split('\n')[0]})`);
          }
        }
        let neighbors = 0;
        if (input.importNeighbors) {
          const matched = await this.matchNeighbors(tx, p, run.deviceId, result.neighbors);
          for (const n of matched) {
            const local = existing.get(n.localInterface.toLowerCase());
            if (!local) continue;
            await tx
              .insert(neighborObservations)
              .values({
                orgId: p.orgId,
                interfaceId: local.id,
                protocol: n.protocol,
                remoteChassisId: (n.remoteChassisId ?? '').slice(0, 128),
                remoteSystemName: n.remoteSystemName?.slice(0, 255) ?? null,
                remotePortId: (n.remotePortId ?? '').slice(0, 128),
                remotePortDescription: n.remotePortDescription?.slice(0, 255) ?? null,
                remoteMgmtAddress: n.remoteMgmtAddress?.slice(0, 64) ?? null,
                remotePlatform: n.remotePlatform?.slice(0, 255) ?? null,
                matchedInterfaceId: n.matched?.interfaceId ?? null,
              })
              .onConflictDoUpdate({
                target: [neighborObservations.interfaceId, neighborObservations.protocol, neighborObservations.remoteChassisId, neighborObservations.remotePortId],
                set: {
                  remoteSystemName: sql`excluded.remote_system_name`,
                  remotePortDescription: sql`excluded.remote_port_description`,
                  remoteMgmtAddress: sql`excluded.remote_mgmt_address`,
                  remotePlatform: sql`excluded.remote_platform`,
                  matchedInterfaceId: sql`excluded.matched_interface_id`,
                  lastSeenAt: sql`now()`,
                },
              });
            neighbors++;
          }
          // Observations of a protocol this run reported, but no longer seen, are removed. Protocols the run
          // returned nothing for (not collected, timed out, or another access method) are left untouched;
          // each observation keeps its last-seen time.
          const protocols = [...new Set(result.neighbors.map((n) => n.protocol))];
          if (protocols.length) {
            await tx.execute(sql`
              delete from neighbor_observations o using interfaces i
              where i.id = o.interface_id and i.device_id = ${run.deviceId} and o.last_seen_at < now()
                and o.protocol in (${sql.join(protocols.map((x) => sql`${x}`), sql`, `)})`);
          }
        }
        const facts: Record<string, string> = {};
        if (input.updateDeviceFacts) {
          const f = result.facts;
          const [dev] = await tx.select({ hostname: devices.hostname, serial: devices.serial, os: devices.os }).from(devices).where(eq(devices.id, run.deviceId));
          if (f.sysName && !dev!.hostname) facts.hostname = f.sysName.slice(0, 255);
          if (f.serial && f.serial !== dev!.serial) facts.serial = f.serial.slice(0, 100);
          if (f.osVersion && f.osVersion !== dev!.os) facts.os = f.osVersion.slice(0, 200);
          if (Object.keys(facts).length) await tx.update(devices).set(facts).where(eq(devices.id, run.deviceId));
        }
        await tx.update(discoveryRuns).set({ appliedAt: now, appliedBy: p.email }).where(eq(discoveryRuns.id, run.id));
        await this.audit.record(
          { orgId: p.orgId, actor: actorFrom(p), action: 'discovery.apply', target: { type: 'device', id: run.deviceId }, outcome: 'success', meta, metadata: { runId, created, updated, neighbors, facts: Object.keys(facts) } },
          tx,
        );
        return { created, updated, neighbors, facts: Object.keys(facts), warnings };
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }
}
