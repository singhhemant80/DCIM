import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * HTTP mocks of the RouterOS REST, FortiOS REST and NX-API endpoints the
 * collectors read. Response shapes follow the vendors' published API
 * documentation; they are fixtures, not captures from real hardware.
 */
export interface MockDevice {
  port: number;
  requests: { method: string; url: string; authorization?: string; body?: string }[];
  close: () => Promise<void>;
}

async function serve(handler: (req: http.IncomingMessage, body: string) => { status: number; json?: unknown }): Promise<MockDevice> {
  const requests: MockDevice['requests'] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, body });
      const r = handler(req, body);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests, close: () => new Promise((r) => server.close(() => r())) };
}

// ----------------------------------------------------------------- RouterOS

export const ROUTEROS_FIXTURE: Record<string, unknown> = {
  '/rest/system/resource': { uptime: '2w3d04:05:06', version: '7.14.2 (stable)', 'board-name': 'CCR2004-1G-12S+2XS', 'cpu-load': '3' },
  '/rest/system/identity': { name: 'edge-r1' },
  '/rest/system/routerboard': { model: 'CCR2004-1G-12S+2XS', 'serial-number': 'HD5087ABC12', routerboard: 'true' },
  '/rest/interface': [
    { '.id': '*1', name: 'ether1', type: 'ether', 'mac-address': '48:A9:8A:00:00:01', mtu: '1500', 'actual-mtu': '1500', running: 'true', disabled: 'false', comment: 'uplink' },
    { '.id': '*2', name: 'sfp-sfpplus1', type: 'ether', 'mac-address': '48:A9:8A:00:00:02', mtu: '9000', 'actual-mtu': '9000', running: 'true', disabled: 'false' },
    { '.id': '*3', name: 'sfp-sfpplus2', type: 'ether', 'mac-address': '48:A9:8A:00:00:03', mtu: '9000', 'actual-mtu': '9000', running: 'true', disabled: 'false' },
    { '.id': '*4', name: 'bond1', type: 'bond', 'mac-address': '48:A9:8A:00:00:02', mtu: '9000', 'actual-mtu': '9000', running: 'true', disabled: 'false' },
    { '.id': '*5', name: 'vlan100', type: 'vlan', 'mac-address': '48:A9:8A:00:00:02', mtu: '1500', 'actual-mtu': '1500', running: 'true', disabled: 'false' },
    { '.id': '*6', name: 'wg0', type: 'wg', mtu: '1420', 'actual-mtu': '1420', running: 'false', disabled: 'true' },
  ],
  '/rest/interface/ethernet': [
    { name: 'ether1', speed: '1G-baseT-full' },
    { name: 'sfp-sfpplus1', speed: '10G-baseSR-LR' },
    { name: 'sfp-sfpplus2', speed: '10G-baseSR-LR' },
  ],
  '/rest/interface/bonding': [{ name: 'bond1', slaves: 'sfp-sfpplus1,sfp-sfpplus2', mode: '802.3ad' }],
  '/rest/ip/address': [
    { address: '203.0.113.2/30', interface: 'ether1', 'actual-interface': 'ether1', disabled: 'false', invalid: 'false' },
    { address: '10.20.0.1/24', interface: 'vlan100', 'actual-interface': 'vlan100', disabled: 'false', invalid: 'false' },
  ],
  '/rest/ipv6/address': [{ address: '2001:db8:100::1/64', interface: 'vlan100', 'actual-interface': 'vlan100', disabled: 'false', invalid: 'false' }],
  '/rest/ip/neighbor': [{ interface: 'ether1', address: '203.0.113.1', 'mac-address': '48:A9:8A:FF:00:01', identity: 'core-r2', platform: 'MikroTik', version: '7.15', board: 'CCR2116', 'interface-name': 'ether5', 'discovered-by': 'lldp,mndp' }],
  '/rest/routing/bgp/session': [{ name: 'transit-1', 'remote.address': '203.0.113.1', 'remote.as': '64500', established: 'true', uptime: '1d2h3m4s', 'prefix-count': '950000' }],
};

export function startRouterOs(user: string, pass: string, fixture = ROUTEROS_FIXTURE) {
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  return serve((req) => {
    if (req.method !== 'GET') return { status: 405, json: { error: 405, message: 'Method Not Allowed' } };
    if (req.headers.authorization !== expected) return { status: 401, json: { error: 401, message: 'Unauthorized' } };
    const body = fixture[req.url!.split('?')[0]!];
    return body === undefined ? { status: 404, json: { error: 404, message: 'Not Found' } } : { status: 200, json: body };
  });
}

// ------------------------------------------------------------------ FortiOS

export const FORTIOS_FIXTURE: Record<string, unknown> = {
  '/api/v2/monitor/system/status': { http_method: 'GET', status: 'success', serial: 'FGT60FTK2209XXXX', version: 'v7.4.3', build: 2573, results: { model_name: 'FortiGate', model_number: '60F', model: 'FGT60F', hostname: 'fw-edge-1' } },
  '/api/v2/cmdb/system/interface': {
    status: 'success',
    results: [
      { name: 'wan1', type: 'physical', status: 'up', ip: '198.51.100.10 255.255.255.248', alias: 'ISP-A', mtu: 1500, 'mtu-override': 'disable', member: [] },
      { name: 'internal1', type: 'physical', status: 'up', ip: '0.0.0.0 0.0.0.0', member: [] },
      { name: 'internal2', type: 'physical', status: 'up', ip: '0.0.0.0 0.0.0.0', member: [] },
      { name: 'lan-agg', type: 'aggregate', status: 'up', ip: '10.30.0.1 255.255.255.0', member: [{ 'interface-name': 'internal1' }, { 'interface-name': 'internal2' }] },
      { name: 'dmz', type: 'physical', status: 'down', ip: '0.0.0.0 0.0.0.0', description: 'unused', member: [] },
    ],
  },
  '/api/v2/monitor/system/interface': {
    status: 'success',
    results: {
      wan1: { id: 'wan1', name: 'wan1', alias: 'ISP-A', mac: '04:d5:90:00:00:01', ip: '198.51.100.10', mask: 29, link: true, speed: 1000, duplex: 1 },
      internal1: { id: 'internal1', name: 'internal1', mac: '04:d5:90:00:00:02', ip: '0.0.0.0', mask: 0, link: true, speed: 1000 },
      internal2: { id: 'internal2', name: 'internal2', mac: '04:d5:90:00:00:03', ip: '0.0.0.0', mask: 0, link: true, speed: 1000 },
      'lan-agg': { id: 'lan-agg', name: 'lan-agg', mac: '04:d5:90:00:00:02', ip: '10.30.0.1', mask: 24, link: true, speed: 2000 },
      dmz: { id: 'dmz', name: 'dmz', mac: '04:d5:90:00:00:05', ip: '0.0.0.0', mask: 0, link: false, speed: 0 },
    },
  },
  '/api/v2/monitor/router/bgp/neighbors': { status: 'success', results: [{ neighbor_ip: '198.51.100.9', local_ip: '198.51.100.10', remote_as: 64510, admin_status: true, state: 'Established', type: 'ipv4' }] },
  '/api/v2/monitor/network/lldp/neighbors': { status: 'success', results: [{ port: 'wan1', chassis_id: '00:11:22:33:44:55', port_id: 'Gi0/1', port_description: 'to fw', system_name: 'isp-a-ce', system_description: 'Cisco IOS', addresses: [{ address: '198.51.100.9' }] }] },
};

export function startFortiOs(token: string, fixture = FORTIOS_FIXTURE) {
  return serve((req) => {
    if (req.method !== 'GET') return { status: 405 };
    if (req.headers.authorization !== `Bearer ${token}`) return { status: 401, json: { status: 'error', http_status: 401 } };
    if (/access_token=/.test(req.url!)) return { status: 400, json: { status: 'error', message: 'token must not be in the URL' } };
    const body = fixture[req.url!.split('?')[0]!];
    return body === undefined ? { status: 404, json: { status: 'error', http_status: 404 } } : { status: 200, json: body };
  });
}

// ------------------------------------------------------------------- NX-API

const nx = (body: unknown, code = '200', msg = 'Success') => ({ ins_api: { type: 'cli_show', version: '1.0', sid: 'eoc', outputs: { output: { input: '', msg, code, body } } } });

export const NXOS_FIXTURE: Record<string, unknown> = {
  'show version': { host_name: 'leaf-101', chassis_id: 'Nexus9000 C93180YC-EX chassis', proc_board_id: 'FDO21XXXXXX', nxos_ver_str: '9.3(8)', kern_uptm_days: 12, kern_uptm_hrs: 3, kern_uptm_mins: 4, kern_uptm_secs: 5 },
  'show interface': {
    TABLE_interface: {
      ROW_interface: [
        { interface: 'mgmt0', state: 'up', admin_state: 'up', eth_hw_addr: '00de.fb00.0001', eth_mtu: '1500', eth_bw: 1000000 },
        { interface: 'Ethernet1/1', state: 'up', admin_state: 'up', eth_hw_addr: '00de.fb00.1101', eth_mtu: '9216', eth_bw: 10000000, desc: 'to spine-1' },
        { interface: 'Ethernet1/2', state: 'down', admin_state: 'down', eth_hw_addr: '00de.fb00.1102', eth_mtu: '9216', eth_bw: 10000000 },
        { interface: 'Ethernet1/49', state: 'up', admin_state: 'up', eth_hw_addr: '00de.fb00.1149', eth_mtu: '9216', eth_bw: 100000000 },
        { interface: 'port-channel10', state: 'up', admin_state: 'up', eth_hw_addr: '00de.fb00.1149', eth_mtu: '9216', eth_bw: 100000000 },
        { interface: 'Vlan100', svi_admin_state: 'up', svi_line_proto: 'up', svi_mac: '00de.fb00.0100', svi_mtu: '9216', svi_bw: 1000000 },
        { interface: 'loopback0', state: 'up', admin_state: 'up' },
      ],
    },
  },
  'show ip interface vrf all': { TABLE_intf: [{ ROW_intf: { 'intf-name': 'Vlan100', prefix: '10.40.0.2', masklen: '24' } }, { ROW_intf: { 'intf-name': 'loopback0', prefix: '192.0.2.101', masklen: '32' } }] },
  'show port-channel summary': { TABLE_channel: { ROW_channel: { group: '10', 'port-channel': 'port-channel10', TABLE_member: { ROW_member: { port: 'Ethernet1/49', 'port-status': 'P' } } } } },
  'show lldp neighbors detail': { TABLE_nbor_detail: { ROW_nbor_detail: { chassis_id: '00de.fb99.0001', port_id: 'Ethernet1/1', l_port_id: 'Eth1/1', sys_name: 'spine-1', sys_desc: 'Cisco Nexus Operating System (NX-OS) Software 9.3(8)', mgmt_addr: '10.0.0.11' } } },
  'show ip bgp summary vrf all': {
    TABLE_vrf: {
      ROW_vrf: {
        'vrf-name-out': 'default',
        TABLE_af: { ROW_af: { 'af-id': 1, TABLE_saf: { ROW_saf: { 'safi': 1, TABLE_neighbor: { ROW_neighbor: [{ neighborid: '10.0.0.11', neighboras: '65000', state: 'Established', prefixreceived: '120' }, { neighborid: '10.0.0.12', neighboras: '65000', state: 'Idle', prefixreceived: '0' }] } } } } },
      },
    },
  },
};

export function startNxApi(user: string, pass: string, fixture = NXOS_FIXTURE) {
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  return serve((req, body) => {
    if (req.method !== 'POST' || req.url !== '/ins') return { status: 404 };
    if (req.headers.authorization !== expected) return { status: 401 };
    const cmd = (JSON.parse(body) as { ins_api: { input: string; type: string } }).ins_api;
    if (cmd.type !== 'cli_show') return { status: 200, json: nx(null, '400', 'Only show commands are permitted') };
    // "feature cdp" is off on this mock switch.
    if (!(cmd.input in fixture)) return { status: 200, json: nx(null, '400', 'Input CLI command error') };
    return { status: 200, json: nx(fixture[cmd.input]) };
  });
}
