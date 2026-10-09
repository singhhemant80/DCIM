import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snmpAdapter } from '../src/worker/adapters/snmp';
import { fortiOsAdapter } from '../src/worker/adapters/fortios';
import { nxApiAdapter, longName } from '../src/worker/adapters/nxapi';
import { routerosUptime } from '../src/worker/adapters/routeros';
import { redact } from '../src/worker/processor';
import { startSnmpAgent, type RunningAgent } from './simulators/snmp-agent';
import { startFortiOs, startNxApi, type MockDevice } from './simulators/http-devices';
import type { AdapterTarget } from '../src/network/discovery/types';

/**
 * Collectors against simulators. These prove the protocol handling and
 * parsing against documented response shapes; they do not prove
 * compatibility with any specific firmware release.
 */
const SNMP_PORT = 17100 + Math.floor(Math.random() * 800);
let agent: RunningAgent;
let forti: MockDevice;
let nexus: MockDevice;
const TOKEN = 'fgt-token-abcdef123456';

beforeAll(async () => {
  agent = await startSnmpAgent(SNMP_PORT, undefined, { v3User: { name: 'dcim-ro', authKey: 'auth-key-123', privKey: 'priv-key-456' } });
  forti = await startFortiOs(TOKEN);
  nexus = await startNxApi('admin', 'nx-pass-1');
});
afterAll(async () => {
  agent?.close();
  await forti?.close();
  await nexus?.close();
});

const http = (port: number, extra: Partial<AdapterTarget>): AdapterTarget => ({ host: '127.0.0.1', port, params: { scheme: 'http', timeoutMs: 2000 }, secret: {}, ...extra });

describe('SNMPv3', () => {
  const v3 = (authKey: string): AdapterTarget => ({ host: '127.0.0.1', port: SNMP_PORT, username: 'dcim-ro', params: { securityLevel: 'authPriv', authProtocol: 'sha', privProtocol: 'aes', timeoutMs: 600, retries: 0 }, secret: { authKey, privKey: 'priv-key-456' } });

  it('discovers with authPriv', async () => {
    const r = await snmpAdapter('snmp_v3').discover(v3('auth-key-123'));
    expect(r.facts.sysName).toBe('edge-r1.example.net');
    expect(r.interfaces).toHaveLength(5);
    expect(r.interfaces.find((i) => i.name === 'vlan100')!.addresses).toEqual(['10.0.1.2/24']);
    expect(r.neighbors[0]).toMatchObject({ localInterface: 'ether1', remoteSystemName: 'core-r2', remoteMgmtAddress: '10.0.1.3', remoteChassisId: '4c:5e:0c:00:00:aa' });
  });

  it('fails with a wrong key', async () => {
    await expect(snmpAdapter('snmp_v3').test(v3('wrong-key-999'))).rejects.toThrow();
  });
});

describe('FortiOS REST', () => {
  it('collects interfaces, aggregates, BGP and LLDP with a bearer token', async () => {
    const r = await fortiOsAdapter().discover(http(forti.port, { secret: { token: TOKEN }, params: { scheme: 'http', vdom: 'root', timeoutMs: 2000 } }));
    expect(r.facts).toMatchObject({ sysName: 'fw-edge-1', serial: 'FGT60FTK2209XXXX', vendor: 'Fortinet' });
    const byName = Object.fromEntries(r.interfaces.map((i) => [i.name, i]));
    expect(byName.wan1).toMatchObject({ kind: 'physical', speedBps: 1e9, operUp: true, addresses: ['198.51.100.10/29'] });
    expect(byName['lan-agg']).toMatchObject({ kind: 'lag', addresses: ['10.30.0.1/24'] });
    expect(byName.internal1!.lagName).toBe('lan-agg');
    expect(byName.dmz).toMatchObject({ adminUp: false, operUp: false });
    expect(r.bgp).toEqual([expect.objectContaining({ peer: '198.51.100.9', remoteAs: 64510, state: 'established' })]);
    expect(r.neighbors[0]).toMatchObject({ localInterface: 'wan1', remoteSystemName: 'isp-a-ce', remotePortId: 'Gi0/1' });
    // Token only ever in the Authorization header; vdom passed as a parameter; GET only.
    expect(forti.requests.every((q) => q.method === 'GET' && q.authorization === `Bearer ${TOKEN}` && !q.url.includes(TOKEN))).toBe(true);
    expect(forti.requests.every((q) => q.url.includes('vdom=root'))).toBe(true);
  });

  it('reports a bad token as an authentication failure', async () => {
    await expect(fortiOsAdapter().test(http(forti.port, { secret: { token: 'nope' } }))).rejects.toThrow(/Authentication failed/);
  });
});

describe('NX-API', () => {
  it('collects with show commands only and tolerates disabled features', async () => {
    const r = await nxApiAdapter().discover(http(nexus.port, { username: 'admin', secret: { password: 'nx-pass-1' } }));
    expect(r.facts).toMatchObject({ sysName: 'leaf-101', serial: 'FDO21XXXXXX', osVersion: '9.3(8)', model: 'Nexus9000 C93180YC-EX', uptimeSeconds: 12 * 86400 + 3 * 3600 + 4 * 60 + 5 });
    const byName = Object.fromEntries(r.interfaces.map((i) => [i.name, i]));
    expect(byName['Ethernet1/1']).toMatchObject({ kind: 'physical', speedBps: 1e10, macAddress: '00:de:fb:00:11:01', mtu: 9216, description: 'to spine-1' });
    expect(byName['Ethernet1/49']!.lagName).toBe('port-channel10');
    expect(byName.mgmt0!.kind).toBe('management');
    expect(byName.Vlan100).toMatchObject({ kind: 'vlan', addresses: ['10.40.0.2/24'] });
    expect(r.neighbors).toEqual([expect.objectContaining({ localInterface: 'Ethernet1/1', remoteSystemName: 'spine-1', remotePortId: 'Ethernet1/1' })]);
    expect(r.bgp.map((b) => [b.peer, b.state, b.vrf])).toEqual([
      ['10.0.0.11', 'established', 'default'],
      ['10.0.0.12', 'idle', 'default'],
    ]);
    // CDP is disabled on the mock: a warning, not a failure.
    expect(r.warnings.join(' ')).toMatch(/cdp/i);
    const sent = nexus.requests.map((q) => JSON.parse(q.body!).ins_api);
    expect(sent.every((c: { type: string; input: string }) => c.type === 'cli_show' && c.input.startsWith('show '))).toBe(true);
  });

  it('wrong password', async () => {
    await expect(nxApiAdapter().test(http(nexus.port, { username: 'admin', secret: { password: 'bad' } }))).rejects.toThrow(/Authentication failed/);
  });

  it('expands abbreviated interface names', () => {
    expect(longName('Eth1/1')).toBe('Ethernet1/1');
    expect(longName('Po10')).toBe('port-channel10');
    expect(longName('mgmt0')).toBe('mgmt0');
  });
});

describe('helpers', () => {
  it('parses RouterOS uptimes', () => {
    expect(routerosUptime('2w3d04:05:06')).toBe(2 * 604800 + 3 * 86400 + 4 * 3600 + 5 * 60 + 6);
    expect(routerosUptime('1d2h3m4s')).toBe(86400 + 7200 + 180 + 4);
  });

  it('redacts secrets echoed in error messages', () => {
    expect(redact('login failed for token abc12345 at host', { token: 'abc12345' })).toBe('login failed for token [redacted] at host');
  });

  it('unreachable devices fail fast with a clear message', async () => {
    const r = await fortiOsAdapter().test({ host: '127.0.0.1', port: 1, params: { scheme: 'http', timeoutMs: 1000 }, secret: { token: 'x' } }).catch((e: Error) => e.message);
    expect(r).toMatch(/ECONNREFUSED/);
  });
});
