import { z } from 'zod';
import { paginationSchema } from './schemas';

/* ------------------------------------------------------------------ */
/* Enumerations                                                        */
/* ------------------------------------------------------------------ */

export const LIFECYCLE_STATES = ['planned', 'received', 'inventory', 'reserved', 'racked', 'provisioning', 'active', 'maintenance', 'retired'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_LABELS: Record<LifecycleState, string> = {
  planned: 'Planned',
  received: 'Received',
  inventory: 'In inventory',
  reserved: 'Reserved',
  racked: 'Racked',
  provisioning: 'Provisioning',
  active: 'Active',
  maintenance: 'Maintenance',
  retired: 'Retired',
};

/** States in which a rack-mountable device must be placed in a rack. */
export const RACKED_STATES: readonly LifecycleState[] = ['racked', 'provisioning', 'active', 'maintenance'];

/**
 * Default transition rules seeded for every organization. Administrators can
 * change them; the API only enforces what is stored in the database.
 */
export const DEFAULT_LIFECYCLE_TRANSITIONS: readonly [LifecycleState, LifecycleState][] = [
  ['planned', 'received'],
  ['received', 'inventory'],
  ['inventory', 'reserved'],
  ['inventory', 'racked'],
  ['reserved', 'inventory'],
  ['reserved', 'racked'],
  ['racked', 'provisioning'],
  ['racked', 'active'],
  ['racked', 'inventory'],
  ['provisioning', 'active'],
  ['provisioning', 'racked'],
  ['active', 'maintenance'],
  ['active', 'racked'],
  ['maintenance', 'active'],
  ['maintenance', 'racked'],
  ['maintenance', 'inventory'],
  ['planned', 'retired'],
  ['received', 'retired'],
  ['inventory', 'retired'],
  ['reserved', 'retired'],
  ['racked', 'retired'],
  ['maintenance', 'retired'],
];

export const DEVICE_CATEGORIES = [
  'server',
  'gpu_server',
  'storage',
  'switch',
  'router',
  'firewall',
  'load_balancer',
  'optical',
  'pdu',
  'patch_panel',
  'kvm',
  'ups',
  'other',
] as const;
export type DeviceCategory = (typeof DEVICE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  server: 'Server',
  gpu_server: 'GPU server',
  storage: 'Storage',
  switch: 'Switch',
  router: 'Router',
  firewall: 'Firewall',
  load_balancer: 'Load balancer',
  optical: 'Optical / DWDM',
  pdu: 'PDU',
  patch_panel: 'Patch panel',
  kvm: 'KVM / console',
  ups: 'UPS',
  other: 'Other',
};

export const RACK_STATUSES = ['planned', 'active', 'reserved', 'decommissioned'] as const;
export const RACK_FACES = ['front', 'rear'] as const;
export type RackFace = (typeof RACK_FACES)[number];
export const OWNERSHIP = ['company', 'customer'] as const;

export const SPARE_PART_KINDS = ['ram', 'ssd', 'hdd', 'nvme', 'cpu', 'nic', 'psu', 'rail', 'transceiver', 'cable', 'fan', 'other'] as const;
export const SPARE_PART_LABELS: Record<(typeof SPARE_PART_KINDS)[number], string> = {
  ram: 'RAM',
  ssd: 'SSD',
  hdd: 'HDD',
  nvme: 'NVMe',
  cpu: 'CPU',
  nic: 'NIC',
  psu: 'Power supply',
  rail: 'Rails',
  transceiver: 'Transceiver',
  cable: 'Cable',
  fan: 'Fan',
  other: 'Other',
};

/* ------------------------------------------------------------------ */
/* Input schemas                                                       */
/* ------------------------------------------------------------------ */

const name = z.string().trim().min(1).max(120);
const optText = (max = 500) => z.string().trim().max(max).nullable().optional();
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,30}$/, 'Use letters, digits and dashes (max 31)');
const uuid = z.string().uuid();
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .nullable()
  .optional();

export const datacenterSchema = z.object({
  code,
  name,
  address: optText(500),
  city: optText(120),
  country: optText(80),
  timezone: z.string().trim().max(64).nullable().optional(),
  notes: optText(5000),
});

export const buildingSchema = z.object({ datacenterId: uuid, name, notes: optText(2000) });

export const roomSchema = z.object({
  buildingId: uuid,
  name,
  floor: z.string().trim().max(20).nullable().optional(),
  gridCols: z.number().int().min(1).max(200).default(20),
  gridRows: z.number().int().min(1).max(200).default(12),
  notes: optText(2000),
});

export const rowSchema = z.object({ roomId: uuid, name: z.string().trim().min(1).max(40), position: z.number().int().min(0).max(1000).default(0) });

export const rackSchema = z.object({
  roomId: uuid,
  rowId: uuid.nullable().optional(),
  name: z.string().trim().min(1).max(60),
  uHeight: z.number().int().min(1).max(60).default(42),
  depthMm: z.number().int().min(300).max(1500).default(1070),
  maxPowerW: z.number().int().min(0).max(200_000).nullable().optional(),
  maxWeightKg: z.number().int().min(0).max(5_000).nullable().optional(),
  numbering: z.enum(['bottom_up', 'top_down']).default('bottom_up'),
  status: z.enum(RACK_STATUSES).default('active'),
  customerId: uuid.nullable().optional(),
  gridX: z.number().int().min(0).max(199).nullable().optional(),
  gridY: z.number().int().min(0).max(199).nullable().optional(),
  assetTag: optText(60),
  serial: optText(120),
  notes: optText(2000),
});

export const rackMoveSchema = z.object({
  roomId: uuid,
  rowId: uuid.nullable().optional(),
  gridX: z.number().int().min(0).max(199).nullable().optional(),
  gridY: z.number().int().min(0).max(199).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const reservationSchema = z
  .object({
    startU: z.number().int().min(1).max(60),
    endU: z.number().int().min(1).max(60),
    customerId: uuid.nullable().optional(),
    reason: z.string().trim().min(1).max(300),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .refine((r) => r.endU >= r.startU, { message: 'End unit must be at or above the start unit', path: ['endU'] });

export const manufacturerSchema = z.object({ name });

export const deviceModelSchema = z.object({
  manufacturerId: uuid,
  name,
  category: z.enum(DEVICE_CATEGORIES),
  uHeight: z.number().int().min(0).max(60),
  depthMm: z.number().int().min(0).max(1500).nullable().optional(),
  fullDepth: z.boolean().default(true),
  typicalPowerW: z.number().int().min(0).max(100_000).nullable().optional(),
  idlePowerW: z.number().int().min(0).max(100_000).nullable().optional(),
  maxPowerW: z.number().int().min(0).max(100_000).nullable().optional(),
  psuCount: z.number().int().min(0).max(16).nullable().optional(),
  psuRatedW: z.number().int().min(0).max(20_000).nullable().optional(),
  weightKg: z.number().min(0).max(2000).nullable().optional(),
  notes: optText(2000),
});

const nic = z.object({ name: z.string().trim().max(40), mac: z.string().trim().regex(/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, 'Invalid MAC address').nullable().optional(), speed: z.string().trim().max(20).nullable().optional() });
const disk = z.object({ slot: z.string().trim().max(20).nullable().optional(), type: z.string().trim().max(20), sizeGb: z.number().min(0).max(1_000_000), model: z.string().trim().max(80).nullable().optional() });

export const deviceSchema = z.object({
  modelId: uuid,
  assetTag: z.string().trim().min(1).max(60),
  hostname: z.string().trim().max(253).nullable().optional(),
  serial: z.string().trim().max(120).nullable().optional(),
  ownership: z.enum(OWNERSHIP).default('company'),
  customerId: uuid.nullable().optional(),
  cpu: optText(200),
  cpuCount: z.number().int().min(0).max(64).nullable().optional(),
  ramGb: z.number().int().min(0).max(1_000_000).nullable().optional(),
  dimmLayout: optText(500),
  disks: z.array(disk).max(64).default([]),
  raid: optText(120),
  nics: z.array(nic).max(32).default([]),
  mgmtType: z.enum(['idrac', 'ilo', 'ipmi', 'redfish', 'other']).nullable().optional(),
  mgmtAddress: z.string().trim().max(120).nullable().optional(),
  biosVersion: optText(60),
  bmcFirmware: optText(60),
  os: optText(120),
  purchaseDate: isoDate,
  supplier: optText(200),
  purchaseCost: z.number().min(0).max(1e10).nullable().optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).nullable().optional(),
  warrantyExpires: isoDate,
  eolDate: isoDate,
  notes: optText(5000),
  custom: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).default({}),
});
export type DeviceInput = z.infer<typeof deviceSchema>;

export const placementSchema = z.object({
  rackId: uuid.nullable(),
  positionU: z.number().int().min(1).max(60).nullable().optional(),
  face: z.enum(RACK_FACES).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

export const transitionSchema = z.object({ to: z.enum(LIFECYCLE_STATES), note: z.string().trim().max(1000).optional() });

export const deviceEventSchema = z.object({ kind: z.enum(['maintenance', 'note']), summary: z.string().trim().min(1).max(2000) });

export const deviceListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  state: z.enum(LIFECYCLE_STATES).optional(),
  category: z.enum(DEVICE_CATEGORIES).optional(),
  datacenterId: uuid.optional(),
  rackId: uuid.optional(),
  customerId: uuid.optional(),
  unracked: z.enum(['true', 'false']).optional(),
  warrantyWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  sort: z.enum(['assetTag', 'hostname', 'state', 'warranty', 'updated']).default('assetTag'),
});

export const bulkDeviceSchema = z.object({
  ids: z.array(uuid).min(1).max(500),
  set: z
    .object({
      customerId: uuid.nullable().optional(),
      ownership: z.enum(OWNERSHIP).optional(),
      supplier: optText(200),
      warrantyExpires: isoDate,
    })
    .optional(),
  transitionTo: z.enum(LIFECYCLE_STATES).optional(),
});

export const lifecycleRulesSchema = z.object({
  transitions: z.array(z.tuple([z.enum(LIFECYCLE_STATES), z.enum(LIFECYCLE_STATES)])).max(81),
});

export const sparePartSchema = z.object({
  datacenterId: uuid.nullable().optional(),
  kind: z.enum(SPARE_PART_KINDS),
  manufacturer: optText(80),
  partNumber: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(300),
  quantity: z.number().int().min(0).max(1_000_000).default(0),
  minQuantity: z.number().int().min(0).max(1_000_000).default(0),
  location: optText(120),
  unitCost: z.number().min(0).max(1e9).nullable().optional(),
  notes: optText(2000),
});

export const sparePartAdjustSchema = z.object({
  delta: z
    .number()
    .int()
    .min(-100_000)
    .max(100_000)
    .refine((d) => d !== 0, 'Change cannot be zero'),
  reason: z.string().trim().min(1).max(300),
  deviceId: uuid.nullable().optional(),
});

export const deviceImportSchema = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) });

/** Rack units occupied by a device placed at `position` with height `u` (inclusive). */
export function occupiedUnits(position: number, uHeight: number): number[] {
  return Array.from({ length: uHeight }, (_, i) => position + i);
}

/** States a device may start in when created by hand or imported. */
export const INITIAL_STATES = ['planned', 'received', 'inventory'] as const;
export const deviceCreateSchema = deviceSchema.extend({ initialState: z.enum(INITIAL_STATES).default('planned') });
export type DeviceCreateInput = z.infer<typeof deviceCreateSchema>;
