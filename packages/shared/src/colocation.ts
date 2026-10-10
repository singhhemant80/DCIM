import { z } from 'zod';
import { paginationSchema } from './schemas';

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Not a valid date');

/* ------------------------------------------------------------------ services (orders) */

export const SERVICE_KINDS = ['colocation', 'dedicated_server', 'vps', 'ip_transit', 'cross_connect', 'remote_hands', 'other'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
  colocation: 'Colocation',
  dedicated_server: 'Dedicated server',
  vps: 'Virtual server',
  ip_transit: 'IP transit',
  cross_connect: 'Cross-connect',
  remote_hands: 'Remote hands plan',
  other: 'Other',
};

/**
 * pending → active | cancelled; active ⇄ suspended; active | suspended → terminated.
 * Cancelled and terminated are final. Status changes are recorded with who and why;
 * they never touch equipment (suspending a service does not switch anything off).
 */
export const SERVICE_STATUSES = ['pending', 'active', 'suspended', 'cancelled', 'terminated'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = { pending: 'Pending', active: 'Active', suspended: 'Suspended', cancelled: 'Cancelled', terminated: 'Terminated' };
export const SERVICE_TRANSITIONS: Record<ServiceStatus, readonly ServiceStatus[]> = {
  pending: ['active', 'cancelled'],
  active: ['suspended', 'terminated'],
  suspended: ['active', 'terminated'],
  cancelled: [],
  terminated: [],
};

export const serviceSchema = z
  .object({
    customerId: uuid,
    kind: z.enum(SERVICE_KINDS),
    name: text(160),
    description: optText(2000),
    startDate: day.nullable().optional(),
    endDate: day.nullable().optional(),
    /** Reference in the billing system (e.g. WHMCS service id). */
    billingReference: optText(120),
    deviceId: uuid.nullable().optional(),
    guestId: uuid.nullable().optional(),
    /** Staff only; never shown to the customer. */
    notes: optText(4000),
  })
  .superRefine((v, ctx) => {
    if (v.startDate && v.endDate && v.endDate < v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Ends before it starts' });
  });
export type ServiceInput = z.infer<typeof serviceSchema>;
export const serviceStatusSchema = z.object({ status: z.enum(SERVICE_STATUSES), reason: optText(500) });
export const serviceListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  customerId: uuid.optional(),
  kind: z.enum(SERVICE_KINDS).optional(),
  status: z.enum(SERVICE_STATUSES).optional(),
});

/* ------------------------------------------------------------------ rack space allocations */

export const ALLOCATION_KINDS = ['full', 'half', 'quarter', 'custom'] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];
export const ALLOCATION_KIND_LABELS: Record<AllocationKind, string> = { full: 'Full rack', half: 'Half rack', quarter: 'Quarter rack', custom: 'Custom units' };
export const POWER_FEEDS = ['single', 'a_b'] as const;
export const POWER_FEED_LABELS: Record<(typeof POWER_FEEDS)[number], string> = { single: 'Single feed', a_b: 'A + B (redundant)' };

export const allocationSchema = z
  .object({
    customerId: uuid,
    serviceId: uuid.nullable().optional(),
    rackId: uuid,
    kind: z.enum(ALLOCATION_KINDS),
    /** Half: 1 = lower, 2 = upper. Quarter: 1–4 from the bottom. */
    part: z.number().int().min(1).max(4).nullable().optional(),
    /** Custom only. */
    startU: z.number().int().min(1).max(60).nullable().optional(),
    endU: z.number().int().min(1).max(60).nullable().optional(),
    /** Contracted power for this space, in watts. */
    contractedPowerW: z.number().int().min(0).max(100_000),
    feeds: z.enum(POWER_FEEDS).default('single'),
    breakerAmps: z.number().int().min(1).max(125).nullable().optional(),
    voltage: z.number().int().min(100).max(480).nullable().optional(),
    startDate: day,
    notes: optText(2000),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'half' && (!v.part || v.part > 2)) ctx.addIssue({ code: 'custom', path: ['part'], message: 'Choose the lower (1) or upper (2) half' });
    if (v.kind === 'quarter' && !v.part) ctx.addIssue({ code: 'custom', path: ['part'], message: 'Choose a quarter (1–4, from the bottom)' });
    if (v.kind === 'custom') {
      if (!v.startU || !v.endU) ctx.addIssue({ code: 'custom', path: ['startU'], message: 'Give the first and last unit' });
      else if (v.endU < v.startU) ctx.addIssue({ code: 'custom', path: ['endU'], message: 'The last unit is below the first' });
    }
  });
export type AllocationInput = z.infer<typeof allocationSchema>;
/** Fields left out keep their current value; null clears them. */
export const allocationUpdateSchema = z.object({
  serviceId: uuid.nullable().optional(),
  contractedPowerW: z.number().int().min(0).max(100_000),
  feeds: z.enum(POWER_FEEDS),
  breakerAmps: z.number().int().min(1).max(125).nullable().optional(),
  voltage: z.number().int().min(100).max(480).nullable().optional(),
  notes: optText(2000),
});
export const allocationEndSchema = z.object({ endDate: day, reason: optText(500) });

/** Units an allocation covers in a rack of `height` units (numbered 1 = bottom). */
export function allocationRange(kind: AllocationKind, height: number, part?: number | null, startU?: number | null, endU?: number | null): { startU: number; endU: number } | null {
  if (kind === 'full') return { startU: 1, endU: height };
  if (kind === 'half') {
    const h = Math.floor(height / 2);
    if (h < 1 || !part || part > 2) return null;
    return part === 1 ? { startU: 1, endU: h } : { startU: h + 1, endU: height };
  }
  if (kind === 'quarter') {
    const q = Math.floor(height / 4);
    if (q < 1 || !part || part > 4) return null;
    return { startU: (part - 1) * q + 1, endU: part === 4 ? height : part * q };
  }
  if (!startU || !endU || endU < startU || endU > height) return null;
  return { startU, endU };
}

/* ------------------------------------------------------------------ cross-connects */

export const CROSS_CONNECT_MEDIA = ['smf', 'mmf', 'cat6', 'coax', 'other'] as const;
export const CROSS_CONNECT_MEDIA_LABELS: Record<(typeof CROSS_CONNECT_MEDIA)[number], string> = {
  smf: 'Single-mode fibre',
  mmf: 'Multi-mode fibre',
  cat6: 'Copper (Cat6)',
  coax: 'Coax',
  other: 'Other',
};
/** requested → approved | rejected; approved → in_progress → active; active → decommissioned. */
export const CROSS_CONNECT_STATUSES = ['requested', 'approved', 'rejected', 'in_progress', 'active', 'decommissioned'] as const;
export type CrossConnectStatus = (typeof CROSS_CONNECT_STATUSES)[number];
export const CROSS_CONNECT_STATUS_LABELS: Record<CrossConnectStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  rejected: 'Rejected',
  in_progress: 'Being installed',
  active: 'Active',
  decommissioned: 'Decommissioned',
};
export const CROSS_CONNECT_TRANSITIONS: Record<CrossConnectStatus, readonly CrossConnectStatus[]> = {
  requested: ['approved', 'rejected'],
  approved: ['in_progress', 'rejected'],
  in_progress: ['active'],
  active: ['decommissioned'],
  rejected: [],
  decommissioned: [],
};

export const crossConnectSchema = z.object({
  /** Staff choose the customer; a customer's own requests are always theirs. */
  customerId: uuid.optional(),
  serviceId: uuid.nullable().optional(),
  /** Customer side: one of their devices (and optionally a port), plus a free-text label. */
  aDeviceId: uuid.nullable().optional(),
  aInterfaceId: uuid.nullable().optional(),
  aLabel: text(200),
  /** Other side: carrier, another customer or a meet-me-room panel, as text (and an LOA/CFA reference). */
  zLabel: text(200),
  loaReference: optText(120),
  media: z.enum(CROSS_CONNECT_MEDIA),
  speed: optText(40),
  notes: optText(2000),
});
export type CrossConnectInput = z.infer<typeof crossConnectSchema>;
export const crossConnectStatusSchema = z.object({
  status: z.enum(CROSS_CONNECT_STATUSES),
  /** Circuit / cross-connect id given when it is installed. */
  circuitId: optText(120),
  /** The documented cable in Network Infrastructure, when there is one. */
  cableId: uuid.nullable().optional(),
  reason: optText(500),
});

/* ------------------------------------------------------------------ shipments (receiving) */

export const SHIPMENT_STATUSES = ['expected', 'received', 'delivered', 'shipped_out', 'cancelled'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];
export const SHIPMENT_STATUS_LABELS: Record<ShipmentStatus, string> = { expected: 'Expected', received: 'Received, in storage', delivered: 'Delivered to rack', shipped_out: 'Shipped out', cancelled: 'Cancelled' };
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  expected: ['received', 'cancelled'],
  received: ['delivered', 'shipped_out'],
  delivered: [],
  shipped_out: [],
  cancelled: [],
};
export const SHIPMENT_DIRECTIONS = ['inbound', 'outbound'] as const;

export const shipmentSchema = z.object({
  customerId: uuid.optional(),
  datacenterId: uuid,
  direction: z.enum(SHIPMENT_DIRECTIONS).default('inbound'),
  carrier: text(80),
  trackingNumber: optText(120),
  expectedOn: day.nullable().optional(),
  packages: z.number().int().min(1).max(500).default(1),
  description: text(1000),
  /** What to do on arrival. */
  instructions: optText(1000),
});
export type ShipmentInput = z.infer<typeof shipmentSchema>;
export const shipmentStatusSchema = z.object({
  status: z.enum(SHIPMENT_STATUSES),
  storageLocation: optText(120),
  packagesReceived: z.number().int().min(0).max(500).nullable().optional(),
  /** Condition on arrival (damage etc.). */
  conditionNote: optText(1000),
});

/* ------------------------------------------------------------------ visits */

export const VISIT_STATUSES = ['requested', 'approved', 'denied', 'checked_in', 'checked_out', 'cancelled'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const VISIT_STATUS_LABELS: Record<VisitStatus, string> = { requested: 'Requested', approved: 'Approved', denied: 'Denied', checked_in: 'On site', checked_out: 'Left', cancelled: 'Cancelled' };
export const VISIT_TRANSITIONS: Record<VisitStatus, readonly VisitStatus[]> = {
  requested: ['approved', 'denied', 'cancelled'],
  approved: ['checked_in', 'cancelled'],
  checked_in: ['checked_out'],
  denied: [],
  checked_out: [],
  cancelled: [],
};

export const visitSchema = z
  .object({
    customerId: uuid.optional(),
    datacenterId: uuid,
    /** Names as on the ID document. Only the last 4 characters of the ID number are kept. */
    visitors: z
      .array(z.object({ name: text(120), company: optText(120), idLast4: z.string().trim().regex(/^[A-Za-z0-9]{2,4}$/, '2–4 letters or digits').nullable().optional() }))
      .min(1)
      .max(10),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    purpose: text(500),
  })
  .superRefine((v, ctx) => {
    const s = Date.parse(v.startsAt);
    const e = Date.parse(v.endsAt);
    if (e <= s) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'Ends before it starts' });
    if (e - s > 14 * 86_400_000) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'At most 14 days per visit' });
  });
export type VisitInput = z.infer<typeof visitSchema>;
export const visitStatusSchema = z.object({ status: z.enum(VISIT_STATUSES), note: optText(500), escort: z.boolean().optional(), badge: optText(40) });

/* ------------------------------------------------------------------ tickets and remote hands */

export const TICKET_KINDS = ['support', 'remote_hands', 'cross_connect', 'shipment', 'access', 'billing', 'other'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export const TICKET_KIND_LABELS: Record<TicketKind, string> = {
  support: 'Support',
  remote_hands: 'Remote hands',
  cross_connect: 'Cross-connect',
  shipment: 'Shipment',
  access: 'Site access',
  billing: 'Billing',
  other: 'Other',
};
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = { open: 'Open', in_progress: 'In progress', waiting_customer: 'Waiting for customer', resolved: 'Resolved', closed: 'Closed' };
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'waiting_customer'];

export const ticketSchema = z.object({
  /** Staff: optional (internal ticket) or any customer. Customers: always their own. */
  customerId: uuid.nullable().optional(),
  kind: z.enum(TICKET_KINDS),
  priority: z.enum(TICKET_PRIORITIES).default('normal'),
  subject: text(200),
  body: text(20_000),
  deviceId: uuid.nullable().optional(),
  /** Remote hands: minutes of work the customer authorizes (billable). */
  authorizedMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
});
export type TicketInput = z.infer<typeof ticketSchema>;
export const ticketMessageSchema = z.object({
  body: text(20_000),
  /** Staff only: a note the customer never sees. */
  internal: z.boolean().default(false),
});
export const ticketUpdateSchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  assigneeUserId: uuid.nullable().optional(),
  authorizedMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
});
export const ticketTimeSchema = z.object({ minutes: z.number().int().min(1).max(24 * 60), note: text(500), billable: z.boolean().default(true) });
export const ticketListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['open', 'all', ...TICKET_STATUSES]).default('open'),
  kind: z.enum(TICKET_KINDS).optional(),
  customerId: uuid.optional(),
  mine: z.enum(['true', 'false']).optional(),
});

export const coloListQuerySchema = paginationSchema.extend({
  customerId: uuid.optional(),
  datacenterId: uuid.optional(),
  status: z.string().trim().max(30).optional(),
});
