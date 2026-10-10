import { useQuery } from '@tanstack/react-query';
import type { CredentialKind, InterfaceKind, Platform } from '@crapplet/shared';
import { api } from './api';

export interface NetworkDeviceT {
  id: string;
  assetTag: string;
  hostname: string | null;
  category: string;
  platform: Platform | null;
  networkRole: string | null;
  mgmtAddress: string | null;
  os: string | null;
  lifecycleState: string;
  modelName: string;
  manufacturerName: string;
  rackName: string | null;
  positionU: number | null;
  datacenterCode: string | null;
  datacenterId: string | null;
  interfaceCount: number;
  physicalCount: number;
  cabledCount: number;
  credentialKinds: CredentialKind[];
  lastDiscovery: { status: string; finishedAt: string | null; mode: string } | null;
  /** Latest unapplied discovery that differs from inventory. */
  pendingChanges: { runId: string; total: number; finishedAt: string } | null;
}

export interface CredentialT {
  id: string;
  kind: CredentialKind;
  host: string | null;
  port: number | null;
  username: string | null;
  params: Record<string, unknown>;
  secretConfigured: true;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  rotatedAt: string;
  scheduleHours: number | null;
  nextRunAt: string | null;
}

export interface RunT {
  id: string;
  mode: 'test' | 'discover';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  credentialKind: CredentialKind;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  appliedAt: string | null;
  requestedLabel: string | null;
  trigger: 'manual' | 'schedule';
  changes: { create: number; update: number; missing: number; neighborMismatch: number; unmatchedNeighbors: number; addressesNotInIpam: number; total: number } | null;
}

export interface FactsT {
  sysName?: string | null;
  sysDescr?: string | null;
  vendor?: string | null;
  model?: string | null;
  serial?: string | null;
  osVersion?: string | null;
  uptimeSeconds?: number | null;
}
export interface BgpT {
  peer: string;
  remoteAs: number | null;
  state: string;
  uptimeSeconds?: number | null;
  prefixesReceived?: number | null;
  vrf?: string | null;
  description?: string | null;
}

export interface DeviceSummaryT {
  device: NetworkDeviceT;
  credentials: CredentialT[];
  runs: RunT[];
  lastCollected: { at: string; source: CredentialKind; facts: FactsT | null; bgp: BgpT[]; warnings: string[] } | null;
}

export interface InterfaceT {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  kind: InterfaceKind;
  media: string | null;
  description: string | null;
  macAddress: string | null;
  mtu: number | null;
  speedBps: number | null;
  enabled: boolean;
  lag: { id: string; name: string | null } | null;
  members: { id: string; name: string }[];
  parent: { id: string; name: string | null } | null;
  mode: 'access' | 'tagged' | 'tagged_all' | null;
  untaggedVlan: { id: string; vid: number | null; name: string | null } | null;
  taggedVlans: { id: string; vid: number; name: string }[];
  ifIndex: number | null;
  monitored: boolean;
  countInTotals: boolean;
  discoveredAt: string | null;
  cable: { id: string; status: string | null; type: string | null; label: string | null; peer: { interfaceId: string; interfaceName: string | null; deviceId: string | null; deviceName: string | null } | null } | null;
  circuit: { id: string; cid: string | null; provider: string | null } | null;
  neighbors: {
    protocol: string;
    remoteSystemName: string | null;
    remotePortId: string;
    remotePortDescription: string | null;
    remoteChassisId: string;
    remoteMgmtAddress: string | null;
    lastSeenAt: string;
    matched: { interfaceId: string; interfaceName: string | null; deviceId: string | null } | null;
  }[];
  ipAddresses: { id: string; address: string; prefixLength: number | null; status: string }[];
}

export interface VlanT {
  id: string;
  vid: number;
  name: string;
  datacenterId: string | null;
  datacenterCode: string | null;
  status: 'active' | 'reserved' | 'deprecated';
  customerId: string | null;
  customerName: string | null;
  description: string | null;
  portCount: number;
  prefixCount: number;
}
export interface VrfT {
  id: string;
  name: string;
  rd: string | null;
  description: string | null;
  prefixCount: number;
  addressCount: number;
}
export interface ProviderT {
  id: string;
  name: string;
  asn: number | null;
  accountNumber: string | null;
  portalUrl: string | null;
  nocEmail: string | null;
  nocPhone: string | null;
  notes: string | null;
  circuitCount: number;
}
export interface CircuitT {
  id: string;
  providerId: string;
  providerName: string;
  providerAsn: number | null;
  cid: string;
  type: string;
  status: string;
  commitBps: number | null;
  portSpeedBps: number | null;
  installDate: string | null;
  termEndDate: string | null;
  datacenterId: string | null;
  datacenterCode: string | null;
  interfaceId: string | null;
  interfaceName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  zSide: string | null;
  customerId: string | null;
  customerName: string | null;
  description: string | null;
  notes: string | null;
}
export interface CableT {
  id: string;
  type: string | null;
  status: string;
  label: string | null;
  color: string | null;
  lengthM: number | null;
  notes: string | null;
  a: { interfaceId: string; interfaceName: string; deviceId: string; deviceName: string };
  b: { interfaceId: string; interfaceName: string; deviceId: string; deviceName: string };
}

export interface TopologyNodeT {
  id: string;
  kind: 'device';
  label: string;
  category: string;
  platform: string | null;
  role: string | null;
  datacenterCode: string | null;
  rackName: string | null;
}
export interface TopologyLinkT {
  id: string;
  source: string;
  target: string;
  sourcePort: string;
  targetPort: string;
  kind: 'cable' | 'neighbor' | 'circuit';
  status: string;
  verifiedByNeighbor?: boolean;
  speedBps?: number | null;
  label?: string;
}

export const useVlans = (enabled = true) => useQuery({ queryKey: ['network', 'vlans'], queryFn: () => api.get<VlanT[]>('/network/vlans'), enabled });
export const useVrfs = (enabled = true) => useQuery({ queryKey: ['network', 'vrfs'], queryFn: () => api.get<VrfT[]>('/network/vrfs'), enabled });
export const useProviders = () => useQuery({ queryKey: ['network', 'providers'], queryFn: () => api.get<ProviderT[]>('/network/providers') });

/** 10000000000 → "10 Gbit/s". */
export function formatBps(bps: number | null | undefined): string {
  if (!bps) return '—';
  const units = [
    [1e12, 'Tbit/s'],
    [1e9, 'Gbit/s'],
    [1e6, 'Mbit/s'],
    [1e3, 'kbit/s'],
  ] as const;
  for (const [n, u] of units) if (bps >= n) return `${+(bps / n).toFixed(bps % n === 0 ? 0 : 1)} ${u}`;
  return `${bps} bit/s`;
}

export function formatUptime(s: number | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export const deviceLabel = (d: { hostname: string | null; assetTag: string }) => d.hostname || d.assetTag;
