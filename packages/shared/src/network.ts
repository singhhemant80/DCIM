import { z } from 'zod';
import { paginationSchema } from './schemas';

/* ------------------------------------------------------------------ */
/* Enumerations                                                        */
/* ------------------------------------------------------------------ */

export const PLATFORMS = ['routeros', 'nxos', 'ios', 'iosxe', 'fortios', 'junos', 'linux', 'windows', 'proxmox', 'other'] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Record<Platform, string> = {
  routeros: 'MikroTik RouterOS',
  nxos: 'Cisco NX-OS',
  ios: 'Cisco IOS',
  iosxe: 'Cisco IOS-XE',
  fortios: 'Fortinet FortiOS',
  junos: 'Juniper Junos',
  linux: 'Linux',
  windows: 'Windows',
  proxmox: 'Proxmox VE',
  other: 'Other',
};

/** Device categories treated as network infrastructure (listed under Network Infrastructure). */
export const NETWORK_CATEGORIES = ['router', 'switch', 'firewall', 'load_balancer', 'optical'] as const;

export const INTERFACE_KINDS = ['physical', 'lag', 'vlan', 'bridge', 'tunnel', 'loopback', 'virtual', 'management'] as const;
export type InterfaceKind = (typeof INTERFACE_KINDS)[number];
export const INTERFACE_KIND_LABELS: Record<InterfaceKind, string> = {
  physical: 'Physical',
  lag: 'LAG / port-channel',
  vlan: 'VLAN interface',
  bridge: 'Bridge',
  tunnel: 'Tunnel',
  loopback: 'Loopback',
  virtual: 'Virtual',
  management: 'Management',
};
/** Kinds that exist as a real port and can take a cable. */
export const CABLEABLE_KINDS: readonly InterfaceKind[] = ['physical', 'management'];
export const LOGICAL_KINDS: readonly InterfaceKind[] = ['lag', 'vlan', 'bridge', 'tunnel', 'loopback', 'virtual'];

export const INTERFACE_MEDIA = ['copper', 'sfp', 'sfp_plus', 'sfp28', 'qsfp_plus', 'qsfp28', 'qsfp_dd', 'other'] as const;
export const INTERFACE_MEDIA_LABELS: Record<(typeof INTERFACE_MEDIA)[number], string> = {
  copper: 'Copper (RJ45)',
  sfp: 'SFP (1G)',
  sfp_plus: 'SFP+ (10G)',
  sfp28: 'SFP28 (25G)',
  qsfp_plus: 'QSFP+ (40G)',
  qsfp28: 'QSFP28 (100G)',
  qsfp_dd: 'QSFP-DD (400G)',
  other: 'Other',
};

export const VLAN_MODES = ['access', 'tagged', 'tagged_all'] as const;
export const VLAN_MODE_LABELS: Record<(typeof VLAN_MODES)[number], string> = {
  access: 'Access (one untagged VLAN)',
  tagged: 'Trunk (selected tagged VLANs)',
  tagged_all: 'Trunk (all VLANs)',
};

export const CABLE_TYPES = ['cat5e', 'cat6', 'cat6a', 'dac', 'aoc', 'mmf', 'smf', 'other'] as const;
export const CABLE_TYPE_LABELS: Record<(typeof CABLE_TYPES)[number], string> = {
  cat5e: 'Cat5e',
  cat6: 'Cat6',
  cat6a: 'Cat6a',
  dac: 'DAC (direct attach)',
  aoc: 'AOC (active optical)',
  mmf: 'Multimode fibre',
  smf: 'Single-mode fibre',
  other: 'Other',
};
export const CABLE_STATUSES = ['planned', 'connected', 'decommissioning'] as const;

export const CIRCUIT_TYPES = ['internet_transit', 'ip_peering', 'transport', 'cross_connect', 'mpls', 'other'] as const;
export const CIRCUIT_TYPE_LABELS: Record<(typeof CIRCUIT_TYPES)[number], string> = {
  internet_transit: 'Internet transit',
  ip_peering: 'IP peering / IX',
  transport: 'Transport / wave',
  cross_connect: 'Cross-connect',
  mpls: 'MPLS / L2VPN',
  other: 'Other',
};
export const CIRCUIT_STATUSES = ['planned', 'provisioning', 'active', 'decommissioned'] as const;

export const PREFIX_STATUSES = ['container', 'active', 'reserved', 'deprecated'] as const;
export const PREFIX_STATUS_LABELS: Record<(typeof PREFIX_STATUSES)[number], string> = {
  container: 'Container',
  active: 'Active',
  reserved: 'Reserved',
  deprecated: 'Deprecated',
};
export const IP_STATUSES = ['reserved', 'allocated', 'deprecated', 'released'] as const;
export type IpStatus = (typeof IP_STATUSES)[number];
export const IP_STATUS_LABELS: Record<IpStatus, string> = {
  reserved: 'Reserved',
  allocated: 'Allocated',
  deprecated: 'Deprecated',
  released: 'Released',
};
export const IP_ROLES = ['primary', 'secondary', 'gateway', 'vip', 'anycast', 'loopback', 'management'] as const;

export const VLAN_STATUSES = ['active', 'reserved', 'deprecated'] as const;

export const CREDENTIAL_KINDS = ['snmp_v2c', 'snmp_v3', 'routeros_rest', 'routeros_api', 'fortios_rest', 'nxapi', 'redfish', 'ipmi'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export const CREDENTIAL_KIND_LABELS: Record<CredentialKind, string> = {
  snmp_v2c: 'SNMP v2c',
  snmp_v3: 'SNMP v3',
  routeros_rest: 'MikroTik RouterOS REST API',
  fortios_rest: 'FortiGate REST API',
  nxapi: 'Cisco NX-API',
  routeros_api: 'MikroTik RouterOS API (api / api-ssl)',
  redfish: 'Redfish (iDRAC, iLO, XClarity…)',
  ipmi: 'IPMI over LAN (DCMI)',
};
/** Access methods that only serve power readings and server facts, not network discovery. */
export const BMC_CREDENTIAL_KINDS: readonly CredentialKind[] = ['redfish', 'ipmi'];

export const SNMP_AUTH_PROTOCOLS = ['md5', 'sha', 'sha224', 'sha256', 'sha384', 'sha512'] as const;
export const SNMP_PRIV_PROTOCOLS = ['des', 'aes', 'aes256b', 'aes256r'] as const;

/* ------------------------------------------------------------------ */
/* IP and CIDR helpers (pure, BigInt based, IPv4 and IPv6)              */
/* ------------------------------------------------------------------ */

export interface ParsedIp {
  family: 4 | 6;
  value: bigint;
}

function parseIpv4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255 || (p.length > 1 && p.startsWith('0'))) return null;
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

function parseIpv6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(s) || s.length > 45) return null;
  let tail4: bigint | null = null;
  let str = s;
  const lastColon = str.lastIndexOf(':');
  if (str.includes('.')) {
    tail4 = parseIpv4(str.slice(lastColon + 1));
    if (tail4 === null) return null;
    str = `${str.slice(0, lastColon + 1)}0:0`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  if (tail4 !== null) v = (v & ~0xffffffffn) | tail4;
  return v;
}

export function parseIp(s: string): ParsedIp | null {
  const t = s.trim();
  const v4 = parseIpv4(t);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseIpv6(t);
  if (v6 !== null) return { family: 6, value: v6 };
  return null;
}

export function formatIp(family: 4 | 6, v: bigint): string {
  if (family === 4) return [24n, 16n, 8n, 0n].map((sh) => Number((v >> sh) & 255n)).join('.');
  const groups = Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(112 - i * 16)) & 0xffffn));
  // RFC 5952: compress the longest run (length >= 2) of zero groups, leftmost on ties.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

export interface ParsedCidr {
  family: 4 | 6;
  /** Network address (host bits cleared). */
  network: bigint;
  length: number;
  bits: number;
}

/** Parses "a.b.c.d/n" or "x::/n". Rejects host bits set unless `allowHostBits`. */
export function parseCidr(s: string, allowHostBits = false): ParsedCidr | null {
  const [addr, len, extra] = s.trim().split('/');
  if (extra !== undefined || !addr || len === undefined || !/^\d{1,3}$/.test(len)) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const bits = ip.family === 4 ? 32 : 128;
  const length = Number(len);
  if (length > bits) return null;
  const hostMask = (1n << BigInt(bits - length)) - 1n;
  if (!allowHostBits && (ip.value & hostMask) !== 0n) return null;
  return { family: ip.family, network: ip.value & ~hostMask & ((1n << BigInt(bits)) - 1n), length, bits };
}

export function formatCidr(c: ParsedCidr): string {
  return `${formatIp(c.family, c.network)}/${c.length}`;
}

export function cidrSize(c: ParsedCidr): bigint {
  return 1n << BigInt(c.bits - c.length);
}

export function cidrLast(c: ParsedCidr): bigint {
  return c.network + cidrSize(c) - 1n;
}

export function cidrContains(c: ParsedCidr, ip: ParsedIp): boolean {
  return c.family === ip.family && ip.value >= c.network && ip.value <= cidrLast(c);
}

/**
 * Addresses that may be assigned inside a prefix. IPv4 excludes the network and
 * broadcast addresses (except /31, /32 and pools); IPv6 excludes the
 * subnet-router anycast address (all-zero host) unless the prefix is a pool or
 * a /127 or /128.
 */
export function usableRange(c: ParsedCidr, isPool = false): { first: bigint; last: bigint; count: bigint } {
  const last = cidrLast(c);
  if (isPool || c.bits - c.length <= 1) return { first: c.network, last, count: cidrSize(c) };
  if (c.family === 4) return { first: c.network + 1n, last: last - 1n, count: cidrSize(c) - 2n };
  return { first: c.network + 1n, last, count: cidrSize(c) - 1n };
}

/** Reverse-DNS zone name for an address, e.g. 7.2.0.192.in-addr.arpa. */
export function ptrName(ip: ParsedIp): string {
  if (ip.family === 4) return `${formatIp(4, ip.value).split('.').reverse().join('.')}.in-addr.arpa`;
  const nibbles = ip.value.toString(16).padStart(32, '0').split('').reverse();
  return `${nibbles.join('.')}.ip6.arpa`;
}

/** Speed in bits per second from common strings ("10Gbps", "10 Gb/s", "1000Mbps", "25G"). Returns null when unknown. */
export function parseSpeed(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined) return null;
  if (typeof s === 'number') return Number.isFinite(s) && s > 0 ? s : null;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:b(?:it)?(?:ps|\/s)?)?$/i);
  if (!m) return null;
  const mult = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2]!.toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  const v = Number(m[1]) * mult;
  return v > 0 ? Math.round(v) : null;
}

/* ------------------------------------------------------------------ */
/* Input schemas                                                       */
/* ------------------------------------------------------------------ */

const uuid = z.string().uuid();
const optText = (max = 500) => z.string().trim().max(max).nullable().optional();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a valid date')
  .nullable()
  .optional();
const mac = z
  .string()
  .trim()
  .regex(/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, 'Invalid MAC address')
  .transform((m) => m.toLowerCase().replace(/-/g, ':'));
const bps = z.number().int().min(0).max(4e12);
/** A port speed: unknown is null, never 0. */
const portBps = z.number().int().min(1).max(4e12);

export const cidrSchema = z
  .string()
  .trim()
  .refine((s) => parseCidr(s, true) !== null, 'Enter a prefix such as 203.0.113.0/24 or 2001:db8::/48')
  .refine((s) => parseCidr(s) !== null, 'Host bits are set; use the network address (e.g. 203.0.113.0/24)')
  .transform((s) => formatCidr(parseCidr(s)!));

export const ipSchema = z
  .string()
  .trim()
  .refine((s) => parseIp(s) !== null, 'Enter an IPv4 or IPv6 address')
  .transform((s) => {
    const p = parseIp(s)!;
    return formatIp(p.family, p.value);
  });

export const networkDetailsSchema = z.object({
  platform: z.enum(PLATFORMS).nullable().optional(),
  networkRole: z.string().trim().max(60).nullable().optional(),
});

export const interfaceSchema = z.object({
  deviceId: uuid,
  name: z.string().trim().min(1).max(64),
  kind: z.enum(INTERFACE_KINDS),
  media: z.enum(INTERFACE_MEDIA).nullable().optional(),
  description: optText(200),
  macAddress: mac.nullable().optional(),
  mtu: z.number().int().min(64).max(65535).nullable().optional(),
  speedBps: portBps.nullable().optional(),
  enabled: z.boolean().default(true),
  lagId: uuid.nullable().optional(),
  parentId: uuid.nullable().optional(),
  mode: z.enum(VLAN_MODES).nullable().optional(),
  untaggedVlanId: uuid.nullable().optional(),
  taggedVlanIds: z.array(uuid).max(4094).default([]),
  monitored: z.boolean().default(true),
  countInTotals: z.boolean().default(false),
});
export type InterfaceInput = z.infer<typeof interfaceSchema>;

export const interfaceBulkCreateSchema = z.object({
  deviceId: uuid,
  /** Pattern like "ether[1-12]", "sfp-sfpplus[1-4]" or "Ethernet1/[1-48]". */
  pattern: z.string().trim().min(1).max(80),
  kind: z.enum(INTERFACE_KINDS).default('physical'),
  media: z.enum(INTERFACE_MEDIA).nullable().optional(),
  speedBps: portBps.nullable().optional(),
});

export const cableSchema = z
  .object({
    aInterfaceId: uuid,
    bInterfaceId: uuid,
    type: z.enum(CABLE_TYPES).nullable().optional(),
    status: z.enum(CABLE_STATUSES).default('connected'),
    label: optText(60),
    color: optText(30),
    lengthM: z.number().min(0).max(100_000).nullable().optional(),
    notes: optText(1000),
  })
  .refine((c) => c.aInterfaceId !== c.bInterfaceId, { message: 'A cable needs two different ports', path: ['bInterfaceId'] });

export const cableUpdateSchema = z.object({
  type: z.enum(CABLE_TYPES).nullable().optional(),
  status: z.enum(CABLE_STATUSES),
  label: optText(60),
  color: optText(30),
  lengthM: z.number().min(0).max(100_000).nullable().optional(),
  notes: optText(1000),
});

export const vlanSchema = z.object({
  vid: z.number().int().min(1).max(4094),
  name: z.string().trim().min(1).max(64),
  datacenterId: uuid.nullable().optional(),
  status: z.enum(VLAN_STATUSES).default('active'),
  customerId: uuid.nullable().optional(),
  description: optText(300),
});

export const vrfSchema = z.object({
  name: z.string().trim().min(1).max(64),
  rd: z
    .string()
    .trim()
    .regex(/^(\d{1,10}:\d{1,10}|\d{1,3}(\.\d{1,3}){3}:\d{1,5})$/, 'Use ASN:nn or IP:nn, e.g. 65000:100')
    .nullable()
    .optional(),
  description: optText(300),
});

export const providerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  asn: z.number().int().min(1).max(4294967295).nullable().optional(),
  accountNumber: optText(80),
  portalUrl: z.string().trim().url().max(300).nullable().optional(),
  nocEmail: z.string().trim().email().max(254).nullable().optional(),
  nocPhone: optText(40),
  notes: optText(2000),
});

export const circuitSchema = z.object({
  providerId: uuid,
  cid: z.string().trim().min(1).max(80),
  type: z.enum(CIRCUIT_TYPES),
  status: z.enum(CIRCUIT_STATUSES).default('active'),
  commitBps: bps.nullable().optional(),
  portSpeedBps: bps.nullable().optional(),
  installDate: isoDate,
  termEndDate: isoDate,
  datacenterId: uuid.nullable().optional(),
  interfaceId: uuid.nullable().optional(),
  zSide: optText(200),
  customerId: uuid.nullable().optional(),
  description: optText(300),
  notes: optText(2000),
});

export const prefixSchema = z.object({
  prefix: cidrSchema,
  vrfId: uuid.nullable().optional(),
  status: z.enum(PREFIX_STATUSES).default('active'),
  isPool: z.boolean().default(false),
  datacenterId: uuid.nullable().optional(),
  vlanId: uuid.nullable().optional(),
  customerId: uuid.nullable().optional(),
  gateway: ipSchema.nullable().optional(),
  description: optText(300),
});

export const prefixUpdateSchema = prefixSchema.omit({ prefix: true, vrfId: true });

const assignment = {
  status: z.enum(['reserved', 'allocated']).default('allocated'),
  prefixLength: z.number().int().min(0).max(128).nullable().optional(),
  role: z.enum(IP_ROLES).nullable().optional(),
  dnsName: z
    .string()
    .trim()
    .max(253)
    .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)*\.?$/, 'Not a valid DNS name')
    .nullable()
    .optional(),
  /** PTR target when it differs from the DNS name (published in reverse zones). */
  reverseDns: z
    .string()
    .trim()
    .max(253)
    .regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)*\.?$/, 'Not a valid host name')
    .nullable()
    .optional(),
  customerId: uuid.nullable().optional(),
  deviceId: uuid.nullable().optional(),
  interfaceId: uuid.nullable().optional(),
  serviceRef: optText(120),
  reservedUntil: z.string().datetime().nullable().optional(),
  notes: optText(1000),
};

export const ipAssignSchema = z.object({ address: ipSchema, vrfId: uuid.nullable().optional(), ...assignment });
export const ipAllocateNextSchema = z.object({ prefixId: uuid, count: z.number().int().min(1).max(256).default(1), ...assignment });
export const ipUpdateSchema = z.object({
  status: z.enum(['reserved', 'allocated', 'deprecated']),
  prefixLength: assignment.prefixLength,
  role: assignment.role,
  dnsName: assignment.dnsName,
  reverseDns: assignment.reverseDns,
  customerId: assignment.customerId,
  deviceId: assignment.deviceId,
  interfaceId: assignment.interfaceId,
  serviceRef: assignment.serviceRef,
  reservedUntil: assignment.reservedUntil,
  notes: assignment.notes,
});
export const ipReleaseSchema = z.object({ reason: z.string().trim().max(300).optional() });

export const ipListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  prefixId: uuid.optional(),
  vrfId: uuid.optional(),
  status: z.enum(IP_STATUSES).optional(),
  customerId: uuid.optional(),
  deviceId: uuid.optional(),
});

export const prefixListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  vrfId: z.union([uuid, z.literal('global')]).optional(),
  family: z.enum(['4', '6']).optional(),
  customerId: uuid.optional(),
});

export const ipamImportSchema = z.object({ kind: z.enum(['prefixes', 'addresses']), csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) });

const secretText = z.string().min(3, 'Too short').max(256);
export const credentialSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('snmp_v2c'),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    community: secretText,
    timeoutMs: z.number().int().min(500).max(30_000).default(3000),
    retries: z.number().int().min(0).max(5).default(1),
  }),
  z.object({
    kind: z.literal('snmp_v3'),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(64),
    securityLevel: z.enum(['noAuthNoPriv', 'authNoPriv', 'authPriv']).default('authPriv'),
    authProtocol: z.enum(SNMP_AUTH_PROTOCOLS).default('sha'),
    authKey: z.string().min(8).max(256).nullable().optional(),
    privProtocol: z.enum(SNMP_PRIV_PROTOCOLS).default('aes'),
    privKey: z.string().min(8).max(256).nullable().optional(),
    timeoutMs: z.number().int().min(500).max(30_000).default(3000),
    retries: z.number().int().min(0).max(5).default(1),
  }),
  z.object({
    kind: z.literal('routeros_rest'),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(64),
    password: secretText,
    scheme: z.enum(['https', 'http']).default('https'),
    verifyTls: z.boolean().default(true),
    timeoutMs: z.number().int().min(500).max(30_000).default(5000),
  }),
  z.object({
    kind: z.literal('routeros_api'),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(64),
    password: secretText,
    /** true = api-ssl (TLS, default port 8729); false = plain api (8728, credentials sent in clear). */
    tls: z.boolean().default(true),
    verifyTls: z.boolean().default(true),
    timeoutMs: z.number().int().min(500).max(30_000).default(5000),
  }),
  z.object({
    kind: z.literal('fortios_rest'),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    token: secretText,
    scheme: z.enum(['https', 'http']).default('https'),
    verifyTls: z.boolean().default(true),
    vdom: z.string().trim().max(31).nullable().optional(),
    timeoutMs: z.number().int().min(500).max(30_000).default(5000),
  }),
  z.object({
    kind: z.literal('nxapi'),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(64),
    password: secretText,
    scheme: z.enum(['https', 'http']).default('https'),
    verifyTls: z.boolean().default(true),
    timeoutMs: z.number().int().min(500).max(30_000).default(8000),
  }),
  z.object({
    kind: z.literal('redfish'),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(64),
    password: secretText,
    scheme: z.enum(['https', 'http']).default('https'),
    verifyTls: z.boolean().default(true),
    timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
  }),
  z.object({
    kind: z.literal('ipmi'),
    host: z.string().trim().max(255).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    username: z.string().trim().min(1).max(16),
    /** IPMI 2.0 passwords are at most 20 bytes. */
    password: z.string().min(1).max(20, 'IPMI passwords are at most 20 characters'),
    /** Lowest privilege that can read DCMI power on the BMC (USER is enough on most). */
    ipmiPrivilege: z.enum(['USER', 'OPERATOR', 'ADMINISTRATOR']).default('USER'),
    timeoutMs: z.number().int().min(500).max(30_000).default(10_000),
    retries: z.number().int().min(0).max(5).default(1),
  }),
]);
export type CredentialInput = z.infer<typeof credentialSchema>;

export const discoveryApplySchema = z.object({
  /** Discovered interface names to create or update. */
  interfaces: z.array(z.string().max(64)).max(5000).default([]),
  updateDeviceFacts: z.boolean().default(false),
  importNeighbors: z.boolean().default(true),
  /** Addresses seen on the device to record in IPAM (global table), as interface + CIDR pairs. Needs ipam.write. */
  addresses: z
    .array(z.object({ interface: z.string().max(64), address: z.string().max(64) }))
    .max(2000)
    .default([]),
  /** Create the subnet in IPAM when no prefix covers an imported address. */
  createPrefixes: z.boolean().default(false),
});

/** Automatic discovery interval: null turns it off. */
export const discoveryScheduleSchema = z.object({ hours: z.number().int().min(1).max(720).nullable() });

/* ------------------------------------------------------------------ DNS */

export const DNS_SERVER_KINDS = ['powerdns', 'cloudflare'] as const;
export const DNS_SERVER_KIND_LABELS: Record<(typeof DNS_SERVER_KINDS)[number], string> = { powerdns: 'PowerDNS (HTTP API)', cloudflare: 'Cloudflare' };

const dnsName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^([a-z0-9_]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.?$/, 'Not a valid zone name')
  .transform((v) => v.replace(/\.$/, ''));

export const dnsServerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('powerdns'),
    name: z.string().trim().min(1).max(80),
    url: z
      .string()
      .trim()
      .url()
      .max(300)
      .refine((u) => /^https?:\/\//i.test(u), 'Use an http:// or https:// URL')
      .refine((u) => !/^https?:\/\/[^/]*@/i.test(u), 'Put the API key in its own field, not in the URL'),
    serverId: z.string().trim().min(1).max(64).default('localhost'),
    verifyTls: z.boolean().default(true),
    apiKey: secretText,
  }),
  z.object({
    kind: z.literal('cloudflare'),
    name: z.string().trim().min(1).max(80),
    apiToken: secretText,
  }),
]);
export type DnsServerInput = z.infer<typeof dnsServerSchema>;

export const dnsZoneSchema = z.object({
  serverId: uuid,
  name: dnsName,
  kind: z.enum(['forward', 'reverse']),
  providerZoneId: z.string().trim().max(64).nullable().optional(),
  ttl: z.number().int().min(60).max(604800).default(3600),
  enabled: z.boolean().default(true),
});

/** Expands "ether[1-4]" → ether1..ether4, "Ethernet1/[1-3]" → Ethernet1/1..3. At most 512 names. */
export function expandInterfacePattern(pattern: string): string[] {
  const m = pattern.match(/^(.*)\[(\d+)-(\d+)\](.*)$/);
  if (!m) return [pattern];
  const [, pre, a, b, post] = m;
  const from = Number(a);
  const to = Number(b);
  if (to < from || to - from >= 512) throw new Error('Range must be ascending and at most 512 ports');
  return Array.from({ length: to - from + 1 }, (_, i) => `${pre}${from + i}${post}`);
}
