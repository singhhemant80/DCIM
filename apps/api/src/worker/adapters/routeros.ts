import type { InterfaceKind } from '@crapplet/shared';
import type { Adapter, AdapterTarget, DiscoveredBgpPeer, DiscoveredInterface, DiscoveredNeighbor, DiscoveryResult, TestResult } from '../../network/discovery/types';
import { DeviceHttpError, basicAuth, bool, deviceRequest, int, normalizeMac, speed, str } from './http';

/**
 * MikroTik RouterOS v7 REST API (read-only: GET only).
 * Requires RouterOS 7.1+ with the www-ssl (or www) service enabled and a user
 * in a group with the "read" and "rest-api" policies. RouterOS returns every
 * value as a string.
 */
type Row = Record<string, unknown>;

const TYPE_KIND: Record<string, InterfaceKind> = {
  ether: 'physical',
  'sfp-sfpplus': 'physical',
  vlan: 'vlan',
  bond: 'lag',
  bridge: 'bridge',
  loopback: 'loopback',
  eoip: 'tunnel',
  eoipv6: 'tunnel',
  gre: 'tunnel',
  'gre6': 'tunnel',
  ipip: 'tunnel',
  ipipv6: 'tunnel',
  wg: 'tunnel',
  vxlan: 'tunnel',
  'l2tp-in': 'tunnel',
  'l2tp-out': 'tunnel',
  'pppoe-in': 'tunnel',
  'pppoe-out': 'tunnel',
  'ovpn-in': 'tunnel',
  'ovpn-out': 'tunnel',
};

/** "1w2d03:04:05" or "1w2d3h4m5s" → seconds. */
export function routerosUptime(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  let total = 0;
  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  for (const [, n, u] of s.matchAll(/(\d+)([wdhms])/g)) total += Number(n) * units[u!]!;
  const clock = s.match(/(\d+):(\d+):(\d+)$/);
  if (clock) total += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  return total || (s === '0s' ? 0 : null);
}

export function parseRouterOs(data: { resource: Row | null; identity: Row | null; routerboard: Row | null; interfaces: Row[]; ethernet: Row[]; bonding: Row[]; ip: Row[]; ipv6: Row[]; neighbors: Row[]; bgp: Row[] }, warnings: string[]): Omit<DiscoveryResult, 'source' | 'collectedAt' | 'warnings'> {
  const eth = new Map(data.ethernet.map((e) => [str(e.name), e]));
  const lagOf = new Map<string, string>();
  for (const b of data.bonding) for (const s of (str(b.slaves) ?? '').split(',').filter(Boolean)) lagOf.set(s.trim().toLowerCase(), String(b.name));
  const ifaces = new Map<string, DiscoveredInterface>();
  for (const r of data.interfaces) {
    const name = str(r.name);
    if (!name) continue;
    const type = str(r.type) ?? '';
    const e = eth.get(name);
    ifaces.set(name.toLowerCase(), {
      name: name.slice(0, 64),
      kind: TYPE_KIND[type] ?? (type.startsWith('ether') ? 'physical' : 'virtual'),
      description: str(r.comment),
      macAddress: normalizeMac(r['mac-address']),
      mtu: int(r['actual-mtu']) ?? int(r.mtu),
      speedBps: speed(e?.speed),
      adminUp: bool(r.disabled) === null ? null : !bool(r.disabled),
      operUp: bool(r.running),
      addresses: [],
      lagName: lagOf.get(name.toLowerCase()) ?? null,
    });
  }
  for (const a of [...data.ip, ...data.ipv6]) {
    if (bool(a.disabled) || bool(a.invalid)) continue;
    const i = ifaces.get((str(a['actual-interface']) ?? str(a.interface) ?? '').toLowerCase());
    const addr = str(a.address);
    if (i && addr && addr.includes('/')) i.addresses!.push(addr);
  }
  const neighbors: DiscoveredNeighbor[] = [];
  for (const n of data.neighbors) {
    // "ether1" or "ether1,bridge1": the first entry is the port the frame arrived on.
    const local = (str(n.interface) ?? '').split(',')[0]!.trim();
    if (!local) continue;
    const by = (str(n['discovered-by']) ?? '').split(',');
    neighbors.push({
      localInterface: ifaces.get(local.toLowerCase())?.name ?? local,
      protocol: by.includes('lldp') ? 'lldp' : by.includes('cdp') ? 'cdp' : 'mndp',
      remoteChassisId: normalizeMac(n['mac-address']) ?? str(n.identity) ?? '',
      remoteSystemName: str(n.identity),
      remotePortId: str(n['interface-name']) ?? '',
      remotePortDescription: null,
      remoteMgmtAddress: str(n.address) ?? str(n.address4),
      remotePlatform: [str(n.platform), str(n.board), str(n.version)].filter(Boolean).join(' ') || null,
    });
  }
  const bgp: DiscoveredBgpPeer[] = data.bgp.map((b) => ({
    peer: (str(b['remote.address']) ?? str(b['remote-address']) ?? '').split('/')[0]!,
    remoteAs: int(b['remote.as']) ?? int(b['remote-as']),
    state: bool(b.established) ? 'established' : str(b.state) ?? 'not established',
    uptimeSeconds: routerosUptime(b.uptime),
    prefixesReceived: int(b['prefix-count']),
    vrf: str(b.vrf) ?? str(b['routing-table']),
    description: str(b.name),
  }));
  if (!data.bgp.length) warnings.push('No BGP sessions reported');
  const res = data.resource ?? {};
  return {
    facts: {
      sysName: str(data.identity?.name),
      sysDescr: [str(res['board-name']), str(res.version)].filter(Boolean).join(' RouterOS ') || null,
      vendor: 'MikroTik',
      model: str(data.routerboard?.model) ?? str(res['board-name']),
      serial: str(data.routerboard?.['serial-number']),
      osVersion: str(res.version)?.split(' ')[0] ?? null,
      uptimeSeconds: routerosUptime(res.uptime),
    },
    interfaces: [...ifaces.values()],
    neighbors,
    bgp,
  };
}

export function routerOsAdapter(): Adapter {
  const get = async (t: AdapterTarget, path: string) => {
    const r = await deviceRequest(t, 'GET', `/rest${path}`, { headers: { Authorization: basicAuth(t.username, t.secret.password) }, defaultPort: (t.params.scheme ?? 'https') === 'https' ? 443 : 80 });
    return r.json;
  };
  return {
    async test(t): Promise<TestResult> {
      const started = Date.now();
      const res = (await get(t, '/system/resource')) as Row;
      const id = (await get(t, '/system/identity').catch(() => null)) as Row | null;
      return { ok: true, message: `Connected: ${str(id?.name) ?? 'RouterOS'} — ${str(res['board-name']) ?? ''} RouterOS ${str(res.version) ?? '?'}`.trim(), latencyMs: Date.now() - started, facts: { sysName: str(id?.name), osVersion: str(res.version)?.split(' ')[0] ?? null, uptimeSeconds: routerosUptime(res.uptime), vendor: 'MikroTik' } };
    },
    async discover(t): Promise<DiscoveryResult> {
      const warnings: string[] = [];
      const list = async (path: string, label: string): Promise<Row[]> => {
        try {
          const j = await get(t, path);
          return Array.isArray(j) ? (j as Row[]) : [];
        } catch (e) {
          if (e instanceof DeviceHttpError && (e.status === 401 || e.status === 403)) throw e;
          warnings.push(`${label}: ${(e as Error).message}`);
          return [];
        }
      };
      const one = async (path: string): Promise<Row | null> => {
        try {
          return (await get(t, path)) as Row;
        } catch (e) {
          if (e instanceof DeviceHttpError && (e.status === 401 || e.status === 403)) throw e;
          return null;
        }
      };
      const resource = (await get(t, '/system/resource')) as Row;
      const interfaces = await list('/interface', 'interfaces');
      if (!interfaces.length) throw new Error('RouterOS returned no interfaces');
      const [identity, routerboard, ethernet, bonding, ip, ipv6, neighbors, bgp] = await Promise.all([
        one('/system/identity'),
        one('/system/routerboard'),
        list('/interface/ethernet', 'ethernet'),
        list('/interface/bonding', 'bonding'),
        list('/ip/address', 'IPv4 addresses'),
        list('/ipv6/address', 'IPv6 addresses'),
        list('/ip/neighbor', 'neighbors'),
        list('/routing/bgp/session', 'BGP sessions'),
      ]);
      return { source: 'routeros_rest', collectedAt: new Date().toISOString(), ...parseRouterOs({ resource, identity, routerboard, interfaces, ethernet, bonding, ip, ipv6, neighbors, bgp }, warnings), warnings };
    },
  };
}
