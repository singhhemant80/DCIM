import * as snmp from 'net-snmp';

/**
 * A real SNMP agent (net-snmp's Agent, speaking v2c and v3 over UDP on
 * 127.0.0.1) populated with a small router: system group, IF-MIB, IP-MIB,
 * LLDP-MIB and BGP4-MIB. Used to exercise the SNMP collector end to end.
 * It is a simulator: passing tests against it is not proof of compatibility
 * with any particular vendor firmware.
 */
const T = snmp.ObjectType;
const RO = snmp.MaxAccess['read-only'];
const NA = snmp.MaxAccess['not-accessible'];

export interface SimIface {
  ifIndex: number;
  name: string;
  type: number;
  mtu: number;
  speedMbps: number;
  mac: string;
  admin: 1 | 2;
  oper: 1 | 2;
  alias?: string;
}
export interface SimNeighbor {
  localPort: number;
  chassisMac: string;
  portId: string;
  sysName: string;
  portDesc?: string;
  mgmt?: string;
}
export interface SimDevice {
  sysName: string;
  sysDescr: string;
  ifaces: SimIface[];
  ipv4: { ip: string; ifIndex: number; mask: string }[];
  lldp: SimNeighbor[];
  bgp: { peer: string; state: number; remoteAs: number; up: number }[];
}

export const DEFAULT_SIM: SimDevice = {
  sysName: 'edge-r1.example.net',
  sysDescr: 'RouterOS 7.14.2 (stable) CCR2004-1G-12S+2XS',
  ifaces: [
    { ifIndex: 1, name: 'ether1', type: 6, mtu: 1500, speedMbps: 1000, mac: '4c:5e:0c:00:00:01', admin: 1, oper: 1, alias: 'uplink to core' },
    { ifIndex: 2, name: 'sfp-sfpplus1', type: 6, mtu: 9000, speedMbps: 10000, mac: '4c:5e:0c:00:00:02', admin: 1, oper: 2 },
    { ifIndex: 3, name: 'sfp-sfpplus2', type: 6, mtu: 9000, speedMbps: 10000, mac: '4c:5e:0c:00:00:03', admin: 2, oper: 2 },
    { ifIndex: 4, name: 'lo', type: 24, mtu: 65535, speedMbps: 0, mac: '00:00:00:00:00:00', admin: 1, oper: 1 },
    { ifIndex: 5, name: 'vlan100', type: 135, mtu: 1500, speedMbps: 0, mac: '4c:5e:0c:00:00:01', admin: 1, oper: 1 },
  ],
  ipv4: [
    { ip: '10.0.1.2', ifIndex: 5, mask: '255.255.255.0' },
    { ip: '192.0.2.1', ifIndex: 4, mask: '255.255.255.255' },
  ],
  lldp: [{ localPort: 1, chassisMac: '4c:5e:0c:00:00:aa', portId: 'ether1', sysName: 'core-r2', portDesc: 'to edge', mgmt: '10.0.1.3' }],
  bgp: [
    { peer: '198.51.100.1', state: 6, remoteAs: 64500, up: 3600 },
    { peer: '198.51.100.5', state: 3, remoteAs: 64501, up: 0 },
  ],
};

const macBuf = (m: string) => Buffer.from(m.replace(/:/g, ''), 'hex');

export interface RunningAgent {
  port: number;
  close: () => void;
  /** Sets an interface counter (only with `counters` enabled). */
  setCounter: (ifIndex: number, counter: CounterName, value: bigint) => void;
  setOper: (ifIndex: number, up: boolean) => void;
  /** sysUpTime in hundredths of a second. */
  setUptime: (ticks: number) => void;
}
export type CounterName = 'inOctets' | 'outOctets' | 'inPkts' | 'outPkts' | 'inErrors' | 'outErrors' | 'inDiscards' | 'outDiscards';

const c64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt.asUintN(64, v));
  return b;
};
const c32 = (v: bigint) => Number(BigInt.asUintN(32, v));

export async function startSnmpAgent(port: number, sim: SimDevice = DEFAULT_SIM, opts: { community?: string; v3User?: { name: string; authKey: string; privKey: string }; counters?: 'hc' | '32' } = {}): Promise<RunningAgent> {
  const agent = snmp.createAgent({ port, address: '127.0.0.1', disableAuthorization: false }, () => undefined);
  const auth = agent.getAuthorizer();
  if (opts.community) auth.addCommunity(opts.community);
  if (opts.v3User) {
    auth.addUser({
      name: opts.v3User.name,
      level: snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols.sha,
      authKey: opts.v3User.authKey,
      privProtocol: snmp.PrivProtocols.aes,
      privKey: opts.v3User.privKey,
    });
  }
  const mib = agent.getMib();
  const scalar = (name: string, oid: string, type: number, value: unknown) => {
    mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO });
    mib.setScalarValue(name, value);
  };
  scalar('sysDescr', '1.3.6.1.2.1.1.1', T.OctetString, sim.sysDescr);
  scalar('sysObjectID', '1.3.6.1.2.1.1.2', T.OID, '1.3.6.1.4.1.14988.1');
  scalar('sysUpTime', '1.3.6.1.2.1.1.3', T.TimeTicks, 123456);
  scalar('sysName', '1.3.6.1.2.1.1.5', T.OctetString, sim.sysName);

  const table = (name: string, oid: string, cols: { number: number; name: string; type: number; access?: number }[], index: string[], rows: unknown[][]) => {
    mib.registerProvider({
      name,
      type: snmp.MibProviderType.Table,
      oid,
      maxAccess: NA,
      tableColumns: cols.map((c) => ({ number: c.number, name: c.name, type: c.type, maxAccess: c.access ?? RO })),
      tableIndex: index.map((columnName) => ({ columnName })),
    });
    for (const r of rows) mib.addTableRow(name, r);
  };

  table(
    'ifTable',
    '1.3.6.1.2.1.2.2.1',
    [
      { number: 1, name: 'ifIndex', type: T.Integer },
      { number: 2, name: 'ifDescr', type: T.OctetString },
      { number: 3, name: 'ifType', type: T.Integer },
      { number: 4, name: 'ifMtu', type: T.Integer },
      { number: 5, name: 'ifSpeed', type: T.Gauge },
      { number: 6, name: 'ifPhysAddress', type: T.OctetString },
      { number: 7, name: 'ifAdminStatus', type: T.Integer },
      { number: 8, name: 'ifOperStatus', type: T.Integer },
      ...(opts.counters
        ? [
            { number: 10, name: 'ifInOctets', type: T.Counter32 },
            { number: 11, name: 'ifInUcastPkts', type: T.Counter32 },
            { number: 13, name: 'ifInDiscards', type: T.Counter32 },
            { number: 14, name: 'ifInErrors', type: T.Counter32 },
            { number: 16, name: 'ifOutOctets', type: T.Counter32 },
            { number: 17, name: 'ifOutUcastPkts', type: T.Counter32 },
            { number: 19, name: 'ifOutDiscards', type: T.Counter32 },
            { number: 20, name: 'ifOutErrors', type: T.Counter32 },
          ]
        : []),
    ],
    ['ifIndex'],
    sim.ifaces.map((i) => [i.ifIndex, i.name, i.type, i.mtu, Math.min(i.speedMbps * 1_000_000, 4_294_967_295), macBuf(i.mac), i.admin, i.oper, ...(opts.counters ? [0, 0, 0, 0, 0, 0, 0, 0] : [])]),
  );
  table(
    'ifXTable',
    '1.3.6.1.2.1.31.1.1.1',
    [
      { number: 1, name: 'ifName', type: T.OctetString },
      ...(opts.counters === 'hc'
        ? [
            { number: 6, name: 'ifHCInOctets', type: T.Counter64 },
            { number: 7, name: 'ifHCInUcastPkts', type: T.Counter64 },
            { number: 10, name: 'ifHCOutOctets', type: T.Counter64 },
            { number: 11, name: 'ifHCOutUcastPkts', type: T.Counter64 },
          ]
        : []),
      { number: 15, name: 'ifHighSpeed', type: T.Gauge },
      { number: 18, name: 'ifAlias', type: T.OctetString },
      { number: 100, name: 'ifXIndex', type: T.Integer, access: NA },
    ],
    ['ifXIndex'],
    sim.ifaces.map((i) => [i.name, ...(opts.counters === 'hc' ? [c64(0n), c64(0n), c64(0n), c64(0n)] : []), i.speedMbps, i.alias ?? '', i.ifIndex]),
  );
  table(
    'ipAddrTable',
    '1.3.6.1.2.1.4.20.1',
    [
      { number: 1, name: 'ipAdEntAddr', type: T.IpAddress },
      { number: 2, name: 'ipAdEntIfIndex', type: T.Integer },
      { number: 3, name: 'ipAdEntNetMask', type: T.IpAddress },
    ],
    ['ipAdEntAddr'],
    sim.ipv4.map((a) => [a.ip, a.ifIndex, a.mask]),
  );
  table(
    'lldpLocPortTable',
    '1.0.8802.1.1.2.1.3.7.1',
    [
      { number: 1, name: 'lldpLocPortNum', type: T.Integer, access: NA },
      { number: 2, name: 'lldpLocPortIdSubtype', type: T.Integer },
      { number: 3, name: 'lldpLocPortId', type: T.OctetString },
      { number: 4, name: 'lldpLocPortDesc', type: T.OctetString },
    ],
    ['lldpLocPortNum'],
    sim.ifaces.map((i) => [i.ifIndex, 5, i.name, i.alias ?? '']),
  );
  table(
    'lldpRemTable',
    '1.0.8802.1.1.2.1.4.1.1',
    [
      { number: 1, name: 'lldpRemTimeMark', type: T.TimeTicks, access: NA },
      { number: 2, name: 'lldpRemLocalPortNum', type: T.Integer, access: NA },
      { number: 3, name: 'lldpRemIndex', type: T.Integer, access: NA },
      { number: 4, name: 'lldpRemChassisIdSubtype', type: T.Integer },
      { number: 5, name: 'lldpRemChassisId', type: T.OctetString },
      { number: 6, name: 'lldpRemPortIdSubtype', type: T.Integer },
      { number: 7, name: 'lldpRemPortId', type: T.OctetString },
      { number: 8, name: 'lldpRemPortDesc', type: T.OctetString },
      { number: 9, name: 'lldpRemSysName', type: T.OctetString },
      { number: 10, name: 'lldpRemSysDesc', type: T.OctetString },
    ],
    ['lldpRemTimeMark', 'lldpRemLocalPortNum', 'lldpRemIndex'],
    sim.lldp.map((n, i) => [0, n.localPort, i + 1, 4, macBuf(n.chassisMac), 5, n.portId, n.portDesc ?? '', n.sysName, 'RouterOS 7.15']),
  );
  table(
    'lldpRemManAddrTable',
    '1.0.8802.1.1.2.1.4.2.1',
    [
      { number: 101, name: 'manTimeMark', type: T.TimeTicks, access: NA },
      { number: 102, name: 'manLocalPortNum', type: T.Integer, access: NA },
      { number: 103, name: 'manRemIndex', type: T.Integer, access: NA },
      { number: 1, name: 'lldpRemManAddrSubtype', type: T.Integer, access: NA },
      { number: 2, name: 'lldpRemManAddr', type: T.OctetString, access: NA },
      { number: 3, name: 'lldpRemManAddrIfSubtype', type: T.Integer },
    ],
    ['manTimeMark', 'manLocalPortNum', 'manRemIndex', 'lldpRemManAddrSubtype', 'lldpRemManAddr'],
    sim.lldp.filter((n) => n.mgmt).map((n) => [0, n.localPort, sim.lldp.indexOf(n) + 1, 1, Buffer.from(n.mgmt!.split('.').map(Number)), 2]),
  );
  table(
    'bgpPeerTable',
    '1.3.6.1.2.1.15.3.1',
    [
      { number: 2, name: 'bgpPeerState', type: T.Integer },
      { number: 7, name: 'bgpPeerRemoteAddr', type: T.IpAddress },
      { number: 9, name: 'bgpPeerRemoteAs', type: T.Integer },
      { number: 16, name: 'bgpPeerFsmEstablishedTime', type: T.Gauge },
    ],
    ['bgpPeerRemoteAddr'],
    sim.bgp.map((b) => [b.state, b.peer, b.remoteAs, b.up]),
  );
  // Give the socket a moment to bind.
  await new Promise((r) => setTimeout(r, 50));
  const hcCol: Partial<Record<CounterName, number>> = { inOctets: 6, inPkts: 7, outOctets: 10, outPkts: 11 };
  const col32: Record<CounterName, number> = { inOctets: 10, inPkts: 11, inDiscards: 13, inErrors: 14, outOctets: 16, outPkts: 17, outDiscards: 19, outErrors: 20 };
  return {
    port,
    close: () => {
      try {
        agent.close();
      } catch {
        // already closed
      }
    },
    setCounter: (ifIndex, counter, value) => {
      if (!opts.counters) throw new Error('Counters are not enabled on this simulator');
      if (opts.counters === 'hc' && hcCol[counter]) mib.setTableSingleCell('ifXTable', hcCol[counter]!, [ifIndex], c64(value));
      mib.setTableSingleCell('ifTable', col32[counter], [ifIndex], c32(value));
    },
    setOper: (ifIndex, up) => mib.setTableSingleCell('ifTable', 8, [ifIndex], up ? 1 : 2),
    setUptime: (ticks) => mib.setScalarValue('sysUpTime', ticks),
  };
}
