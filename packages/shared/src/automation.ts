import { z } from 'zod';
import { PERMISSION_KEYS } from './permissions';
import { paginationSchema } from './schemas';

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const httpsUrl = z
  .string()
  .trim()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) URL');

/* ------------------------------------------------------------------ events */

/**
 * Events emitted by NexoraDC. Webhook subscriptions and workflows listen to
 * them. Payloads never contain credentials.
 */
export const EVENT_TYPES = [
  'ticket.created',
  'ticket.replied',
  'ticket.status_changed',
  'service.created',
  'service.status_changed',
  'allocation.created',
  'allocation.ended',
  'cross_connect.requested',
  'cross_connect.status_changed',
  'shipment.created',
  'shipment.status_changed',
  'visit.requested',
  'visit.status_changed',
  'provisioning.job_finished',
  'alert.firing',
  'alert.resolved',
  'incident.created',
  'incident.updated',
  'billing.event_applied',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/* ------------------------------------------------------------------ API keys */

export const apiKeySchema = z.object({
  name: text(80),
  /** Permissions the key may use; always limited to its owner's current permissions. */
  scopes: z.array(z.enum(PERMISSION_KEYS as unknown as [string, ...string[]])).min(1).max(PERMISSION_KEYS.length),
  expiresInDays: z.number().int().min(1).max(730).nullable().optional(),
});

/* ------------------------------------------------------------------ outbound webhooks */

export const webhookSubscriptionSchema = z.object({
  name: text(80),
  url: httpsUrl,
  events: z.array(z.enum(['*', ...EVENT_TYPES])).min(1),
  enabled: z.boolean().default(true),
});
export type WebhookSubscriptionInput = z.infer<typeof webhookSubscriptionSchema>;

/* ------------------------------------------------------------------ billing (WHMCS) */

export const billingIntegrationSchema = z.object({
  name: text(80),
  /** WHMCS address (for reference and links). */
  url: httpsUrl.nullable().optional(),
  autoCreateCustomers: z.boolean().default(true),
  autoCreateServices: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
export const productMappingSchema = z.object({
  productId: text(40),
  kind: z.enum(['colocation', 'dedicated_server', 'vps', 'ip_transit', 'cross_connect', 'remote_hands', 'other']),
  label: optText(120),
});

/** Inbound event envelope sent by the WHMCS module. */
export const billingEventSchema = z.object({
  /** Unique per event; repeats are recognized and not applied again. */
  id: text(120),
  type: z.enum(['client.upsert', 'service.created', 'service.activated', 'service.suspended', 'service.unsuspended', 'service.terminated', 'service.cancelled']),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  data: z.record(z.unknown()),
});
export const billingClientSchema = z.object({
  clientId: z.union([z.string(), z.number()]).transform(String),
  name: text(200),
  email: z.string().trim().max(254).nullable().optional(),
  status: z.enum(['Active', 'Inactive', 'Closed']).default('Active'),
});
export const billingServiceSchema = z.object({
  serviceId: z.union([z.string(), z.number()]).transform(String),
  clientId: z.union([z.string(), z.number()]).transform(String).optional(),
  productId: z.union([z.string(), z.number()]).transform(String).optional(),
  name: z.string().trim().max(200).optional(),
  reason: z.string().trim().max(500).optional(),
});
export const reconcileSchema = z.object({
  services: z
    .array(
      z.object({
        serviceId: z.union([z.string(), z.number()]).transform(String),
        clientId: z.union([z.string(), z.number()]).transform(String),
        productId: z.union([z.string(), z.number()]).transform(String).optional(),
        status: z.string().trim().max(40),
        name: z.string().trim().max(200).optional(),
      }),
    )
    .max(50_000),
});
export const usageQuerySchema = z.object({
  billingReference: text(120),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

/* ------------------------------------------------------------------ workflows */

export const CONDITION_OPS = ['eq', 'neq', 'in', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists'] as const;
export const conditionSchema = z.object({
  /** Dot path into the event, e.g. `payload.priority` or `customerId`. */
  field: z.string().trim().regex(/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*){0,5}$/, 'A dot path like payload.priority'),
  op: z.enum(CONDITION_OPS),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.union([z.string().max(200), z.number()])).max(50)]).nullable().optional(),
});

/**
 * Workflow actions. They only create or change records and send messages:
 * no action can switch power, change network configuration or touch routes.
 */
export const ACTION_TYPES = ['create_ticket', 'add_ticket_note', 'set_ticket_priority', 'assign_ticket', 'notify'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ACTION_LABELS: Record<ActionType, string> = {
  create_ticket: 'Create a ticket',
  add_ticket_note: 'Add an internal note to the ticket',
  set_ticket_priority: 'Set the ticket priority',
  assign_ticket: 'Assign the ticket',
  notify: 'Send a notification',
};
export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_ticket'),
    requiresApproval: z.boolean().default(false),
    /** Use the event's customer, or create an internal ticket. */
    forCustomer: z.enum(['event', 'none']).default('event'),
    kind: z.enum(['support', 'remote_hands', 'cross_connect', 'shipment', 'access', 'billing', 'other']).default('support'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    subject: text(200),
    body: text(5000),
  }),
  z.object({ type: z.literal('add_ticket_note'), requiresApproval: z.boolean().default(false), body: text(5000) }),
  z.object({ type: z.literal('set_ticket_priority'), requiresApproval: z.boolean().default(false), priority: z.enum(['low', 'normal', 'high', 'urgent']) }),
  z.object({ type: z.literal('assign_ticket'), requiresApproval: z.boolean().default(false), userId: uuid }),
  z.object({ type: z.literal('notify'), requiresApproval: z.boolean().default(false), channelId: uuid, title: text(200), text: text(5000) }),
]);
export type WorkflowAction = z.infer<typeof actionSchema>;
export const workflowSchema = z.object({
  name: text(120),
  description: optText(1000),
  enabled: z.boolean().default(true),
  trigger: z.enum(EVENT_TYPES),
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: z.array(actionSchema).min(1).max(10),
});
export type WorkflowInput = z.infer<typeof workflowSchema>;
export const dryRunSchema = z.object({
  workflow: workflowSchema,
  /** A stored event to test against, or a sample. */
  eventId: z.number().int().positive().optional(),
  sample: z.object({ customerId: uuid.nullable().optional(), payload: z.record(z.unknown()) }).optional(),
});
export const runDecisionSchema = z.object({ note: optText(500) });

/* ------------------------------------------------------------------ reports */

export const REPORT_TYPES = ['energy', 'bandwidth', 'capacity', 'remote_hands', 'services'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_LABELS: Record<ReportType, string> = {
  energy: 'Energy by customer',
  bandwidth: 'Bandwidth (95th percentile) by customer and port',
  capacity: 'Space and power capacity by datacenter',
  remote_hands: 'Remote-hands time by customer',
  services: 'Services inventory',
};
export const REPORT_PERIODS = ['last_7d', 'last_30d', 'this_month', 'last_month'] as const;
export const reportQuerySchema = z.object({
  type: z.enum(REPORT_TYPES),
  period: z.enum(REPORT_PERIODS).default('last_month'),
  format: z.enum(['json', 'csv', 'pdf']).default('json'),
});
export const reportScheduleSchema = z
  .object({
    name: text(120),
    type: z.enum(REPORT_TYPES),
    period: z.enum(REPORT_PERIODS).default('last_month'),
    format: z.enum(['csv', 'pdf']).default('pdf'),
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    /** Hour of day in the organization's time zone. */
    hour: z.number().int().min(0).max(23).default(6),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
    /** An email notification channel (its SMTP settings are used). */
    channelId: uuid,
    recipients: z.array(z.string().trim().toLowerCase().email()).min(1).max(20),
    enabled: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.frequency === 'weekly' && v.weekday == null) ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'Choose the day of the week' });
    if (v.frequency === 'monthly' && v.dayOfMonth == null) ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'Choose the day of the month' });
  });

/* ------------------------------------------------------------------ incidents and maintenance notices */

export const INCIDENT_SEVERITIES = ['minor', 'major', 'critical'] as const;
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved' };
export const incidentSchema = z.object({
  title: text(200),
  severity: z.enum(INCIDENT_SEVERITIES),
  /** Affected site; customers with equipment or space there see the incident when it is public. */
  datacenterId: uuid.nullable().optional(),
  /** Specific customers affected (in addition to, or instead of, a whole site). */
  customerIds: z.array(uuid).max(500).default([]),
  public: z.boolean().default(true),
  message: text(5000),
  startedAt: z.string().datetime({ offset: true }).optional(),
});
export const incidentUpdateSchema = z.object({
  status: z.enum(INCIDENT_STATUSES),
  message: text(5000),
  /** Internal updates are never shown to customers. */
  public: z.boolean().default(true),
});
export const maintenanceNoticeSchema = z.object({
  customerVisible: z.boolean(),
  description: optText(2000),
});
export const incidentListQuerySchema = paginationSchema.extend({ status: z.enum(['open', 'resolved', 'all']).default('open') });
