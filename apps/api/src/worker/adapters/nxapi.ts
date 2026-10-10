import type { InterfaceKind } from '@crapplet/shared';
import type { Adapter, AdapterTarget, CounterSnapshot, DiscoveredBgpPeer, DiscoveredInterface, DiscoveredNeighbor, DiscoveryResult, TestResult } from '../../network/discovery/types';
import { DeviceHttpError, asArray, basicAuth, counter, deviceRequest, int, normalizeMac, str } from './http';

/**
 * Cisco NX-OS NX-API (JSON-RPC style "ins_api", type cli_show).
 * Only fixed `show` commands are sent; no user input reaches the command
 * string, and configuration commands are never used.
 */
type Row = Record<string, unknown>;

export const NXAPI_COMMANDS = ['show version', 'show interface', 'show ip interface vrf all', 'show port-channel summary', 'show lldp neighbors detail', 'show cdp neighbors detail', 'show ip bgp summary vrf all'] as const;

/** Collects every ROW_<name> object below `obj` (NX-API returns a single row as an object, several as an array). */
export function rows(obj: unknown, name: string, ctx: Record<string, unknown> = {}, out: { row: Row; ctx: Record<string, unknown> }[] = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const o of obj) rows(o, name, ctx, out);
    return out;
  }
  const o = obj as Row;
  const next = { ...ctx };
  for (const k of ['vrf-name-out', 'af-name', 'safi']) if (k in o && typeof o[k] !== 'object') next[k] = o[k];
  for (const [k, v] of Object.entries(o)) {
    if (k === `ROW_${name}`) for (const r of asArray(v as Row | Row[])) out.push({ row: r, ctx: next });
    else if (typeof v === 'object') rows(v, name, next, out);
  }
  return out;
}

/** "Eth1/1" → "Ethernet1/1", "Po10" → "port-channel10", "mgmt0" stays. */
export function longName(n: string): string {
  const m = n.match(/^([A-Za-z-]+)(\d.*)$/);
  if (!m) return n;
  const p = m[1]!.toLowerCase();
  const map: Record<string, string> = { eth: 'Ethernet', ethernet: 'Ethernet', po: 'port-channel', 'port-channel': 'port-channel', lo: 'loopback', loopback: 'loopback', vlan: 'Vlan', tunnel: 'Tunnel', mgmt: 'mgmt' };
  return `${map[p] ?? m[1]}${m[2]}`;
}

function kindOf(name: string): InterfaceKind {
  const n = name.toLowerCase();
  if (n.startsWith('ethernet')) return n.includes('.') ? 'virtual' : 'physical';
  if (n.startsWith('port-channel')) return 'lag';
  if (n.startsWith('vlan')) return 'vlan';
  if (n.startsWith('loopback')) return 'loopback';
  if (n.startsWith('mgmt')) return 'management';
  if (n.startsWith('tunnel') || n.startsWith('nve')) return 'tunnel';
  return 'virtual';
}

export function parseNxos(out: Record<string, unknown>, warnings: string[]): Omit<DiscoveryResult, 'source' | 'collectedAt' | 'warnings'> {
  const ver = (out['show version'] ?? {}) as Row;
  const ifaces = new Map<string, DiscoveredInterface>();
  for (const { row: r } of rows(out['show interface'], 'interface')) {
    const name = str(r.interface);
    if (!name) continue;
    const svi = name.toLowerCase().startsWith('vlan');
    const bw = int(svi ? r.svi_bw : r.eth_bw); // kbit/s
    const admin = str(svi ? r.svi_admin_state : r.admin_state);
    const oper = str(svi ? r.svi_line_proto : r.state);
    ifaces.set(name.toLowerCase(), {
      name,
      kind: kindOf(name),
      description: str(r.desc) ?? str(r.svi_desc),
      macAddress: normalizeMac(svi ? r.svi_mac : (r.eth_hw_addr ?? r.eth_bia_addr)),
      mtu: int(svi ? r.svi_mtu : r.eth_mtu),
      speedBps: bw && bw > 0 ? bw * 1000 : null,
      adminUp: admin ? admin === 'up' : null,
      operUp: oper ? oper === 'up' : null,
      addresses: [],
      lagName: null,
    });
  }
  for (const { row: r } of rows(out['show ip interface vrf all'], 'intf')) {
    const i = ifaces.get((str(r['intf-name']) ?? '').toLowerCase());
    const ip = str(r.prefix) ?? str(r['ip-addr']);
    const len = int(r.masklen);
    if (i && ip && len !== null) i.addresses!.push(`${str(r['ip-addr']) ?? ip}/${len}`);
  }
  for (const { row: ch } of rows(out['show port-channel summary'], 'channel')) {
    const lag = longName(str(ch['port-channel']) ?? '');
    for (const { row: m } of rows(ch, 'member')) {
      const i = ifaces.get(longName(str(m.port) ?? '').toLowerCase());
      if (i && lag) i.lagName = ifaces.get(lag.toLowerCase())?.name ?? lag;
    }
  }
  const neighbors: DiscoveredNeighbor[] = [];
  for (const { row: n } of rows(out['show lldp neighbors detail'], 'nbor_detail')) {
    const local = longName(str(n.l_port_id) ?? str(n.local_port_id) ?? '');
    if (!local) continue;
    neighbors.push({
      localInterface: ifaces.get(local.toLowerCase())?.name ?? local,
      protocol: 'lldp',
      remoteChassisId: normalizeMac(n.chassis_id) ?? str(n.chassis_id) ?? '',
      remoteSystemName: str(n.sys_name),
      remotePortId: normalizeMac(n.port_id) ?? str(n.port_id) ?? '',
      remotePortDescription: str(n.port_desc),
      remoteMgmtAddress: str(n.mgmt_addr) ?? str(n.mgmt_addr_ipv4),
      remotePlatform: str(n.sys_desc)?.split('\n')[0] ?? null,
    });
  }
  for (const { row: n } of rows(out['show cdp neighbors detail'], 'cdp_neighbor_detail_info')) {
    const local = longName(str(n.intf_id) ?? '');
    if (!local) continue;
    const id = str(n.device_id) ?? '';
    neighbors.push({
      localInterface: ifaces.get(local.toLowerCase())?.name ?? local,
      protocol: 'cdp',
      remoteChassisId: id,
      remoteSystemName: id.replace(/\(.*\)$/, '') || null,
      remotePortId: str(n.port_id) ?? '',
      remotePortDescription: null,
      remoteMgmtAddress: str(n.v4mgmtaddr) ?? str(n.v4addr),
      remotePlatform: str(n.platform_id),
    });
  }
  const bgp: DiscoveredBgpPeer[] = rows(out['show ip bgp summary vrf all'], 'neighbor').map(({ row: b, ctx }) => {
    const state = str(b.state) ?? 'unknown';
    const pfx = int(b.prefixreceived) ?? int(b.state);
    return {
      peer: str(b.neighborid) ?? '',
      remoteAs: int(b.neighboras),
      // NX-OS shows the received-prefix count in place of the state once established.
      state: /^\d+$/.test(state) ? 'established' : state.toLowerCase(),
      prefixesReceived: /^\d+$/.test(state) ? pfx : int(b.prefixreceived),
      uptimeSeconds: null,
      vrf: str(ctx['vrf-name-out']),
      description: null,
    };
  });
  const days = int(ver.kern_uptm_days) ?? 0;
  const uptime = ver.kern_uptm_secs !== undefined ? days * 86400 + (int(ver.kern_uptm_hrs) ?? 0) * 3600 + (int(ver.kern_uptm_mins) ?? 0) * 60 + (int(ver.kern_uptm_secs) ?? 0) : null;
  if (!out['show lldp neighbors detail'] && !out['show cdp neighbors detail']) warnings.push('No LLDP or CDP neighbor data (feature lldp / cdp enable)');
  return {
    facts: {
      sysName: str(ver.host_name),
      sysDescr: [str(ver.chassis_id), str(ver.nxos_ver_str) ?? str(ver.sys_ver_str)].filter(Boolean).join(' NX-OS ') || null,
      vendor: 'Cisco',
      model: str(ver.chassis_id)?.replace(/\s*chassis$/i, '') ?? null,
      serial: str(ver.proc_board_id),
      osVersion: str(ver.nxos_ver_str) ?? str(ver.sys_ver_str) ?? str(ver.kickstart_ver_str),
      uptimeSeconds: uptime,
    },
    interfaces: [...ifaces.values()],
    neighbors,
    bgp,
  };
}

/** Counters from `show interface` (64-bit); SVIs without byte counters are skipped. */
export function parseNxosCounters(version: Row | null, iface: unknown): CounterSnapshot {
  const v = version ?? {};
  const uptime = v.kern_uptm_secs !== undefined ? (int(v.kern_uptm_days) ?? 0) * 86400 + (int(v.kern_uptm_hrs) ?? 0) * 3600 + (int(v.kern_uptm_mins) ?? 0) * 60 + (int(v.kern_uptm_secs) ?? 0) : null;
  return {
    uptimeSeconds: uptime,
    interfaces: rows(iface, 'interface')
      .map(({ row: r }) => r)
      .filter((r) => str(r.interface) && counter(r.eth_inbytes) !== null)
      .map((r) => {
        const bw = int(r.eth_bw);
        return {
          name: String(r.interface),
          inOctets: counter(r.eth_inbytes),
          outOctets: counter(r.eth_outbytes),
          inPkts: counter(r.eth_inpkts),
          outPkts: counter(r.eth_outpkts),
          inErrors: counter(r.eth_inerr),
          outErrors: counter(r.eth_outerr),
          inDiscards: counter(r.eth_indiscard),
          outDiscards: counter(r.eth_outdiscard),
          bits: 64 as const,
          errorBits: 64 as const,
          speedBps: bw && bw > 0 ? bw * 1000 : null,
          operUp: str(r.state) ? str(r.state) === 'up' : null,
        };
      }),
  };
}

export function nxApiAdapter(): Adapter {
  const show = async (t: AdapterTarget, cmd: string): Promise<Row | null> => {
    const r = await deviceRequest(t, 'POST', '/ins', {
      headers: { Authorization: basicAuth(t.username, t.secret.password) },
      body: { ins_api: { version: '1.0', type: 'cli_show', chunk: '0', sid: '1', input: cmd, output_format: 'json' } },
      defaultPort: (t.params.scheme ?? 'https') === 'https' ? 443 : 80,
    });
    const output = ((r.json as Row | null)?.ins_api as Row | undefined)?.outputs as Row | undefined;
    const o = asArray(output?.output as Row | Row[])[0];
    if (!o) throw new DeviceHttpError('Unexpected NX-API response', r.status);
    if (str(o.code) !== '200') throw new DeviceHttpError(`${cmd}: ${str(o.msg) ?? 'error'} (${str(o.code)})`, r.status);
    return (o.body as Row) || null;
  };
  return {
    async test(t): Promise<TestResult> {
      const started = Date.now();
      const v = (await show(t, 'show version')) ?? {};
      return { ok: true, message: `Connected: ${str(v.host_name) ?? 'NX-OS'} — ${str(v.chassis_id) ?? ''} ${str(v.nxos_ver_str) ?? str(v.sys_ver_str) ?? ''}`.replace(/\s+/g, ' ').trim(), latencyMs: Date.now() - started, facts: { sysName: str(v.host_name), serial: str(v.proc_board_id), osVersion: str(v.nxos_ver_str) ?? str(v.sys_ver_str), vendor: 'Cisco' } };
    },
    async counters(t): Promise<CounterSnapshot> {
      const version = await show(t, 'show version');
      const iface = await show(t, 'show interface');
      return parseNxosCounters(version, iface);
    },
    async discover(t): Promise<DiscoveryResult> {
      const warnings: string[] = [];
      const out: Record<string, unknown> = {};
      out['show version'] = await show(t, 'show version');
      out['show interface'] = await show(t, 'show interface');
      if (!rows(out['show interface'], 'interface').length) throw new Error('NX-API returned no interfaces');
      for (const cmd of NXAPI_COMMANDS.slice(2)) {
        try {
          out[cmd] = await show(t, cmd);
        } catch (e) {
          if (e instanceof DeviceHttpError && (e.status === 401 || e.status === 403)) throw e;
          // Disabled features (e.g. "feature bgp" off) answer with an error; that's not fatal.
          warnings.push(`${cmd}: ${(e as Error).message}`);
        }
      }
      return { source: 'nxapi', collectedAt: new Date().toISOString(), ...parseNxos(out, warnings), warnings };
    },
  };
}
