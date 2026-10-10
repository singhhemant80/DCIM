import { z } from 'zod';
import { paginationSchema } from './schemas';

/* ------------------------------------------------------------------ polling */

/** Access methods that can read interface counters. */
export const POLL_KINDS = ['snmp_v2c', 'snmp_v3', 'routeros_rest', 'routeros_api', 'fortios_rest', 'nxapi'] as const;
export type PollKind = (typeof POLL_KINDS)[number];

export const deviceMonitoringSchema = z.object({
  enabled: z.boolean(),
  credentialKind: z.enum(POLL_KINDS),
  /** Seconds between polls. */
  intervalSeconds: z.number().int().min(30).max(3600).default(60),
});
export type DeviceMonitoringInput = z.infer<typeof deviceMonitoringSchema>;

export const monitoringSettingsSchema = z.object({
  /** Raw (per-poll) samples are kept this many days. */
  rawDays: z.number().int().min(1).max(90).default(7),
  /** 5-minute aggregates. */
  fiveMinuteDays: z.number().int().min(7).max(730).default(90),
  /** Hourly aggregates. */
  hourlyDays: z.number().int().min(30).max(1825).default(730),
});

export const RATE_RANGES = ['1h', '6h', '24h', '7d', '30d'] as const;
export type RateRange = (typeof RATE_RANGES)[number];
/** Which resolution backs each range: raw samples, 5-minute or hourly aggregates. */
export const RANGE_RESOLUTION: Record<RateRange, { seconds: number; table: 'raw' | '5m' | '1h' }> = {
  '1h': { seconds: 3600, table: 'raw' },
  '6h': { seconds: 6 * 3600, table: 'raw' },
  '24h': { seconds: 24 * 3600, table: '5m' },
  '7d': { seconds: 7 * 86400, table: '5m' },
  '30d': { seconds: 30 * 86400, table: '1h' },
};

export const rateHistoryQuerySchema = z.object({ range: z.enum(RATE_RANGES).default('1h') });

export const portListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  deviceId: z.string().uuid().optional(),
  datacenterId: z.string().uuid().optional(),
  sort: z.enum(['utilization', 'traffic', 'name', 'errors']).default('traffic'),
  /** Only ports that count towards totals (uplinks/transit). */
  totalsOnly: z.enum(['true', 'false']).optional(),
});

/* ------------------------------------------------------------------ alerts */

export const ALERT_METRICS = ['util_max', 'util_in', 'util_out', 'in_bps', 'out_bps', 'errors_ps', 'discards_ps', 'oper_down', 'device_unreachable'] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];
export const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  util_max: 'Utilization, either direction (%)',
  util_in: 'Inbound utilization (%)',
  util_out: 'Outbound utilization (%)',
  in_bps: 'Inbound traffic (bit/s)',
  out_bps: 'Outbound traffic (bit/s)',
  errors_ps: 'Interface errors (per second)',
  discards_ps: 'Discarded packets (per second)',
  oper_down: 'Port down (enabled but link down)',
  device_unreachable: 'Device not answering polls',
};
/** Metrics with no threshold (a state, not a number). */
export const STATE_METRICS: readonly AlertMetric[] = ['oper_down', 'device_unreachable'];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_SCOPES = ['all', 'totals', 'datacenter', 'devices', 'interfaces'] as const;
export const ALERT_SCOPE_LABELS: Record<(typeof ALERT_SCOPES)[number], string> = {
  all: 'Every monitored port',
  totals: 'Ports that count towards totals (uplinks, transit)',
  datacenter: 'Ports in one datacenter',
  devices: 'Ports on selected devices',
  interfaces: 'Selected ports',
};

const uuid = z.string().uuid();

export const alertRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    enabled: z.boolean().default(true),
    metric: z.enum(ALERT_METRICS),
    comparator: z.enum(['gt', 'lt']).default('gt'),
    threshold: z.number().min(0).max(1e13).default(0),
    /** The condition must hold this long… */
    forSeconds: z.number().int().min(0).max(86400).default(300),
    /** …and for at least this many consecutive samples. */
    minSamples: z.number().int().min(1).max(60).default(3),
    /** Consecutive good samples needed to resolve (avoids flapping). */
    clearSamples: z.number().int().min(1).max(60).default(2),
    severity: z.enum(ALERT_SEVERITIES).default('warning'),
    scope: z.enum(ALERT_SCOPES).default('all'),
    datacenterId: uuid.nullable().optional(),
    deviceIds: z.array(uuid).max(500).default([]),
    interfaceIds: z.array(uuid).max(2000).default([]),
    channelIds: z.array(uuid).max(20).default([]),
    notifyOnResolve: z.boolean().default(true),
  })
  .superRefine((r, ctx) => {
    if (r.scope === 'datacenter' && !r.datacenterId) ctx.addIssue({ code: 'custom', path: ['datacenterId'], message: 'Choose a datacenter' });
    if (r.scope === 'devices' && !r.deviceIds.length) ctx.addIssue({ code: 'custom', path: ['deviceIds'], message: 'Choose at least one device' });
    if (r.scope === 'interfaces' && !r.interfaceIds.length) ctx.addIssue({ code: 'custom', path: ['interfaceIds'], message: 'Choose at least one port' });
    if (r.metric.startsWith('util_') && r.threshold > 100) ctx.addIssue({ code: 'custom', path: ['threshold'], message: 'Utilization is a percentage (0–100)' });
    if (r.metric === 'device_unreachable' && (r.scope === 'interfaces' || r.scope === 'totals')) {
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'Device reachability applies to devices: use all, datacenter or devices' });
    }
  });
export type AlertRuleInput = z.infer<typeof alertRuleSchema>;

export const alertListQuerySchema = paginationSchema.extend({
  status: z.enum(['firing', 'resolved', 'all']).default('firing'),
  severity: z.enum(ALERT_SEVERITIES).optional(),
  deviceId: uuid.optional(),
});
export const alertAckSchema = z.object({ note: z.string().trim().max(500).optional() });

export const maintenanceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    scope: z.enum(['all', 'datacenter', 'devices']).default('devices'),
    datacenterId: uuid.nullable().optional(),
    deviceIds: z.array(uuid).max(500).default([]),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine((m, ctx) => {
    if (new Date(m.endsAt) <= new Date(m.startsAt)) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Must end after it starts' });
    if (new Date(m.endsAt).getTime() - new Date(m.startsAt).getTime() > 31 * 86400_000) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'At most 31 days' });
    if (m.scope === 'datacenter' && !m.datacenterId) ctx.addIssue({ code: 'custom', path: ['datacenterId'], message: 'Choose a datacenter' });
    if (m.scope === 'devices' && !m.deviceIds.length) ctx.addIssue({ code: 'custom', path: ['deviceIds'], message: 'Choose at least one device' });
  });

/* ------------------------------------------------------------------ notifications */

export const CHANNEL_KINDS = ['email', 'webhook', 'slack', 'telegram'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = { email: 'Email (SMTP)', webhook: 'Webhook (signed JSON)', slack: 'Slack', telegram: 'Telegram' };

const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u) && !/^https?:\/\/[^/]*@/i.test(u), 'Use an http(s) URL without credentials');
const secret = z.string().min(8).max(500);

export const channelSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    to: z.array(z.string().trim().email()).min(1).max(20),
    from: z.string().trim().email(),
    smtpHost: z.string().trim().min(1).max(255),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    /** 'tls' = implicit TLS (465), 'starttls' = upgrade (587), 'none' = lab only. */
    smtpSecurity: z.enum(['starttls', 'tls', 'none']).default('starttls'),
    smtpUser: z.string().trim().max(255).nullable().optional(),
    smtpPassword: z.string().max(500).nullable().optional(),
  }),
  z.object({
    kind: z.literal('webhook'),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    url: httpsUrl,
    /** HMAC-SHA256 signing secret (X-CDCIM-Signature). */
    signingSecret: secret,
  }),
  z.object({
    kind: z.literal('slack'),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    webhookUrl: z
      .string()
      .trim()
      .max(500)
      .regex(/^https:\/\/hooks\.slack\.com\/[A-Za-z0-9/_-]+$/, 'A Slack incoming-webhook URL (https://hooks.slack.com/…)'),
  }),
  z.object({
    kind: z.literal('telegram'),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(true),
    botToken: z.string().trim().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, 'Looks like 123456:ABC-…'),
    chatId: z.string().trim().regex(/^-?\d+$|^@[A-Za-z0-9_]{5,}$/, 'A numeric chat id or @channel'),
  }),
]);
export type ChannelInput = z.infer<typeof channelSchema>;
/** Fields of each channel kind that are secret (encrypted, never returned). */
export const CHANNEL_SECRET_FIELDS: Record<ChannelKind, string[]> = {
  email: ['smtpPassword'],
  webhook: ['signingSecret'],
  slack: ['webhookUrl'],
  telegram: ['botToken'],
};
