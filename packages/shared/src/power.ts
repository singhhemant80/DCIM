import { z } from 'zod';
import { paginationSchema } from './schemas';
import type { CredentialKind } from './network';

/** Access methods that can read power. */
export const POWER_KINDS = ['redfish', 'ipmi', 'snmp_v2c', 'snmp_v3', 'nxapi', 'routeros_rest', 'routeros_api'] as const satisfies readonly CredentialKind[];
export type PowerKind = (typeof POWER_KINDS)[number];

/** Where a measured reading came from, highest priority first. */
export const POWER_SOURCE_LABELS: Record<string, string> = {
  pdu_outlet: 'PDU outlet',
  redfish: 'Redfish (BMC)',
  ipmi: 'IPMI DCMI (BMC)',
  nxos: 'NX-OS power supplies',
  routeros: 'RouterOS health',
  snmp: 'PDU total (SNMP)',
  admin: 'Admin estimate',
  model: 'Model typical draw',
};

/** Lifecycle states in which equipment is assumed to draw power (for estimates). */
export const POWERED_STATES = ['provisioning', 'active', 'maintenance'] as const;
/** Categories that distribute power to other equipment; never added to equipment totals. */
export const DISTRIBUTION_CATEGORIES = ['pdu', 'ups'] as const;

export const powerPollingSchema = z.object({
  enabled: z.boolean(),
  credentialKind: z.enum(POWER_KINDS),
  intervalSeconds: z.number().int().min(30).max(3600).default(60),
});

export const powerProfileSchema = z.object({
  /** Admin estimate in watts; null = use the model's typical draw. */
  estimateW: z.number().int().min(0).max(100_000).nullable(),
  includeInTotals: z.boolean().default(true),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const tariffSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** null = organization-wide default. */
  datacenterId: z.string().uuid().nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'A 3-letter currency code, e.g. INR'),
  pricePerKwh: z.number().positive().max(10_000),
  validFrom: z.string().datetime(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const outletMappingSchema = z.object({
  deviceId: z.string().uuid().nullable(),
  label: z.string().trim().max(80).nullable().optional(),
});

export const powerSettingsSchema = z.object({
  rawDays: z.number().int().min(7).max(365).default(35),
  hourlyDays: z.number().int().min(90).max(3650).default(1095),
});

export const POWER_PERIODS = ['24h', '7d', '30d', 'mtd', 'last_month'] as const;
export type PowerPeriod = (typeof POWER_PERIODS)[number];
export const POWER_PERIOD_LABELS: Record<PowerPeriod, string> = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', mtd: 'This month', last_month: 'Last month' };

export const powerSummaryQuerySchema = z.object({
  period: z.enum(POWER_PERIODS).default('24h'),
  datacenterId: z.string().uuid().optional(),
});

export const powerDeviceListQuerySchema = paginationSchema.extend({
  period: z.enum(POWER_PERIODS).default('24h'),
  q: z.string().trim().max(100).optional(),
  datacenterId: z.string().uuid().optional(),
  rackId: z.string().uuid().optional(),
  quality: z.enum(['measured', 'estimated', 'unknown']).optional(),
  sort: z.enum(['power', 'energy', 'name']).default('power'),
});

export const powerHistoryQuerySchema = z.object({ range: z.enum(['24h', '7d', '30d']).default('24h') });

/** 1234.5 → "1.23 kW"; null → "—". */
export function formatWattsShort(w: number | null | undefined): string {
  if (w === null || w === undefined || !Number.isFinite(w)) return '—';
  if (Math.abs(w) >= 1e6) return `${(w / 1e6).toFixed(2)} MW`;
  if (Math.abs(w) >= 1000) return `${(w / 1000).toFixed(w >= 10_000 ? 1 : 2)} kW`;
  return `${Math.round(w)} W`;
}

export function formatKwh(kwh: number | null | undefined): string {
  if (kwh === null || kwh === undefined || !Number.isFinite(kwh)) return '—';
  if (kwh >= 1000) return `${(kwh / 1000).toFixed(2)} MWh`;
  return `${kwh >= 100 ? Math.round(kwh) : kwh.toFixed(kwh >= 10 ? 1 : 2)} kWh`;
}

export const POWER_GROUPS = ['device', 'rack', 'datacenter', 'customer', 'category'] as const;
export const powerExportQuerySchema = z.object({
  period: z.enum(POWER_PERIODS).default('last_month'),
  groupBy: z.enum(POWER_GROUPS).default('device'),
});

export const POWER_QUALITY_LABELS = { measured: 'Measured', estimated: 'Estimated', unknown: 'Unknown', off: 'Not powered' } as const;
export type PowerQuality = keyof typeof POWER_QUALITY_LABELS;
