import type { CredentialKind, InterfaceKind } from '@crapplet/shared';

/**
 * What a read-only collector returns. Every value here was read from the
 * device ("measured" at `collectedAt`); nothing is estimated or simulated by
 * the collector itself. Adapters only ever issue read operations (SNMP
 * GET/GETNEXT/GETBULK, HTTP GET, NX-API `show` commands).
 */
export interface DiscoveredInterface {
  name: string;
  ifIndex?: number | null;
  kind: InterfaceKind;
  description?: string | null;
  macAddress?: string | null;
  mtu?: number | null;
  speedBps?: number | null;
  adminUp?: boolean | null;
  operUp?: boolean | null;
  /** CIDR notation, e.g. "192.0.2.1/24". */
  addresses?: string[];
  /** Name of the LAG this port is a member of, if the platform reports it. */
  lagName?: string | null;
}

export interface DiscoveredNeighbor {
  localInterface: string;
  protocol: 'lldp' | 'cdp' | 'mndp';
  remoteChassisId: string;
  remoteSystemName?: string | null;
  remotePortId: string;
  remotePortDescription?: string | null;
  remoteMgmtAddress?: string | null;
  remotePlatform?: string | null;
}

export interface DiscoveredBgpPeer {
  peer: string;
  remoteAs: number | null;
  state: string;
  /** Uptime of the session in seconds when the platform reports it. */
  uptimeSeconds?: number | null;
  prefixesReceived?: number | null;
  vrf?: string | null;
  description?: string | null;
}

export interface DeviceFacts {
  sysName?: string | null;
  sysDescr?: string | null;
  vendor?: string | null;
  model?: string | null;
  serial?: string | null;
  osVersion?: string | null;
  uptimeSeconds?: number | null;
}

export interface DiscoveryResult {
  source: CredentialKind;
  collectedAt: string;
  facts: DeviceFacts;
  interfaces: DiscoveredInterface[];
  neighbors: DiscoveredNeighbor[];
  bgp: DiscoveredBgpPeer[];
  /** Sections that could not be read (e.g. LLDP-MIB not supported). Not fatal. */
  warnings: string[];
}

export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  facts?: DeviceFacts;
}

/** Connection settings handed to an adapter inside the worker only. */
export interface AdapterTarget {
  host: string;
  port?: number | null;
  username?: string | null;
  params: {
    timeoutMs?: number;
    retries?: number;
    scheme?: 'https' | 'http';
    /** RouterOS API: api-ssl (true) or plain api (false). */
    tls?: boolean;
    verifyTls?: boolean;
    vdom?: string | null;
    securityLevel?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
    authProtocol?: string;
    privProtocol?: string;
  };
  /** Decrypted secret material. Never logged, never persisted outside the encrypted column. */
  secret: Record<string, string | null | undefined>;
}

/** One interface's raw counters at one poll (measured). */
export interface CounterReading {
  name: string;
  ifIndex?: number | null;
  inOctets: bigint | null;
  outOctets: bigint | null;
  inPkts?: bigint | null;
  outPkts?: bigint | null;
  inErrors?: bigint | null;
  outErrors?: bigint | null;
  inDiscards?: bigint | null;
  outDiscards?: bigint | null;
  /** Width of octet/packet counters. */
  bits: 32 | 64;
  /** Width of error/discard counters. */
  errorBits: 32 | 64;
  /** Link speed reported by the device, when it reports one. */
  speedBps?: number | null;
  operUp?: boolean | null;
}

export interface CounterSnapshot {
  /** Device uptime in seconds (for restart detection), when available. */
  uptimeSeconds: number | null;
  interfaces: CounterReading[];
}

export interface Adapter {
  test(t: AdapterTarget): Promise<TestResult>;
  discover(t: AdapterTarget): Promise<DiscoveryResult>;
  /** Read-only counter collection for monitoring. */
  counters?(t: AdapterTarget): Promise<CounterSnapshot>;
}

/** The secret fields of each credential kind (everything else is stored in plain params). */
export const SECRET_FIELDS: Record<CredentialKind, string[]> = {
  snmp_v2c: ['community'],
  snmp_v3: ['authKey', 'privKey'],
  routeros_rest: ['password'],
  fortios_rest: ['token'],
  nxapi: ['password'],
  routeros_api: ['password'],
};

/**
 * AAD binding a ciphertext to its row and destination: it cannot be copied
 * to another device or kind, and it stops decrypting if the stored host or
 * port is changed without re-entering the secret.
 */
export function credentialContext(orgId: string, deviceId: string, kind: CredentialKind, host: string, port: number | null) {
  return `device_credential:${orgId}:${deviceId}:${kind}:${host.toLowerCase()}:${port ?? ''}`;
}
