import * as snmp from 'net-snmp';
import { formatIp, type InterfaceKind } from '@crapplet/shared';
import type { PowerSnapshot, Adapter, AdapterTarget, CounterReading, CounterSnapshot, DiscoveredBgpPeer, DiscoveredInterface, DiscoveredNeighbor, DiscoveryResult, DeviceFacts, TestResult } from '../../network/discovery/types';

/**
 * Read-only SNMP collector (v2c and v3). Only GET and GETBULK are issued.
 *
 * MIBs: SNMPv2-MIB system group, IF-MIB ifTable/ifXTable, IP-MIB
 * ipAddrTable/ipAddressTable, IEEE8023-LAG-MIB, LLDP-MIB, CISCO-CDP-MIB,
 * BGP4-MIB (IPv4 peers) and ENTITY-MIB. Optional tables that the device
 * does not implement are reported as warnings, not failures.
 */

export const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  ifEntry: '1.3.6.1.2.1.2.2.1',
  ifXEntry: '1.3.6.1.2.1.31.1.1.1',
  ipAddrEntry: '1.3.6.1.2.1.4.20.1',
  ipAddressEntry: '1.3.6.1.2.1.4.34.1',
  lagPortAttached: '1.2.840.10006.300.43.1.2.1.1.13',
  lldpLocPortEntry: '1.0.8802.1.1.2.1.3.7.1',
  lldpRemEntry: '1.0.8802.1.1.2.1.4.1.1',
  lldpRemManAddrEntry: '1.0.8802.1.1.2.1.4.2.1',
  cdpCacheEntry: '1.3.6.1.4.1.9.9.23.1.2.1.1',
  bgpPeerEntry: '1.3.6.1.2.1.15.3.1',
  entPhysicalEntry: '1.3.6.1.2.1.47.1.1.1.1',
} as const;

export type Value = string | number | bigint | Buffer | null;
/** A walked table: column number → (index suffix → value). */
export type Table = Map<number, Map<string, Value>>;

export interface SnmpTransport {
  get(oids: string[]): Promise<Map<string, Value>>;
  walk(base: string): Promise<Table>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function normalize(vb: snmp.Varbind): Value {
  const v = vb.value;
  if (v === null || v === undefined) return null;
  // Counter64 arrives as a Buffer; ObjectType 70.
  if (vb.type === 70 && Buffer.isBuffer(v)) return v.length ? BigInt(`0x${v.toString('hex')}`) : 0n;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || Buffer.isBuffer(v)) return v;
  return String(v);
}

function friendly(err: Error): Error {
  if (/timed out/i.test(err.message)) {
    return new Error('No SNMP response: check the address and port, the community or v3 user/keys, the device ACL and that UDP/161 is reachable');
  }
  return err;
}

export function createTransport(t: AdapterTarget, kind: 'snmp_v2c' | 'snmp_v3'): SnmpTransport {
  const options = {
    port: t.port ?? 161,
    retries: t.params.retries ?? 1,
    timeout: t.params.timeoutMs ?? 3000,
    transport: t.host.includes(':') ? 'udp6' : 'udp4',
    version: kind === 'snmp_v3' ? snmp.Version3 : snmp.Version2c,
    idBitsSize: 32,
  };
  let session: snmp.Session;
  if (kind === 'snmp_v2c') {
    session = snmp.createSession(t.host, String(t.secret.community ?? ''), options);
  } else {
    const level = t.params.securityLevel ?? 'authPriv';
    const user: Record<string, unknown> = { name: t.username, level: snmp.SecurityLevel[level] };
    if (level !== 'noAuthNoPriv') {
      user.authProtocol = snmp.AuthProtocols[t.params.authProtocol ?? 'sha'];
      user.authKey = t.secret.authKey;
    }
    if (level === 'authPriv') {
      user.privProtocol = snmp.PrivProtocols[t.params.privProtocol ?? 'aes'];
      user.privKey = t.secret.privKey;
    }
    session = snmp.createV3Session(t.host, user, options);
  }
  session.on('error', () => undefined);
  return {
    get: (oids) =>
      new Promise((resolve, reject) => {
        session.get(oids, (err, vbs) => {
          if (err) return reject(friendly(err));
          const out = new Map<string, Value>();
          for (const vb of vbs) if (!snmp.isVarbindError(vb)) out.set(vb.oid, normalize(vb));
          resolve(out);
        });
      }),
    walk: (base) =>
      new Promise((resolve, reject) => {
        const table: Table = new Map();
        let count = 0;
        let last = '';
        session.subtree(
          base,
          20,
          (vbs) => {
            for (const vb of vbs) {
              // noSuchObject / endOfMibView, a non-advancing OID or one outside the subtree ends the walk.
              // (Without this, net-snmp re-requests the same OID forever past the end of an agent's MIB.)
              if (snmp.isVarbindError(vb) || vb.oid === last || !vb.oid.startsWith(`${base}.`)) return true;
              last = vb.oid;
              const rest = vb.oid.slice(base.length + 1).split('.');
              const col = Number(rest[0]);
              const idx = rest.slice(1).join('.');
              if (!table.has(col)) table.set(col, new Map());
              table.get(col)!.set(idx, normalize(vb));
              // Guard against devices that loop or return huge tables.
              if (++count > 200_000) return true;
            }
            return false;
          },
          (err) => (err ? reject(friendly(err)) : resolve(table)),
        );
      }),
    close: () => {
      try {
        session.close();
      } catch {
        /* already closed */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export function text(v: Value | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) {
    const s = v.toString('utf8');
    // Binary octet strings (MAC addresses, ids) are rendered as hex.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f\x7f]|�/.test(s)) return v.toString('hex').match(/../g)?.join(':') ?? '';
    return s.replace(/\0+$/, '').trim();
  }
  return String(v).trim();
}

export function num(v: Value | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(Buffer.isBuffer(v) ? v.toString() : v);
  return Number.isFinite(n) ? n : null;
}

export function mac(v: Value | undefined): string | null {
  if (!Buffer.isBuffer(v)) {
    const s = text(v);
    return s && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(s) ? s.toLowerCase().replace(/-/g, ':') : null;
  }
  if (v.length !== 6) return null;
  return v.toString('hex').match(/../g)!.join(':');
}

const IFTYPE_KIND: Record<number, InterfaceKind> = {
  6: 'physical', // ethernetCsmacd
  62: 'physical', // fastEther
  69: 'physical', // fastEtherFX
  117: 'physical', // gigabitEthernet
  24: 'loopback', // softwareLoopback
  161: 'lag', // ieee8023adLag
  54: 'lag', // propMultiplexor (some vendors)
  135: 'vlan', // l2vlan
  136: 'vlan', // l3ipvlan
  53: 'virtual', // propVirtual
  131: 'tunnel', // tunnel
  150: 'tunnel', // mplsTunnel
  209: 'bridge', // bridge
};

export function kindFor(ifType: number | null, name: string): InterfaceKind {
  if (/^(mgmt|management|me0|fxp0|em0)/i.test(name)) return 'management';
  if (/^(port-channel|po\d|bond|ae\d)/i.test(name)) return 'lag';
  return (ifType !== null && IFTYPE_KIND[ifType]) || 'virtual';
}

/** Decodes an OID index of the form "<len>.<b1>…<bn>" or fixed-length bytes into an IP string. */
function ipFromSubids(parts: number[]): string | null {
  if (parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  if (parts.length === 4) return parts.join('.');
  if (parts.length === 16) return formatIp(6, parts.reduce((a, b) => (a << 8n) | BigInt(b), 0n));
  return null;
}

function maskLength(mask: string): number {
  return mask.split('.').reduce((a, o) => a + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0);
}

// ---------------------------------------------------------------------------
// Parsers (pure; unit-tested against fixtures and the SNMP simulator)
// ---------------------------------------------------------------------------

export function parseFacts(sys: Map<string, Value>, ent: Table | null): DeviceFacts {
  const descr = text(sys.get(OID.sysDescr));
  const ticks = num(sys.get(OID.sysUpTime));
  const facts: DeviceFacts = { sysName: text(sys.get(OID.sysName)), sysDescr: descr, uptimeSeconds: ticks !== null ? Math.floor(ticks / 100) : null };
  if (ent) {
    // First chassis (entPhysicalClass = 3).
    const cls = ent.get(5);
    const idx = cls ? [...cls.entries()].find(([, v]) => num(v) === 3)?.[0] : undefined;
    if (idx) {
      facts.serial = text(ent.get(11)?.get(idx)) || null;
      facts.model = text(ent.get(13)?.get(idx)) || null;
      facts.vendor = text(ent.get(12)?.get(idx)) || null;
      facts.osVersion = text(ent.get(10)?.get(idx)) || null;
    }
  }
  if (descr) {
    const ros = descr.match(/RouterOS\s+(\S+)/i);
    const nx = descr.match(/NX-OS.*?Version\s+([^\s,]+)/i);
    const ios = descr.match(/Cisco IOS.*?Version\s+([^\s,]+)/i);
    const forti = descr.match(/(FortiGate|FortiOS)[^\d]*(v?\d+\.\d+\.\d+)/i);
    facts.osVersion ||= ros?.[1] ?? nx?.[1] ?? ios?.[1] ?? forti?.[2] ?? null;
    if (!facts.vendor) facts.vendor = ros ? 'MikroTik' : nx || ios ? 'Cisco' : forti ? 'Fortinet' : null;
  }
  return facts;
}

export function parseInterfaces(ifTable: Table, ifX: Table | null, ipv4: Table | null, ipAddress: Table | null, lag: Table | null): DiscoveredInterface[] {
  const descr = ifTable.get(2) ?? new Map<string, Value>();
  const byIndex = new Map<number, DiscoveredInterface>();
  for (const [idx, d] of descr) {
    const ifIndex = Number(idx);
    const name = text(ifX?.get(1)?.get(idx)) || text(d) || `ifIndex${idx}`;
    const ifType = num(ifTable.get(3)?.get(idx));
    const high = num(ifX?.get(15)?.get(idx));
    const low = num(ifTable.get(5)?.get(idx));
    const admin = num(ifTable.get(7)?.get(idx));
    const oper = num(ifTable.get(8)?.get(idx));
    byIndex.set(ifIndex, {
      name: name.slice(0, 64),
      ifIndex,
      kind: kindFor(ifType, name),
      description: text(ifX?.get(18)?.get(idx)) || null,
      macAddress: mac(ifTable.get(6)?.get(idx)),
      mtu: num(ifTable.get(4)?.get(idx)) || null,
      speedBps: high && high > 0 ? high * 1_000_000 : low && low > 0 && low < 4_294_967_295 ? low : null,
      adminUp: admin === null ? null : admin === 1,
      operUp: oper === null ? null : oper === 1,
      addresses: [],
      lagName: null,
    });
  }
  // IPv4 (ipAddrTable): index is the address; col 2 ifIndex, col 3 netmask.
  for (const [ip, ifv] of ipv4?.get(2) ?? []) {
    const i = byIndex.get(num(ifv) ?? -1);
    const mask = text(ipv4?.get(3)?.get(ip));
    if (i && mask) i.addresses!.push(`${ip}/${maskLength(mask)}`);
  }
  // IPv6 (ipAddressTable): index = type.len.bytes; col 3 ifIndex, col 5 prefix pointer ending in the length.
  for (const [idx, ifv] of ipAddress?.get(3) ?? []) {
    const parts = idx.split('.').map(Number);
    if (parts[0] !== 2 || parts[1] !== 16) continue;
    const ip = ipFromSubids(parts.slice(2, 18));
    const ptr = text(ipAddress?.get(5)?.get(idx));
    const len = ptr ? Number(ptr.split('.').pop()) : NaN;
    const i = byIndex.get(num(ifv) ?? -1);
    if (i && ip && Number.isInteger(len) && len >= 0 && len <= 128) i.addresses!.push(`${ip}/${len}`);
  }
  // LAG membership: port ifIndex → aggregator ifIndex.
  for (const [idx, agg] of lag?.get(13) ?? []) {
    const port = byIndex.get(Number(idx));
    const a = byIndex.get(num(agg) ?? -1);
    if (port && a && port !== a && num(agg)) port.lagName = a.name;
  }
  return [...byIndex.values()];
}

export function parseLldp(rem: Table | null, locPort: Table | null, manAddr: Table | null, ifaces: DiscoveredInterface[]): DiscoveredNeighbor[] {
  if (!rem) return [];
  const byIndex = new Map(ifaces.filter((i) => i.ifIndex).map((i) => [i.ifIndex!, i.name]));
  const byName = new Map(ifaces.map((i) => [i.name.toLowerCase(), i.name]));
  const localName = (portNum: string) => {
    const locId = text(locPort?.get(3)?.get(portNum));
    const locDesc = text(locPort?.get(4)?.get(portNum));
    return (locId && byName.get(locId.toLowerCase())) || (locDesc && byName.get(locDesc.toLowerCase())) || byIndex.get(Number(portNum)) || locId || null;
  };
  // Management addresses: index timeMark.localPort.remIndex.subtype.len.bytes…
  const mgmt = new Map<string, string>();
  for (const idx of manAddr?.get(3)?.keys() ?? []) {
    const p = idx.split('.').map(Number);
    const key = p.slice(0, 3).join('.');
    if (p[3] === 1 && p[4] === 4 && !mgmt.has(key)) mgmt.set(key, p.slice(5, 9).join('.'));
    else if (p[3] === 2 && p[4] === 16 && !mgmt.has(key)) mgmt.set(key, ipFromSubids(p.slice(5, 21)) ?? '');
  }
  const out: DiscoveredNeighbor[] = [];
  for (const [idx, chassis] of rem.get(5) ?? []) {
    const p = idx.split('.');
    const local = localName(p[1]!);
    if (!local) continue;
    const chassisSubtype = num(rem.get(4)?.get(idx));
    const portSubtype = num(rem.get(6)?.get(idx));
    const portRaw = rem.get(7)?.get(idx);
    out.push({
      localInterface: local,
      protocol: 'lldp',
      remoteChassisId: (chassisSubtype === 4 ? mac(chassis) : null) ?? text(chassis) ?? '',
      remotePortId: (portSubtype === 3 ? mac(portRaw) : null) ?? text(portRaw) ?? '',
      remotePortDescription: text(rem.get(8)?.get(idx)) || null,
      remoteSystemName: text(rem.get(9)?.get(idx)) || null,
      remotePlatform: text(rem.get(10)?.get(idx))?.split('\n')[0]?.slice(0, 200) || null,
      remoteMgmtAddress: mgmt.get(p.slice(0, 3).join('.')) || null,
    });
  }
  return out;
}

export function parseCdp(cdp: Table | null, ifaces: DiscoveredInterface[]): DiscoveredNeighbor[] {
  if (!cdp) return [];
  const byIndex = new Map(ifaces.filter((i) => i.ifIndex).map((i) => [i.ifIndex!, i.name]));
  const out: DiscoveredNeighbor[] = [];
  for (const [idx, devId] of cdp.get(6) ?? []) {
    const local = byIndex.get(Number(idx.split('.')[0]));
    if (!local) continue;
    const addr = cdp.get(4)?.get(idx);
    const ip = Buffer.isBuffer(addr) && addr.length === 4 ? [...addr].join('.') : null;
    const id = text(devId) ?? '';
    out.push({
      localInterface: local,
      protocol: 'cdp',
      remoteChassisId: id,
      remoteSystemName: id.replace(/\(.*\)$/, '') || null,
      remotePortId: text(cdp.get(7)?.get(idx)) ?? '',
      remotePlatform: text(cdp.get(8)?.get(idx)) || null,
      remoteMgmtAddress: ip,
    });
  }
  return out;
}

const BGP_STATES = ['', 'idle', 'connect', 'active', 'opensent', 'openconfirm', 'established'];
export function parseBgp(t: Table | null): DiscoveredBgpPeer[] {
  if (!t) return [];
  const out: DiscoveredBgpPeer[] = [];
  for (const [ip, state] of t.get(2) ?? []) {
    out.push({ peer: ip, state: BGP_STATES[num(state) ?? 0] || 'unknown', remoteAs: num(t.get(9)?.get(ip)), uptimeSeconds: num(t.get(16)?.get(ip)) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counters (monitoring)
// ---------------------------------------------------------------------------

/** Walks individual columns of a table (cheaper than whole rows when only a few columns are needed). */
export async function walkColumns(tr: SnmpTransport, entry: string, cols: number[]): Promise<Table> {
  const out: Table = new Map();
  for (const col of cols) {
    const t = await tr.walk(`${entry}.${col}`);
    const m = new Map<string, Value>();
    // walk() splits the first sub-identifier off as "column"; here that is the first index component.
    for (const [first, rest] of t) for (const [r, v] of rest) m.set(r ? `${first}.${r}` : String(first), v);
    if (m.size) out.set(col, m);
  }
  return out;
}

export function big(v: Value | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? BigInt(Math.trunc(v)) : null;
  if (Buffer.isBuffer(v)) return v.length && v.length <= 8 ? BigInt(`0x${v.toString('hex')}`) : null;
  return /^\d+$/.test(String(v)) ? BigInt(String(v)) : null;
}

export function parseCounters(sys: Map<string, Value>, ifT: Table, ifX: Table): CounterSnapshot {
  const ticks = num(sys.get(OID.sysUpTime));
  const names = ifX.get(1) ?? new Map<string, Value>();
  const descr = ifT.get(2) ?? new Map<string, Value>();
  const idxs = new Set([...names.keys(), ...descr.keys()]);
  const hc = !!ifX.get(6)?.size;
  const sum = (...vals: (bigint | null)[]) => (vals.every((x) => x === null) ? null : vals.reduce<bigint>((a, b) => a + (b ?? 0n), 0n));
  const interfaces: CounterReading[] = [];
  for (const idx of idxs) {
    const name = text(names.get(idx)) || text(descr.get(idx));
    if (!name) continue;
    const high = num(ifX.get(15)?.get(idx));
    const low = num(ifT.get(5)?.get(idx));
    const oper = num(ifT.get(8)?.get(idx));
    const portHc = hc && ifX.get(6)?.get(idx) !== undefined && ifX.get(10)?.get(idx) !== undefined;
    interfaces.push({
      name,
      ifIndex: Number(idx),
      // 64-bit (ifHC*) per port when the device has them for this port; some ports
      // (e.g. 10 Mbit/s or virtual ones) only have the 32-bit ifTable counters.
      inOctets: portHc ? big(ifX.get(6)?.get(idx)) : big(ifT.get(10)?.get(idx)),
      outOctets: portHc ? big(ifX.get(10)?.get(idx)) : big(ifT.get(16)?.get(idx)),
      inPkts: portHc ? sum(big(ifX.get(7)?.get(idx)), big(ifX.get(8)?.get(idx)), big(ifX.get(9)?.get(idx))) : big(ifT.get(11)?.get(idx)),
      outPkts: portHc ? sum(big(ifX.get(11)?.get(idx)), big(ifX.get(12)?.get(idx)), big(ifX.get(13)?.get(idx))) : big(ifT.get(17)?.get(idx)),
      inErrors: big(ifT.get(14)?.get(idx)),
      outErrors: big(ifT.get(20)?.get(idx)),
      inDiscards: big(ifT.get(13)?.get(idx)),
      outDiscards: big(ifT.get(19)?.get(idx)),
      bits: portHc ? 64 : 32,
      errorBits: 32,
      speedBps: high && high > 0 ? high * 1_000_000 : low && low > 0 && low < 4_294_967_295 ? low : null,
      operUp: oper === null ? null : oper === 1,
    });
  }
  return { uptimeSeconds: ticks === null ? null : Math.floor(ticks / 100), interfaces };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * APC / Schneider rack PDUs (PowerNet-MIB rPDU2): per-outlet power on
 * metered-by-outlet models and the device total. Other PDU families are not
 * read yet. OIDs as published in PowerNet-MIB; not yet checked on hardware.
 */
export const APC = {
  /** rPDU2OutletMeteredStatusEntry: .2 module (unit in a daisy chain), .3 name, .4 outlet number, .7 power (W). */
  outletEntry: '1.3.6.1.4.1.318.1.1.26.9.4.3.1',
  /** rPDU2DeviceStatusEntry: .5 power (hundredths of kW). */
  deviceEntry: '1.3.6.1.4.1.318.1.1.26.4.3.1',
};

export function parseApcPower(outlets: Table, device: Table): PowerSnapshot | null {
  const modules = outlets.get(2) ?? new Map<string, Value>();
  const names = outlets.get(3) ?? new Map<string, Value>();
  const numbers = outlets.get(4) ?? new Map<string, Value>();
  const power = outlets.get(7) ?? new Map<string, Value>();
  const idxs = new Set([...numbers.keys(), ...power.keys()]);
  const list = [...idxs]
    .map((idx) => {
      const n = num(numbers.get(idx)) ?? Number(idx);
      const unit = num(modules.get(idx)) ?? 1;
      // Daisy-chained units repeat outlet numbers: unit 2 outlet 3 becomes 2003.
      return { number: unit > 1 ? unit * 1000 + n : n, name: unit > 1 ? `Unit ${unit}: ${text(names.get(idx)) ?? `outlet ${n}`}` : text(names.get(idx)), watts: num(power.get(idx)) };
    })
    .filter((o) => Number.isInteger(o.number) && o.number > 0)
    .sort((a, b) => a.number - b.number);
  const totals = [...(device.get(5)?.values() ?? [])].map((v) => num(v)).filter((v): v is number => v !== null && v >= 0);
  if (!list.length && !totals.length) return null;
  return { watts: totals.length ? totals.reduce((a, b) => a + b, 0) * 10 : null, source: 'snmp', outlets: list, detail: 'APC rPDU2' };
}

export function snmpAdapter(kind: 'snmp_v2c' | 'snmp_v3', makeTransport = createTransport): Adapter {
  const sysOids = [OID.sysDescr, OID.sysObjectID, OID.sysUpTime, OID.sysName];
  return {
    async test(t: AdapterTarget): Promise<TestResult> {
      const started = Date.now();
      const tr = makeTransport(t, kind);
      try {
        const sys = await tr.get(sysOids);
        if (!sys.size) return { ok: false, message: 'The device answered but returned no system information', latencyMs: Date.now() - started };
        const facts = parseFacts(sys, null);
        return { ok: true, message: `Connected: ${facts.sysName ?? 'unnamed'}${facts.sysDescr ? ` — ${facts.sysDescr.split('\n')[0]!.slice(0, 120)}` : ''}`, latencyMs: Date.now() - started, facts };
      } finally {
        tr.close();
      }
    },
    async power(t: AdapterTarget): Promise<PowerSnapshot> {
      const tr = makeTransport(t, kind);
      try {
        const outlets = await walkColumns(tr, APC.outletEntry, [2, 3, 4, 7]);
        const device = await walkColumns(tr, APC.deviceEntry, [5]);
        const r = parseApcPower(outlets, device);
        if (!r) throw new Error('No supported power MIB found (APC PowerNet rPDU2 is supported for PDUs)');
        return r;
      } finally {
        tr.close();
      }
    },
    async counters(t: AdapterTarget): Promise<CounterSnapshot> {
      const tr = makeTransport(t, kind);
      try {
        const sys = await tr.get([OID.sysUpTime]);
        const ifX = await walkColumns(tr, OID.ifXEntry, [1, 6, 7, 8, 9, 10, 11, 12, 13, 15]);
        const hc = !!ifX.get(6)?.size;
        // The 32-bit octet columns are read too, for ports without 64-bit counters.
        const ifT = await walkColumns(tr, OID.ifEntry, [2, 5, 8, 10, 11, 13, 14, 16, 17, 19, 20]);
        if (!ifT.size && !ifX.size) throw new Error('IF-MIB returned nothing; check the credential and the device ACL');
        return parseCounters(sys, ifT, ifX);
      } finally {
        tr.close();
      }
    },
    async discover(t: AdapterTarget): Promise<DiscoveryResult> {
      const tr = makeTransport(t, kind);
      const warnings: string[] = [];
      const optional = async (label: string, oid: string): Promise<Table | null> => {
        try {
          const tb = await tr.walk(oid);
          return tb.size ? tb : null;
        } catch (e) {
          warnings.push(`${label}: ${(e as Error).message}`);
          return null;
        }
      };
      try {
        const sys = await tr.get(sysOids);
        if (!sys.size) throw new Error('The device returned no system information');
        const ifTable = await tr.walk(OID.ifEntry);
        if (!ifTable.size) throw new Error('IF-MIB ifTable is empty or not readable with this credential');
        const ifX = await optional('IF-MIB ifXTable', OID.ifXEntry);
        const ipv4 = await optional('IP-MIB ipAddrTable', OID.ipAddrEntry);
        const ipAddress = await optional('IP-MIB ipAddressTable', OID.ipAddressEntry);
        const lag = await optional('IEEE8023-LAG-MIB', OID.lagPortAttached.split('.').slice(0, -1).join('.'));
        const ent = await optional('ENTITY-MIB', OID.entPhysicalEntry);
        const interfaces = parseInterfaces(ifTable, ifX, ipv4, ipAddress, lag);
        const lldpRem = await optional('LLDP-MIB', OID.lldpRemEntry);
        const lldpLoc = lldpRem ? await optional('LLDP-MIB local ports', OID.lldpLocPortEntry) : null;
        const lldpMan = lldpRem ? await optional('LLDP-MIB management addresses', OID.lldpRemManAddrEntry) : null;
        const cdp = await optional('CISCO-CDP-MIB', OID.cdpCacheEntry);
        const bgp = await optional('BGP4-MIB', OID.bgpPeerEntry);
        if (!lldpRem && !cdp) warnings.push('No LLDP or CDP neighbor data; enable LLDP on the device to verify cabling');
        return {
          source: kind,
          collectedAt: new Date().toISOString(),
          facts: parseFacts(sys, ent),
          interfaces,
          neighbors: [...parseLldp(lldpRem, lldpLoc, lldpMan, interfaces), ...parseCdp(cdp, interfaces)],
          bgp: parseBgp(bgp),
          warnings,
        };
      } finally {
        tr.close();
      }
    },
  };
}
