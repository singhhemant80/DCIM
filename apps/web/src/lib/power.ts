import { POWER_SOURCE_LABELS, type PowerQuality } from '@crapplet/shared';

export interface PowerNowT {
  measuredW: number;
  estimatedW: number;
  devices: number;
  measuredDevices: number;
  estimatedDevices: number;
  unknownDevices: number;
}

export interface EnergyT {
  key: string;
  measuredKwh: number;
  estimatedKwh: number;
  unknownHours: number;
  measuredHours: number;
  estimatedHours: number;
  cost: { currency: string; amount: number; estimatedPart: number }[];
  unpricedKwh: number;
}

export interface DevicePowerT {
  deviceId: string;
  name: string;
  assetTag: string;
  category: string;
  lifecycleState: string;
  customerId: string | null;
  customerName: string | null;
  rackId: string | null;
  rackName: string | null;
  datacenterId: string | null;
  datacenterCode: string | null;
  counted: boolean;
  watts: number | null;
  quality: PowerQuality;
  source: string | null;
  at: string | null;
  estimateW: number | null;
  estimateKind: 'admin' | 'model' | null;
  polling: { credentialKind: string; enabled: boolean; lastOkAt: string | null; lastError: string | null; consecutiveFailures: number } | null;
  energy?: EnergyT | null;
}

export interface PowerSummaryT {
  period: { name: string; from: string; to: string; timezone: string; roundedToHours: boolean };
  now: PowerNowT;
  energy: EnergyT | null;
  byDatacenter: { datacenterId: string | null; datacenterCode: string | null; now: PowerNowT; energy: EnergyT | null }[];
  byCategory: { category: string; now: PowerNowT; energy: EnergyT | null }[];
  top: DevicePowerT[];
}

export const sourceLabel = (s: string | null) => (s ? (POWER_SOURCE_LABELS[s] ?? s) : '—');

export function money(cost: EnergyT['cost'] | undefined): string {
  if (!cost?.length) return '—';
  return cost.map((c) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: c.currency, maximumFractionDigits: 2 }).format(c.amount)).join(' + ');
}

export function hours(h: number): string {
  if (h <= 0) return '0 h';
  if (h < 1) return `${Math.round(h * 60)} min`;
  return h < 100 ? `${h.toFixed(1)} h` : `${Math.round(h)} h`;
}
