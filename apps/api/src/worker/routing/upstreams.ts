import { eq, sql } from 'drizzle-orm';
import type { CredentialKind, UpstreamCheckData } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { bgpUpstreams, deviceCredentials } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { CHECKED_STATES } from '../../dcim/reachability';
import { credentialContext, type Adapter, type AdapterTarget, type BgpReadout } from '../../network/discovery/types';
import { defaultAdapters, redact } from '../processor';
import { expandAsSet, routeObjectsOf, type Irr } from './irr';
import { ROUTING_CHECK_HOURS } from './check';

export interface UpstreamDeps {
  db: Db;
  secrets: SecretBox;
  irr: Irr;
  logger: { warn: (o: object, m: string) => void };
  adapters?: Partial<Record<CredentialKind, Adapter>>;
}

const ROUTER_KINDS: CredentialKind[] = ['routeros_rest', 'routeros_api'];

/**
 * Checks due upstreams (every 6 hours or on "Check now"): the provider's
 * AS-SET and your route objects in the IRR, and the BGP sessions to the
 * provider on your own routers (MikroTik, read-only: print commands / GET).
 */
export async function pollDueUpstreams(deps: UpstreamDeps, limit = 2): Promise<number> {
  const { db } = deps;
  const claimed = await db.execute<{ id: string; org_id: string; asn: string; as_set: string | null }>(sql`
    update bgp_upstreams set status = 'running', started_at = now() where id in (
      select id from bgp_upstreams where (next_at is null or next_at <= now()) and (status <> 'running' or started_at < now() - interval '10 minutes')
       order by next_at nulls first limit ${limit} for update skip locked)
    returning id, org_id, asn, as_set`);
  const routerCache = new Map<string, Promise<RouterRead[]>>();
  for (const u of claimed.rows) {
    try {
      const ours = (await db.execute<{ asn: string; as_set: string | null }>(sql`select asn, as_set from bgp_asns where org_id = ${u.org_id} order by asn`)).rows.map((r) => ({ asn: Number(r.asn), asSet: r.as_set }));
      if (!routerCache.has(u.org_id)) routerCache.set(u.org_id, readRouters(deps, u.org_id));
      const data = await checkUpstream(deps.irr, Number(u.asn), u.as_set, ours, await routerCache.get(u.org_id)!);
      await db
        .update(bgpUpstreams)
        .set({ status: 'idle', data, checkedAt: new Date(), nextAt: sql`now() + make_interval(hours => ${ROUTING_CHECK_HOURS})`, lastError: null })
        .where(eq(bgpUpstreams.id, u.id));
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 500);
      await db
        .update(bgpUpstreams)
        .set({ status: 'idle', nextAt: sql`now() + interval '30 minutes'`, lastError: msg })
        .where(eq(bgpUpstreams.id, u.id));
      deps.logger.warn({ upstream: u.asn, err: msg }, 'upstream check failed');
    }
  }
  return claimed.rows.length;
}

export interface RouterRead {
  deviceId: string;
  name: string;
  readAt: string;
  readout: BgpReadout | null;
  error: string | null;
}

/** Reads BGP state from the organization's MikroTik routers in service that have a RouterOS credential (at most 10). */
async function readRouters(deps: UpstreamDeps, orgId: string): Promise<RouterRead[]> {
  const states = sql.join(
    CHECKED_STATES.map((s) => sql`${s}`),
    sql`, `,
  );
  const creds = await deps.db.execute<{ device_id: string; name: string; kind: CredentialKind }>(sql`
    select distinct on (d.id) d.id as device_id, coalesce(d.hostname, d.asset_tag) as name, c.kind::text as kind
      from devices d join device_credentials c on c.device_id = d.id and c.kind in ('routeros_rest', 'routeros_api')
     where d.org_id = ${orgId} and d.lifecycle_state in (${states})
     order by d.id, case c.kind when 'routeros_rest' then 0 else 1 end
     limit 10`);
  const out: RouterRead[] = [];
  for (const r of creds.rows) {
    let secret: Record<string, unknown> = {};
    try {
      const [cred] = await deps.db
        .select()
        .from(deviceCredentials)
        .where(sql`${deviceCredentials.deviceId} = ${r.device_id} and ${deviceCredentials.kind} = ${r.kind}`);
      if (!cred?.host) throw new Error('No address');
      secret = JSON.parse(deps.secrets.decrypt(cred.secretEnc, credentialContext(cred.orgId, cred.deviceId, cred.kind, cred.host, cred.port))) as Record<string, unknown>;
      const adapter = (deps.adapters ?? defaultAdapters())[r.kind];
      if (!adapter?.bgp) throw new Error('BGP readout not available for this device');
      const t: AdapterTarget = { host: cred.host, port: cred.port, username: cred.username, params: cred.params, secret: secret as AdapterTarget['secret'] };
      out.push({ deviceId: r.device_id, name: r.name, readAt: new Date().toISOString(), readout: await adapter.bgp(t), error: null });
    } catch (e) {
      out.push({ deviceId: r.device_id, name: r.name, readAt: new Date().toISOString(), readout: null, error: redact((e as Error).message || 'Failed', secret).slice(0, 300) });
    }
  }
  return out;
}

/** IRR and router state for one upstream. */
export async function checkUpstream(irr: Irr, asn: number, asSet: string | null, ours: { asn: number; asSet: string | null }[], routers: RouterRead[]): Promise<UpstreamCheckData> {
  const data: UpstreamCheckData = { irr: { server: irr.server, asSet, found: null, size: null, ourAsns: [], ourSetsListed: [], error: null }, routeObjects: [], routersRead: routers.length, routers: [] };
  if (asSet) {
    try {
      const set = await expandAsSet(irr, asSet);
      data.irr.found = !!set;
      if (set) {
        data.irr.size = set.asns.length;
        data.irr.ourAsns = ours.map((o) => ({ asn: o.asn, inSet: set.asns.includes(o.asn), direct: set.direct.includes(`AS${o.asn}`) }));
        data.irr.ourSetsListed = ours.map((o) => o.asSet?.toUpperCase()).filter((x): x is string => !!x && set.direct.includes(x));
      }
    } catch (e) {
      data.irr.error = String((e as Error).message).slice(0, 300);
    }
  }
  for (const o of ours) {
    try {
      data.routeObjects.push({ asn: o.asn, prefixes: await routeObjectsOf(irr, o.asn), error: null });
    } catch (e) {
      data.routeObjects.push({ asn: o.asn, prefixes: [], error: String((e as Error).message).slice(0, 300) });
    }
  }
  for (const r of routers) {
    const sessions = (r.readout?.sessions ?? []).filter((s) => s.remoteAs === asn);
    if (r.readout && !sessions.length) continue;
    const names = sessions.flatMap((s) => [s.description, s.peer].filter((x): x is string => !!x));
    // Sent prefixes match a session by name ("joy-1"), its connection name ("joy") or the peer address.
    const sentTo = (peer: string) => names.some((n) => n === peer || n.startsWith(`${peer}-`) || peer.startsWith(`${n}-`) || peer === n.split('-')[0]);
    data.routers.push({
      deviceId: r.deviceId,
      name: r.name,
      readAt: r.readAt,
      sessions: sessions.map((s) => ({ name: s.description ?? null, peer: s.peer, state: s.state, uptimeSeconds: s.uptimeSeconds ?? null, prefixesReceived: s.prefixesReceived ?? null })),
      // An empty list from the router usually means it keeps no sent attributes, not that nothing is sent.
      advertised: r.readout?.advertisements?.length ? [...new Set(r.readout.advertisements.filter((a) => sentTo(a.peer)).map((a) => a.prefix))].sort() : null,
      error: r.error,
      warnings: r.readout?.warnings ?? [],
    });
  }
  return data;
}
