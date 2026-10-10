import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  cidr,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  macaddr,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/**
 * Phase 1 schema: identity, tenancy, RBAC, sessions and audit.
 *
 * Tenancy model
 *  - `organizations` is the operator (e.g. Crapplet Infotech). Every row in
 *    every domain table carries `org_id`; no query may cross organizations.
 *  - `customers` are tenants inside an organization. Resources owned by a
 *    customer carry `customer_id`. Customer-type users are pinned to exactly
 *    one customer (enforced by a CHECK constraint) and only ever see rows with
 *    their `customer_id`.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

export const userTypeEnum = pgEnum('user_type', ['staff', 'customer']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled']);
export const customerStatusEnum = pgEnum('customer_status', ['active', 'suspended', 'closed']);
export const auditOutcomeEnum = pgEnum('audit_outcome', ['success', 'failure', 'denied']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'system', 'api_key', 'anonymous']);

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Validated by `settingsSchema` in @crapplet/shared. */
  settings: jsonb('settings').$type<OrgSettings>().notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface OrgSettings {
  timezone?: string;
  currency?: string;
  sessionIdleMinutes?: number;
  sessionMaxHours?: number;
  requireMfaForStaff?: boolean;
}

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    contactEmail: text('contact_email'),
    phone: text('phone'),
    /** External billing-system reference (e.g. WHMCS client id) — Phase 8. */
    billingReference: text('billing_reference'),
    /** Internal notes: staff-only, never returned to customer users. */
    notes: text('notes'),
    status: customerStatusEnum('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('customers_org_code_uq').on(t.orgId, t.code),
    index('customers_org_name_idx').on(t.orgId, t.name),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    userType: userTypeEnum('user_type').notNull(),
    status: userStatusEnum('status').notNull().default('active'),
    /** AES-GCM encrypted TOTP secret (see SecretBox). */
    mfaSecretEnc: text('mfa_secret_enc'),
    mfaEnabledAt: ts('mfa_enabled_at'),
    /** Last accepted TOTP time step — codes at or before it are rejected (replay protection). */
    mfaLastTimeStep: bigint('mfa_last_time_step', { mode: 'number' }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: ts('locked_until'),
    passwordChangedAt: ts('password_changed_at').notNull().defaultNow(),
    lastLoginAt: ts('last_login_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
    index('users_org_idx').on(t.orgId),
    index('users_customer_idx').on(t.customerId),
    check('users_customer_type_ck', sql`(${t.userType} = 'customer') = (${t.customerId} IS NOT NULL)`),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Stable key for built-in roles (e.g. `super_admin`); null for custom roles. */
    systemKey: text('system_key'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    scope: userTypeEnum('scope').notNull(),
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('roles_org_name_uq').on(t.orgId, t.name),
    uniqueIndex('roles_org_system_key_uq').on(t.orgId, t.systemKey),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] }), index('user_roles_role_idx').on(t.roleId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    /** True once the second factor was satisfied (or MFA is not enabled for the user). */
    mfaSatisfied: boolean('mfa_satisfied').notNull().default(false),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const mfaChallenges = pgTable(
  'mfa_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mfa_challenges_token_hash_uq').on(t.tokenHash)],
);

export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('mfa_recovery_codes_user_idx').on(t.userId)],
);

/**
 * Append-only, hash-chained audit log. Each row's `hash` covers its content
 * and the previous row's hash for the same organization, so any edit or
 * deletion breaks the chain and is detected by `/audit/verify`. UPDATE and
 * DELETE are additionally blocked by a trigger (see migration 0001).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'restrict' }),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: uuid('actor_id'),
    /** Snapshot so the record stays meaningful if the user is later renamed. */
    actorLabel: text('actor_label'),
    /** Tenant context of the action, if any. */
    customerId: uuid('customer_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    outcome: auditOutcomeEnum('outcome').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('audit_events_org_time_idx').on(t.orgId, t.occurredAt),
    index('audit_events_actor_idx').on(t.actorId, t.occurredAt),
    index('audit_events_action_idx').on(t.orgId, t.action),
    index('audit_events_target_idx').on(t.targetType, t.targetId),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

/* ======================================================================
 * Phase 2: physical DCIM
 *
 * Organization → Datacenter → Building → Room → Row → Rack → Device.
 * Placement integrity is enforced in the database itself (see migration
 * 0003_dcim_constraints.sql): GiST exclusion constraints reject
 * overlapping equipment per rack face, and triggers reject positions beyond
 * the rack height or devices deeper than the rack.
 * ==================================================================== */

/** Postgres int4range, used for the rack units a device occupies. */
const int4range = customType<{ data: string; driverData: string }>({ dataType: () => 'int4range' });

export const lifecycleStateEnum = pgEnum('lifecycle_state', ['planned', 'received', 'inventory', 'reserved', 'racked', 'provisioning', 'active', 'maintenance', 'retired']);
export const deviceCategoryEnum = pgEnum('device_category', ['server', 'gpu_server', 'storage', 'switch', 'router', 'firewall', 'load_balancer', 'optical', 'pdu', 'patch_panel', 'kvm', 'ups', 'other']);
export const rackStatusEnum = pgEnum('rack_status', ['planned', 'active', 'reserved', 'decommissioned']);
export const rackFaceEnum = pgEnum('rack_face', ['front', 'rear']);
export const rackNumberingEnum = pgEnum('rack_numbering', ['bottom_up', 'top_down']);
export const ownershipEnum = pgEnum('ownership', ['company', 'customer']);
export const sparePartKindEnum = pgEnum('spare_part_kind', ['ram', 'ssd', 'hdd', 'nvme', 'cpu', 'nic', 'psu', 'rail', 'transceiver', 'cable', 'fan', 'other']);
export const platformEnum = pgEnum('platform', ['routeros', 'nxos', 'ios', 'iosxe', 'fortios', 'junos', 'linux', 'windows', 'proxmox', 'other']);
export const mgmtTypeEnum = pgEnum('mgmt_type', ['idrac', 'ilo', 'ipmi', 'redfish', 'other']);

const orgRef = () =>
  uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'restrict' });

export const datacenters = pgTable(
  'datacenters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    city: text('city'),
    country: text('country'),
    timezone: text('timezone'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('datacenters_org_code_uq').on(t.orgId, t.code)],
);

export const buildings = pgTable(
  'buildings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    datacenterId: uuid('datacenter_id')
      .notNull()
      .references(() => datacenters.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('buildings_dc_name_uq').on(t.datacenterId, t.name)],
);

export const rooms = pgTable(
  'rooms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    buildingId: uuid('building_id')
      .notNull()
      .references(() => buildings.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    floor: text('floor'),
    gridCols: integer('grid_cols').notNull().default(20),
    gridRows: integer('grid_rows').notNull().default(12),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('rooms_building_name_uq').on(t.buildingId, t.name),
    check('rooms_grid_ck', sql`${t.gridCols} between 1 and 200 and ${t.gridRows} between 1 and 200`),
  ],
);

export const rackRows = pgTable(
  'rack_rows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('rack_rows_room_name_uq').on(t.roomId, t.name)],
);

export const racks = pgTable(
  'racks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'restrict' }),
    rowId: uuid('row_id').references(() => rackRows.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    uHeight: integer('u_height').notNull().default(42),
    depthMm: integer('depth_mm').notNull().default(1070),
    maxPowerW: integer('max_power_w'),
    maxWeightKg: integer('max_weight_kg'),
    numbering: rackNumberingEnum('numbering').notNull().default('bottom_up'),
    status: rackStatusEnum('status').notNull().default('active'),
    /** Dedicated to one customer (colocation); null = shared or company use. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    gridX: integer('grid_x'),
    gridY: integer('grid_y'),
    assetTag: text('asset_tag'),
    serial: text('serial'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('racks_room_name_uq').on(t.roomId, t.name),
    uniqueIndex('racks_room_grid_uq').on(t.roomId, t.gridX, t.gridY).where(sql`${t.gridX} is not null and ${t.gridY} is not null`),
    index('racks_org_idx').on(t.orgId),
    check('racks_u_height_ck', sql`${t.uHeight} between 1 and 60`),
    check('racks_grid_pair_ck', sql`(${t.gridX} is null) = (${t.gridY} is null)`),
  ],
);

export const rackReservations = pgTable(
  'rack_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    rackId: uuid('rack_id')
      .notNull()
      .references(() => racks.id, { onDelete: 'cascade' }),
    startU: integer('start_u').notNull(),
    endU: integer('end_u').notNull(),
    uRange: int4range('u_range').generatedAlwaysAs(sql`int4range(start_u, end_u + 1)`),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    reason: text('reason').notNull(),
    expiresAt: ts('expires_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [index('rack_reservations_rack_idx').on(t.rackId), check('rack_reservations_range_ck', sql`${t.startU} >= 1 and ${t.endU} >= ${t.startU}`)],
);

export const manufacturers = pgTable(
  'manufacturers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('manufacturers_org_name_uq').on(t.orgId, sql`lower(${t.name})`)],
);

export const deviceModels = pgTable(
  'device_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    manufacturerId: uuid('manufacturer_id')
      .notNull()
      .references(() => manufacturers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    category: deviceCategoryEnum('category').notNull(),
    uHeight: integer('u_height').notNull(),
    depthMm: integer('depth_mm'),
    /** Full-depth equipment blocks both rack faces at its units. */
    fullDepth: boolean('full_depth').notNull().default(true),
    /** Power specification (used as estimates in Phase 5; never treated as measurements). */
    typicalPowerW: integer('typical_power_w'),
    idlePowerW: integer('idle_power_w'),
    maxPowerW: integer('max_power_w'),
    psuCount: integer('psu_count'),
    psuRatedW: integer('psu_rated_w'),
    weightKg: numeric('weight_kg', { precision: 7, scale: 2 }),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('device_models_mfr_name_uq').on(t.manufacturerId, sql`lower(${t.name})`), check('device_models_u_ck', sql`${t.uHeight} between 0 and 60`)],
);

export interface DeviceNic {
  name: string;
  mac?: string | null;
  speed?: string | null;
}
export interface DeviceDisk {
  slot?: string | null;
  type: string;
  sizeGb: number;
  model?: string | null;
}

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    /** Customer the device is assigned to (their server or their colocated equipment). */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    ownership: ownershipEnum('ownership').notNull().default('company'),
    modelId: uuid('model_id')
      .notNull()
      .references(() => deviceModels.id, { onDelete: 'restrict' }),
    /** Copied from the model so placement constraints can be checked on this row alone. */
    category: deviceCategoryEnum('category').notNull(),
    uHeight: integer('u_height').notNull(),
    fullDepth: boolean('full_depth').notNull(),
    assetTag: text('asset_tag').notNull(),
    hostname: text('hostname'),
    serial: text('serial'),
    /** Network OS / platform (Phase 3), used to pick discovery adapters. */
    platform: platformEnum('platform'),
    /** Free-text network role, e.g. edge router, core switch, ToR. */
    networkRole: text('network_role'),
    lifecycleState: lifecycleStateEnum('lifecycle_state').notNull().default('planned'),
    rackId: uuid('rack_id').references(() => racks.id, { onDelete: 'restrict' }),
    positionU: integer('position_u'),
    face: rackFaceEnum('face'),
    uRange: int4range('u_range').generatedAlwaysAs(sql`case when position_u is null then null else int4range(position_u, position_u + u_height) end`),
    occupiesFront: boolean('occupies_front').generatedAlwaysAs(sql`position_u is not null and (full_depth or face = 'front')`),
    occupiesRear: boolean('occupies_rear').generatedAlwaysAs(sql`position_u is not null and (full_depth or face = 'rear')`),
    cpu: text('cpu'),
    cpuCount: integer('cpu_count'),
    ramGb: integer('ram_gb'),
    dimmLayout: text('dimm_layout'),
    disks: jsonb('disks').$type<DeviceDisk[]>().notNull().default(sql`'[]'::jsonb`),
    raid: text('raid'),
    nics: jsonb('nics').$type<DeviceNic[]>().notNull().default(sql`'[]'::jsonb`),
    mgmtType: mgmtTypeEnum('mgmt_type'),
    mgmtAddress: text('mgmt_address'),
    biosVersion: text('bios_version'),
    bmcFirmware: text('bmc_firmware'),
    os: text('os'),
    purchaseDate: date('purchase_date'),
    supplier: text('supplier'),
    purchaseCost: numeric('purchase_cost', { precision: 14, scale: 2 }),
    currency: text('currency'),
    warrantyExpires: date('warranty_expires'),
    eolDate: date('eol_date'),
    notes: text('notes'),
    custom: jsonb('custom').$type<Record<string, string | number | boolean | null>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('devices_org_asset_tag_uq').on(t.orgId, sql`lower(${t.assetTag})`),
    uniqueIndex('devices_org_serial_uq').on(t.orgId, sql`lower(${t.serial})`).where(sql`${t.serial} is not null and ${t.serial} <> ''`),
    index('devices_org_state_idx').on(t.orgId, t.lifecycleState),
    index('devices_rack_idx').on(t.rackId),
    index('devices_customer_idx').on(t.customerId),
    index('devices_warranty_idx').on(t.orgId, t.warrantyExpires),
    check('devices_position_ck', sql`(${t.positionU} is null and ${t.face} is null) or (${t.rackId} is not null and ${t.positionU} >= 1 and ${t.uHeight} >= 1 and (${t.face} is not null))`),
    check('devices_ownership_ck', sql`${t.ownership} = 'company' or ${t.customerId} is not null`),
  ],
);

export const lifecycleTransitions = pgTable(
  'lifecycle_transitions',
  {
    orgId: orgRef(),
    fromState: lifecycleStateEnum('from_state').notNull(),
    toState: lifecycleStateEnum('to_state').notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.fromState, t.toState] }), check('lifecycle_transitions_distinct_ck', sql`${t.fromState} <> ${t.toState}`)],
);

export const deviceEvents = pgTable(
  'device_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgRef(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index('device_events_device_idx').on(t.deviceId, t.occurredAt)],
);

export const rackEvents = pgTable(
  'rack_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgRef(),
    rackId: uuid('rack_id')
      .notNull()
      .references(() => racks.id, { onDelete: 'cascade' }),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index('rack_events_rack_idx').on(t.rackId, t.occurredAt)],
);

export const spareParts = pgTable(
  'spare_parts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    datacenterId: uuid('datacenter_id').references(() => datacenters.id, { onDelete: 'restrict' }),
    kind: sparePartKindEnum('kind').notNull(),
    manufacturer: text('manufacturer'),
    partNumber: text('part_number').notNull(),
    description: text('description').notNull(),
    quantity: integer('quantity').notNull().default(0),
    minQuantity: integer('min_quantity').notNull().default(0),
    location: text('location'),
    unitCost: numeric('unit_cost', { precision: 12, scale: 2 }),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('spare_parts_org_dc_pn_uq').on(t.orgId, sql`coalesce(${t.datacenterId}, '00000000-0000-0000-0000-000000000000'::uuid)`, sql`lower(${t.partNumber})`),
    check('spare_parts_qty_ck', sql`${t.quantity} >= 0 and ${t.minQuantity} >= 0`),
  ],
);

export const sparePartMovements = pgTable(
  'spare_part_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgRef(),
    partId: uuid('part_id')
      .notNull()
      .references(() => spareParts.id, { onDelete: 'cascade' }),
    delta: integer('delta').notNull(),
    quantityAfter: integer('quantity_after').notNull(),
    reason: text('reason').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
  },
  (t) => [index('spare_part_movements_part_idx').on(t.partId, t.occurredAt)],
);

export type Datacenter = typeof datacenters.$inferSelect;
export type Building = typeof buildings.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type RackRow = typeof rackRows.$inferSelect;
export type Rack = typeof racks.$inferSelect;
export type DeviceModel = typeof deviceModels.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type SparePart = typeof spareParts.$inferSelect;


/* ======================================================================
 * Phase 3: network infrastructure and IPAM
 *
 * Integrity rules live in the database (migration 0006_network_constraints):
 * one cable per port, cables only on physical/management ports of the same
 * organization, LAG members and sub-interfaces on the same device, one
 * untagged VLAN per port, unique prefixes and addresses per VRF, addresses
 * stored as host addresses only.
 * ==================================================================== */

export const interfaceKindEnum = pgEnum('interface_kind', ['physical', 'lag', 'vlan', 'bridge', 'tunnel', 'loopback', 'virtual', 'management']);
export const interfaceMediaEnum = pgEnum('interface_media', ['copper', 'sfp', 'sfp_plus', 'sfp28', 'qsfp_plus', 'qsfp28', 'qsfp_dd', 'other']);
export const vlanModeEnum = pgEnum('vlan_mode', ['access', 'tagged', 'tagged_all']);
export const cableTypeEnum = pgEnum('cable_type', ['cat5e', 'cat6', 'cat6a', 'dac', 'aoc', 'mmf', 'smf', 'other']);
export const cableStatusEnum = pgEnum('cable_status', ['planned', 'connected', 'decommissioning']);
export const cableEndEnum = pgEnum('cable_end', ['a', 'b']);
export const neighborProtocolEnum = pgEnum('neighbor_protocol', ['lldp', 'cdp', 'mndp']);
export const vlanStatusEnum = pgEnum('vlan_status', ['active', 'reserved', 'deprecated']);
export const circuitTypeEnum = pgEnum('circuit_type', ['internet_transit', 'ip_peering', 'transport', 'cross_connect', 'mpls', 'other']);
export const circuitStatusEnum = pgEnum('circuit_status', ['planned', 'provisioning', 'active', 'decommissioned']);
export const prefixStatusEnum = pgEnum('prefix_status', ['container', 'active', 'reserved', 'deprecated']);
export const ipStatusEnum = pgEnum('ip_status', ['reserved', 'allocated', 'deprecated', 'released']);
export const ipRoleEnum = pgEnum('ip_role', ['primary', 'secondary', 'gateway', 'vip', 'anycast', 'loopback', 'management']);
export const credentialKindEnum = pgEnum('credential_kind', ['snmp_v2c', 'snmp_v3', 'routeros_rest', 'fortios_rest', 'nxapi', 'routeros_api']);
export const discoveryTriggerEnum = pgEnum('discovery_trigger', ['manual', 'schedule']);
export const dnsServerKindEnum = pgEnum('dns_server_kind', ['powerdns', 'cloudflare']);
export const dnsZoneKindEnum = pgEnum('dns_zone_kind', ['forward', 'reverse']);
export const dnsSyncStatusEnum = pgEnum('dns_sync_status', ['none', 'pending', 'syncing', 'synced', 'failed']);
export const discoveryStatusEnum = pgEnum('discovery_status', ['queued', 'running', 'succeeded', 'failed']);
export const discoveryModeEnum = pgEnum('discovery_mode', ['test', 'discover']);

const inetCol = customType<{ data: string; driverData: string }>({ dataType: () => 'inet' });

export const vrfs = pgTable(
  'vrfs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    name: text('name').notNull(),
    rd: text('rd'),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('vrfs_org_name_uq').on(t.orgId, t.name), uniqueIndex('vrfs_org_rd_uq').on(t.orgId, t.rd).where(sql`${t.rd} is not null`)],
);

export const vlans = pgTable(
  'vlans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    /** Null = organization-wide VLAN; otherwise local to one datacenter. */
    datacenterId: uuid('datacenter_id').references(() => datacenters.id, { onDelete: 'restrict' }),
    vid: integer('vid').notNull(),
    name: text('name').notNull(),
    status: vlanStatusEnum('status').notNull().default('active'),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vlans_scope_vid_uq').on(t.orgId, sql`coalesce(${t.datacenterId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.vid),
    check('vlans_vid_ck', sql`${t.vid} between 1 and 4094`),
  ],
);

export const interfaces = pgTable(
  'interfaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: interfaceKindEnum('kind').notNull(),
    media: interfaceMediaEnum('media'),
    description: text('description'),
    macAddress: macaddr('mac_address'),
    mtu: integer('mtu'),
    /** Nominal or configured speed in bit/s; null = unknown (utilization is then not computed). */
    speedBps: bigint('speed_bps', { mode: 'number' }),
    enabled: boolean('enabled').notNull().default(true),
    lagId: uuid('lag_id').references((): AnyPgColumn => interfaces.id, { onDelete: 'set null' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => interfaces.id, { onDelete: 'set null' }),
    mode: vlanModeEnum('mode'),
    untaggedVlanId: uuid('untagged_vlan_id').references(() => vlans.id, { onDelete: 'restrict' }),
    /** SNMP ifIndex as last discovered; can change across reboots, so the stable key is (device, name). */
    ifIndex: integer('if_index'),
    monitored: boolean('monitored').notNull().default(true),
    /** Whether this port contributes to device and datacenter traffic totals (Phase 4). */
    countInTotals: boolean('count_in_totals').notNull().default(false),
    discoveredAt: ts('discovered_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('interfaces_device_name_uq').on(t.deviceId, sql`lower(${t.name})`),
    index('interfaces_org_idx').on(t.orgId),
    index('interfaces_lag_idx').on(t.lagId),
    check('interfaces_mtu_ck', sql`${t.mtu} is null or ${t.mtu} between 64 and 65535`),
    check('interfaces_speed_ck', sql`${t.speedBps} is null or ${t.speedBps} > 0`),
    check('interfaces_not_self_ck', sql`${t.lagId} is distinct from ${t.id} and ${t.parentId} is distinct from ${t.id}`),
  ],
);

export const interfaceTaggedVlans = pgTable(
  'interface_tagged_vlans',
  {
    interfaceId: uuid('interface_id')
      .notNull()
      .references(() => interfaces.id, { onDelete: 'cascade' }),
    vlanId: uuid('vlan_id')
      .notNull()
      .references(() => vlans.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.interfaceId, t.vlanId] }), index('interface_tagged_vlans_vlan_idx').on(t.vlanId)],
);

export const cables = pgTable('cables', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: orgRef(),
  type: cableTypeEnum('type'),
  status: cableStatusEnum('status').notNull().default('connected'),
  label: text('label'),
  color: text('color'),
  lengthM: numeric('length_m', { precision: 8, scale: 2 }),
  notes: text('notes'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cableEnds = pgTable(
  'cable_ends',
  {
    cableId: uuid('cable_id')
      .notNull()
      .references(() => cables.id, { onDelete: 'cascade' }),
    end: cableEndEnum('end').notNull(),
    /** RESTRICT: a port with a cable can't be deleted until the cable is removed. */
    interfaceId: uuid('interface_id')
      .notNull()
      .references(() => interfaces.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.cableId, t.end] }), uniqueIndex('cable_ends_interface_uq').on(t.interfaceId)],
);

export const neighborObservations = pgTable(
  'neighbor_observations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    interfaceId: uuid('interface_id')
      .notNull()
      .references(() => interfaces.id, { onDelete: 'cascade' }),
    protocol: neighborProtocolEnum('protocol').notNull(),
    remoteChassisId: text('remote_chassis_id').notNull().default(''),
    remoteSystemName: text('remote_system_name'),
    remotePortId: text('remote_port_id').notNull().default(''),
    remotePortDescription: text('remote_port_description'),
    remoteMgmtAddress: text('remote_mgmt_address'),
    remotePlatform: text('remote_platform'),
    /** Our interface on the far end, when the neighbor matches a device we know. */
    matchedInterfaceId: uuid('matched_interface_id').references(() => interfaces.id, { onDelete: 'set null' }),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('neighbor_obs_uq').on(t.interfaceId, t.protocol, t.remoteChassisId, t.remotePortId), index('neighbor_obs_matched_idx').on(t.matchedInterfaceId)],
);

export const providers = pgTable(
  'providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    name: text('name').notNull(),
    asn: bigint('asn', { mode: 'number' }),
    accountNumber: text('account_number'),
    portalUrl: text('portal_url'),
    nocEmail: text('noc_email'),
    nocPhone: text('noc_phone'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('providers_org_name_uq').on(t.orgId, sql`lower(${t.name})`)],
);

export const circuits = pgTable(
  'circuits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    cid: text('cid').notNull(),
    type: circuitTypeEnum('type').notNull(),
    status: circuitStatusEnum('status').notNull().default('active'),
    commitBps: bigint('commit_bps', { mode: 'number' }),
    portSpeedBps: bigint('port_speed_bps', { mode: 'number' }),
    installDate: date('install_date'),
    termEndDate: date('term_end_date'),
    datacenterId: uuid('datacenter_id').references(() => datacenters.id, { onDelete: 'restrict' }),
    /** Our port where the circuit terminates (A side). */
    interfaceId: uuid('interface_id').references(() => interfaces.id, { onDelete: 'set null' }),
    zSide: text('z_side'),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    description: text('description'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('circuits_provider_cid_uq').on(t.providerId, sql`lower(${t.cid})`),
    uniqueIndex('circuits_interface_uq').on(t.interfaceId).where(sql`${t.interfaceId} is not null and ${t.status} <> 'decommissioned'`),
  ],
);

export const circuitEvents = pgTable(
  'circuit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgRef(),
    circuitId: uuid('circuit_id')
      .notNull()
      .references(() => circuits.id, { onDelete: 'cascade' }),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
  },
  (t) => [index('circuit_events_circuit_idx').on(t.circuitId, t.occurredAt)],
);

export const prefixes = pgTable(
  'prefixes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    vrfId: uuid('vrf_id').references(() => vrfs.id, { onDelete: 'restrict' }),
    prefix: cidr('prefix').notNull(),
    status: prefixStatusEnum('status').notNull().default('active'),
    /** All addresses usable (no network/broadcast reservation), e.g. loopback or NAT pools. */
    isPool: boolean('is_pool').notNull().default(false),
    datacenterId: uuid('datacenter_id').references(() => datacenters.id, { onDelete: 'restrict' }),
    vlanId: uuid('vlan_id').references(() => vlans.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    gateway: inetCol('gateway'),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('prefixes_vrf_prefix_uq').on(t.orgId, sql`coalesce(${t.vrfId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.prefix),
    index('prefixes_org_idx').on(t.orgId),
    index('prefixes_customer_idx').on(t.customerId),
    check('prefixes_gateway_ck', sql`${t.gateway} is null or (${t.gateway} <<= ${t.prefix} and masklen(${t.gateway}) = case family(${t.gateway}) when 4 then 32 else 128 end)`),
  ],
);

export const ipAddresses = pgTable(
  'ip_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    vrfId: uuid('vrf_id').references(() => vrfs.id, { onDelete: 'restrict' }),
    /** Host address only (/32 or /128); the subnet length used on the interface is prefix_length. */
    address: inetCol('address').notNull(),
    prefixLength: integer('prefix_length'),
    status: ipStatusEnum('status').notNull(),
    role: ipRoleEnum('role'),
    dnsName: text('dns_name'),
    reverseDns: text('reverse_dns'),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    interfaceId: uuid('interface_id').references(() => interfaces.id, { onDelete: 'set null' }),
    /** Reference to a VPS or service in another system until Phases 6–7 model services. */
    serviceRef: text('service_ref'),
    reservedUntil: ts('reserved_until'),
    notes: text('notes'),
    /** DNS records this address should have in managed zones, and whether they were pushed. */
    dnsStatus: dnsSyncStatusEnum('dns_status').notNull().default('none'),
    dnsError: text('dns_error'),
    dnsSyncedAt: ts('dns_synced_at'),
    /** Records DCIM created for this address (so it only ever changes or deletes its own records). */
    dnsRecords: jsonb('dns_records').$type<ManagedDnsRecord[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ip_addresses_vrf_address_uq').on(t.orgId, sql`coalesce(${t.vrfId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.address),
    index('ip_addresses_customer_idx').on(t.customerId),
    index('ip_addresses_device_idx').on(t.deviceId),
    index('ip_addresses_interface_idx').on(t.interfaceId),
    check('ip_addresses_host_ck', sql`masklen(${t.address}) = case family(${t.address}) when 4 then 32 else 128 end`),
    check('ip_addresses_prefix_length_ck', sql`${t.prefixLength} is null or ${t.prefixLength} between 0 and case family(${t.address}) when 4 then 32 else 128 end`),
    check('ip_addresses_released_ck', sql`${t.status} <> 'released' or (${t.deviceId} is null and ${t.interfaceId} is null and ${t.customerId} is null)`),
  ],
);

export const ipEvents = pgTable(
  'ip_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: orgRef(),
    ipId: uuid('ip_id')
      .notNull()
      .references(() => ipAddresses.id, { onDelete: 'cascade' }),
    occurredAt: ts('occurred_at').notNull().defaultNow(),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    summary: text('summary').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index('ip_events_ip_idx').on(t.ipId, t.occurredAt)],
);

export interface CredentialParams {
  timeoutMs?: number;
  retries?: number;
  scheme?: 'https' | 'http';
  tls?: boolean;
  verifyTls?: boolean;
  vdom?: string | null;
  securityLevel?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
  authProtocol?: string;
  privProtocol?: string;
}

export const deviceCredentials = pgTable(
  'device_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    kind: credentialKindEnum('kind').notNull(),
    /** Optional override of the device management address. */
    host: text('host'),
    port: integer('port'),
    username: text('username'),
    /** SecretBox ciphertext of a JSON object (community / keys / password / token). Never returned by the API. */
    secretEnc: text('secret_enc').notNull(),
    params: jsonb('params').$type<CredentialParams>().notNull().default(sql`'{}'::jsonb`),
    lastTestAt: ts('last_test_at'),
    lastTestOk: boolean('last_test_ok'),
    lastTestMessage: text('last_test_message'),
    /** Automatic discovery interval in hours; null = only when started by hand. */
    scheduleHours: integer('schedule_hours'),
    nextRunAt: ts('next_run_at'),
    rotatedAt: ts('rotated_at').notNull().defaultNow(),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('device_credentials_device_kind_uq').on(t.deviceId, t.kind),
    index('device_credentials_next_run_idx').on(t.nextRunAt),
    check('device_credentials_schedule_ck', sql`${t.scheduleHours} is null or ${t.scheduleHours} between 1 and 720`),
  ],
);

export const discoveryRuns = pgTable(
  'discovery_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    credentialKind: credentialKindEnum('credential_kind').notNull(),
    mode: discoveryModeEnum('mode').notNull(),
    trigger: discoveryTriggerEnum('trigger').notNull().default('manual'),
    status: discoveryStatusEnum('status').notNull().default('queued'),
    requestedBy: uuid('requested_by'),
    requestedLabel: text('requested_label'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    error: text('error'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    /** Differences from inventory found by this run (counts), computed when it finishes. */
    changes: jsonb('changes').$type<DiscoveryChanges>(),
    appliedAt: ts('applied_at'),
    appliedBy: text('applied_by'),
    createdAt: createdAt(),
  },
  (t) => [
    index('discovery_runs_device_idx').on(t.deviceId, t.createdAt),
    uniqueIndex('discovery_runs_one_active_uq').on(t.deviceId).where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export type Interface = typeof interfaces.$inferSelect;
export type Vlan = typeof vlans.$inferSelect;
export type Vrf = typeof vrfs.$inferSelect;
export type Cable = typeof cables.$inferSelect;
export type Circuit = typeof circuits.$inferSelect;
export type Prefix = typeof prefixes.$inferSelect;
export type IpAddress = typeof ipAddresses.$inferSelect;
export interface ManagedDnsRecord {
  zoneId: string;
  name: string;
  type: 'A' | 'AAAA' | 'PTR';
  content: string;
  /** Provider record id (Cloudflare); PowerDNS addresses records by name and type. */
  providerId?: string | null;
}

export interface DiscoveryChanges {
  create: number;
  update: number;
  missing: number;
  neighborMismatch: number;
  unmatchedNeighbors: number;
  addressesNotInIpam: number;
  total: number;
}

export const dnsServers = pgTable(
  'dns_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    name: text('name').notNull(),
    kind: dnsServerKindEnum('kind').notNull(),
    /** PowerDNS API base URL (e.g. https://ns1.example.net:8081); Cloudflare uses its fixed API. */
    url: text('url'),
    /** PowerDNS server id (normally "localhost"). */
    serverId: text('server_id'),
    verifyTls: boolean('verify_tls').notNull().default(true),
    /** SecretBox ciphertext of the API key or token, bound to org, server id and URL. Never returned. */
    secretEnc: text('secret_enc').notNull(),
    lastTestAt: ts('last_test_at'),
    lastTestOk: boolean('last_test_ok'),
    lastTestMessage: text('last_test_message'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('dns_servers_org_name_uq').on(t.orgId, sql`lower(${t.name})`)],
);

export const dnsZones = pgTable(
  'dns_zones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => dnsServers.id, { onDelete: 'restrict' }),
    /** Zone name without the trailing dot, lower case (e.g. example.net, 113.0.203.in-addr.arpa). */
    name: text('name').notNull(),
    kind: dnsZoneKindEnum('kind').notNull(),
    /** Cloudflare zone id. */
    providerZoneId: text('provider_zone_id'),
    ttl: integer('ttl').notNull().default(3600),
    /** Only enabled zones receive changes. */
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('dns_zones_org_name_uq').on(t.orgId, t.name), check('dns_zones_ttl_ck', sql`${t.ttl} between 60 and 604800`)],
);

export type DnsServer = typeof dnsServers.$inferSelect;
export type DnsZone = typeof dnsZones.$inferSelect;
export type DeviceCredential = typeof deviceCredentials.$inferSelect;
export type DiscoveryRun = typeof discoveryRuns.$inferSelect;
