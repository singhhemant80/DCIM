import type { InterfaceKind } from '@crapplet/shared';
import type { Adapter, AdapterTarget, DiscoveredBgpPeer, DiscoveredInterface, DiscoveredNeighbor, DiscoveryResult, TestResult } from '../../network/discovery/types';
import { DeviceHttpError, bool, deviceRequest, int, normalizeMac, str } from './http';

/**
 * Fortinet FortiOS REST API (read-only: GET only) using a REST API admin
 * token with a read-only access profile. The token is sent as a Bearer
 * header, never as a URL parameter.
 */
type Row = Record<string, unknown>;

const TYPE_KIND: Record<string, InterfaceKind> = {
  physical: 'physical',
  vlan: 'vlan',
  aggregate: 'lag',
  redundant: 'lag',
  loopback: 'loopback',
  tunnel: 'tunnel',
  'hard-switch': 'bridge',
  switch: 'bridge',
  'vap-switch': 'virtual',
  'emac-vlan': 'vlan',
  'vdom-link': 'virtual',
};

function maskLen(mask: string): number | null {
  const parts = mask.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((a, o) => a + o.toString(2).replace(/0/g, '').length, 0);
}

export function parseFortiOs(data: { status: Row | null; cmdb: Row[]; monitor: Record<string, Row>; bgp: Row[]; lldp: Row[] }, warnings: string[]): Omit<DiscoveryResult, 'source' | 'collectedAt' | 'warnings'> {
  const ifaces = new Map<string, DiscoveredInterface>();
  const lagOf = new Map<string, string>();
  for (const c of data.cmdb) {
    if (str(c.type) === 'aggregate' || str(c.type) === 'redundant') {
      for (const m of (c.member as Row[] | undefined) ?? []) {
        const n = str(m['interface-name']);
        if (n) lagOf.set(n.toLowerCase(), String(c.name));
      }
    }
  }
  const names = new Set([...data.cmdb.map((c) => str(c.name)), ...Object.keys(data.monitor)].filter((n): n is string => !!n));
  for (const name of names) {
    const c = data.cmdb.find((x) => str(x.name) === name) ?? {};
    const m = data.monitor[name] ?? {};
    const addresses: string[] = [];
    const cip = str(c.ip);
    if (cip && !cip.startsWith('0.0.0.0')) {
      const [ip, mask] = cip.split(/\s+/);
      const len = mask ? maskLen(mask) : null;
      if (ip && len !== null) addresses.push(`${ip}/${len}`);
    } else if (str(m.ip) && str(m.ip) !== '0.0.0.0' && int(m.mask) !== null) addresses.push(`${str(m.ip)}/${int(m.mask)}`);
    const mtuOverride = c['mtu-override'] === 'enable';
    ifaces.set(name.toLowerCase(), {
      name: name.slice(0, 64),
      kind: TYPE_KIND[str(c.type) ?? ''] ?? (name.startsWith('mgmt') ? 'management' : 'physical'),
      description: str(c.description) ?? str(c.alias) ?? str(m.alias),
      macAddress: normalizeMac(m.mac) ?? normalizeMac(c.macaddr),
      mtu: mtuOverride ? int(c.mtu) : null,
      // FortiOS reports link speed in Mbit/s.
      speedBps: int(m.speed) && int(m.speed)! > 0 ? int(m.speed)! * 1_000_000 : null,
      adminUp: str(c.status) ? str(c.status) === 'up' : null,
      operUp: bool(m.link),
      addresses,
      lagName: lagOf.get(name.toLowerCase()) ?? null,
    });
  }
  const bgp: DiscoveredBgpPeer[] = data.bgp.map((b) => ({
    peer: str(b.neighbor_ip) ?? '',
    remoteAs: int(b.remote_as),
    state: (str(b.state) ?? 'unknown').toLowerCase(),
    uptimeSeconds: null,
    vrf: str(b.vrf),
    description: null,
  }));
  const neighbors: DiscoveredNeighbor[] = [];
  for (const n of data.lldp) {
    const local = str(n.port) ?? str(n.local_port) ?? str(n.interface);
    if (!local) continue;
    const addrs = (n.addresses as Row[] | undefined) ?? [];
    neighbors.push({
      localInterface: ifaces.get(local.toLowerCase())?.name ?? local,
      protocol: 'lldp',
      remoteChassisId: normalizeMac(n.chassis_id) ?? str(n.chassis_id) ?? normalizeMac(n.mac) ?? '',
      remoteSystemName: str(n.system_name),
      remotePortId: str(n.port_id) ?? '',
      remotePortDescription: str(n.port_description),
      remoteMgmtAddress: str(addrs[0]?.address) ?? null,
      remotePlatform: str(n.system_description)?.split('\n')[0] ?? null,
    });
  }
  if (!data.lldp.length) warnings.push('No LLDP neighbors (LLDP reception may be disabled on the FortiGate)');
  const s = data.status ?? {};
  const results = (s.results as Row | undefined) ?? {};
  return {
    facts: {
      sysName: str(results.hostname),
      sysDescr: [str(results.model_name), str(results.model_number), str(s.version)].filter(Boolean).join(' ') || null,
      vendor: 'Fortinet',
      model: [str(results.model_name), str(results.model_number)].filter(Boolean).join(' ') || str(results.model) || null,
      serial: str(s.serial),
      osVersion: [str(s.version), str(s.build) ? `build${str(s.build)}` : null].filter(Boolean).join(' ') || null,
      uptimeSeconds: null,
    },
    interfaces: [...ifaces.values()],
    neighbors,
    bgp,
  };
}

export function fortiOsAdapter(): Adapter {
  const get = async (t: AdapterTarget, path: string): Promise<Row> => {
    const vdom = t.params.vdom ? `${path.includes('?') ? '&' : '?'}vdom=${encodeURIComponent(t.params.vdom)}` : '';
    const r = await deviceRequest(t, 'GET', `/api/v2${path}${vdom}`, { headers: { Authorization: `Bearer ${t.secret.token ?? ''}` }, defaultPort: (t.params.scheme ?? 'https') === 'https' ? 443 : 80 });
    return (r.json ?? {}) as Row;
  };
  return {
    async test(t): Promise<TestResult> {
      const started = Date.now();
      const s = await get(t, '/monitor/system/status');
      const r = (s.results as Row | undefined) ?? {};
      return { ok: true, message: `Connected: ${str(r.hostname) ?? 'FortiGate'} — ${str(r.model_name) ?? ''} ${str(s.version) ?? ''}`.replace(/\s+/g, ' ').trim(), latencyMs: Date.now() - started, facts: { sysName: str(r.hostname), serial: str(s.serial), osVersion: str(s.version), vendor: 'Fortinet' } };
    },
    async discover(t): Promise<DiscoveryResult> {
      const warnings: string[] = [];
      const optional = async (path: string, label: string): Promise<Row | null> => {
        try {
          return await get(t, path);
        } catch (e) {
          if (e instanceof DeviceHttpError && (e.status === 401 || e.status === 403)) throw e;
          warnings.push(`${label}: ${(e as Error).message}`);
          return null;
        }
      };
      const status = await get(t, '/monitor/system/status');
      const [cmdb, monitor, bgp, lldp] = await Promise.all([
        optional('/cmdb/system/interface', 'interface configuration'),
        optional('/monitor/system/interface?include_vlan=true&include_aggregate=true', 'interface status'),
        optional('/monitor/router/bgp/neighbors', 'BGP neighbors'),
        optional('/monitor/network/lldp/neighbors', 'LLDP neighbors'),
      ]);
      const cmdbRows = Array.isArray(cmdb?.results) ? (cmdb!.results as Row[]) : [];
      const monRows = monitor?.results && typeof monitor.results === 'object' && !Array.isArray(monitor.results) ? (monitor.results as Record<string, Row>) : {};
      if (!cmdbRows.length && !Object.keys(monRows).length) throw new Error('FortiOS returned no interfaces (does the API profile allow read access to system configuration?)');
      return {
        source: 'fortios_rest',
        collectedAt: new Date().toISOString(),
        ...parseFortiOs({ status, cmdb: cmdbRows, monitor: monRows, bgp: Array.isArray(bgp?.results) ? (bgp!.results as Row[]) : [], lldp: Array.isArray(lldp?.results) ? (lldp!.results as Row[]) : [] }, warnings),
        warnings,
      };
    },
  };
}
