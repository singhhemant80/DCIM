import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  cidr,
  customType,
  date,
  doublePrecision,
  index,
  real,
  smallint,
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
    /** Set when the reservation holds the space of a colocation allocation (managed there). */
    allocationId: uuid('allocation_id').references((): AnyPgColumn => coloAllocations.id, { onDelete: 'cascade' }),
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
export const credentialKindEnum = pgEnum('credential_kind', ['snmp_v2c', 'snmp_v3', 'routeros_rest', 'fortios_rest', 'nxapi', 'routeros_api', 'redfish', 'ipmi']);
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
  ipmiPrivilege?: 'USER' | 'OPERATOR' | 'ADMINISTRATOR';
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

/* ============================================================== Phase 4: monitoring */

export const alertSeverityEnum = pgEnum('alert_severity', ['info', 'warning', 'critical']);
export const alertStatusEnum = pgEnum('alert_status', ['firing', 'resolved']);
export const channelKindEnum = pgEnum('channel_kind', ['email', 'webhook', 'slack', 'telegram']);
export const notificationStatusEnum = pgEnum('notification_status', ['pending', 'sent', 'failed']);

/** Polling configuration and health per device. */
export const deviceMonitoring = pgTable(
  'device_monitoring',
  {
    deviceId: uuid('device_id')
      .primaryKey()
      .references(() => devices.id, { onDelete: 'cascade' }),
    orgId: orgRef(),
    enabled: boolean('enabled').notNull().default(true),
    credentialKind: credentialKindEnum('credential_kind').notNull(),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    nextPollAt: ts('next_poll_at'),
    lastPollAt: ts('last_poll_at'),
    lastOkAt: ts('last_ok_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastDurationMs: integer('last_duration_ms'),
    /** Ports matched / reported at the last successful poll. */
    lastMatched: integer('last_matched'),
    lastReported: integer('last_reported'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('device_monitoring_due_idx').on(t.nextPollAt), check('device_monitoring_interval_ck', sql`${t.intervalSeconds} between 30 and 3600`)],
);

/** Last raw counter reading per interface: the baseline for the next rate. */
export const interfaceCounters = pgTable('interface_counters', {
  interfaceId: uuid('interface_id')
    .primaryKey()
    .references(() => interfaces.id, { onDelete: 'cascade' }),
  orgId: orgRef(),
  sampledAt: ts('sampled_at').notNull(),
  uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
  inOctets: numeric('in_octets', { precision: 20, scale: 0 }),
  outOctets: numeric('out_octets', { precision: 20, scale: 0 }),
  inPkts: numeric('in_pkts', { precision: 20, scale: 0 }),
  outPkts: numeric('out_pkts', { precision: 20, scale: 0 }),
  inErrors: numeric('in_errors', { precision: 20, scale: 0 }),
  outErrors: numeric('out_errors', { precision: 20, scale: 0 }),
  inDiscards: numeric('in_discards', { precision: 20, scale: 0 }),
  outDiscards: numeric('out_discards', { precision: 20, scale: 0 }),
  counterBits: smallint('counter_bits').notNull().default(64),
  errorBits: smallint('error_bits').notNull().default(32),
  speedBps: bigint('speed_bps', { mode: 'number' }),
  operUp: boolean('oper_up'),
  /** Latest computed rate, for fast "now" views. Null when the last poll gave none (first sample, reset, gap). */
  lastRateAt: ts('last_rate_at'),
  inBps: doublePrecision('in_bps'),
  outBps: doublePrecision('out_bps'),
  utilIn: real('util_in'),
  utilOut: real('util_out'),
  errorsPs: doublePrecision('errors_ps'),
  discardsPs: doublePrecision('discards_ps'),
  /** Why the last poll produced no rate (first, reset, gap, implausible…). */
  lastSkip: text('last_skip'),
});

const rateCols = () => ({
  orgId: orgRef(),
  deviceId: uuid('device_id').notNull(),
  inBps: doublePrecision('in_bps').notNull(),
  outBps: doublePrecision('out_bps').notNull(),
});

/** One row per interface per successful poll (raw resolution, short retention). */
export const interfaceRates = pgTable(
  'interface_rates',
  {
    interfaceId: uuid('interface_id')
      .notNull()
      .references(() => interfaces.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    /** Seconds this rate covers (time since the previous reading); weights the rollup averages. */
    seconds: real('seconds').notNull(),
    ...rateCols(),
    inPps: doublePrecision('in_pps'),
    outPps: doublePrecision('out_pps'),
    errorsPs: doublePrecision('errors_ps'),
    discardsPs: doublePrecision('discards_ps'),
    utilIn: real('util_in'),
    utilOut: real('util_out'),
    speedBps: bigint('speed_bps', { mode: 'number' }),
    flags: text('flags').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [primaryKey({ columns: [t.interfaceId, t.at] }), index('interface_rates_at_idx').on(t.at)],
);

const rollup = (name: string) =>
  pgTable(
    name,
    {
      interfaceId: uuid('interface_id')
        .notNull()
        .references(() => interfaces.id, { onDelete: 'cascade' }),
      bucket: ts('bucket').notNull(),
      ...rateCols(),
      inMax: doublePrecision('in_max').notNull(),
      outMax: doublePrecision('out_max').notNull(),
      utilInMax: real('util_in_max'),
      utilOutMax: real('util_out_max'),
      errorsPs: doublePrecision('errors_ps'),
      discardsPs: doublePrecision('discards_ps'),
      samples: integer('samples').notNull(),
      /** Seconds covered by samples (lets readers tell a partial bucket from a full one). */
      coveredSeconds: integer('covered_seconds').notNull(),
    },
    (t) => [primaryKey({ columns: [t.interfaceId, t.bucket] }), index(`${name}_bucket_idx`).on(t.bucket)],
  );
/** 5-minute averages and maxima (time-weighted), medium retention; used for 95th percentile. */
export const interfaceRates5m = rollup('interface_rates_5m');
/** Hourly averages and maxima, long retention. */
export const interfaceRates1h = rollup('interface_rates_1h');

export const monitoringSettings = pgTable('monitoring_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  rawDays: integer('raw_days').notNull().default(7),
  fiveMinuteDays: integer('five_minute_days').notNull().default(90),
  hourlyDays: integer('hourly_days').notNull().default(730),
  updatedAt: updatedAt(),
});

export interface AlertScopeFields {
  datacenterId?: string | null;
  deviceIds?: string[];
  interfaceIds?: string[];
}

export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: orgRef(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  metric: text('metric').notNull(),
  comparator: text('comparator').notNull().default('gt'),
  threshold: doublePrecision('threshold').notNull().default(0),
  forSeconds: integer('for_seconds').notNull().default(300),
  minSamples: integer('min_samples').notNull().default(3),
  clearSamples: integer('clear_samples').notNull().default(2),
  severity: alertSeverityEnum('severity').notNull().default('warning'),
  scope: text('scope').notNull().default('all'),
  datacenterId: uuid('datacenter_id').references(() => datacenters.id, { onDelete: 'cascade' }),
  deviceIds: uuid('device_ids').array().notNull().default(sql`'{}'::uuid[]`),
  interfaceIds: uuid('interface_ids').array().notNull().default(sql`'{}'::uuid[]`),
  channelIds: uuid('channel_ids').array().notNull().default(sql`'{}'::uuid[]`),
  notifyOnResolve: boolean('notify_on_resolve').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Per (rule, target) evaluation state between polls. */
export const alertState = pgTable(
  'alert_state',
  {
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => alertRules.id, { onDelete: 'cascade' }),
    /** "i:<interface id>" or "d:<device id>". */
    targetKey: text('target_key').notNull(),
    orgId: orgRef(),
    breachSince: ts('breach_since'),
    breachCount: integer('breach_count').notNull().default(0),
    clearCount: integer('clear_count').notNull().default(0),
    lastValue: doublePrecision('last_value'),
    lastEvaluatedAt: ts('last_evaluated_at'),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.targetKey] })],
);

export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    ruleId: uuid('rule_id').references(() => alertRules.id, { onDelete: 'set null' }),
    ruleName: text('rule_name').notNull(),
    metric: text('metric').notNull(),
    targetKey: text('target_key').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'cascade' }),
    interfaceId: uuid('interface_id').references(() => interfaces.id, { onDelete: 'cascade' }),
    severity: alertSeverityEnum('severity').notNull(),
    status: alertStatusEnum('status').notNull().default('firing'),
    message: text('message').notNull(),
    startedAt: ts('started_at').notNull(),
    resolvedAt: ts('resolved_at'),
    lastValue: doublePrecision('last_value'),
    peakValue: doublePrecision('peak_value'),
    /** Raised inside a maintenance window: shown, but no notifications were sent. */
    suppressed: boolean('suppressed').notNull().default(false),
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by'),
    ackNote: text('ack_note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('alerts_one_firing_uq').on(t.ruleId, t.targetKey).where(sql`${t.status} = 'firing'`),
    index('alerts_org_status_idx').on(t.orgId, t.status, t.startedAt),
  ],
);

export const maintenanceWindows = pgTable(
  'maintenance_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    name: text('name').notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    scope: text('scope').notNull().default('devices'),
    datacenterId: uuid('datacenter_id').references(() => datacenters.id, { onDelete: 'cascade' }),
    deviceIds: uuid('device_ids').array().notNull().default(sql`'{}'::uuid[]`),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('maintenance_windows_org_time_idx').on(t.orgId, t.endsAt), check('maintenance_windows_time_ck', sql`${t.endsAt} > ${t.startsAt}`)],
);

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    name: text('name').notNull(),
    kind: channelKindEnum('kind').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Non-secret settings (recipients, SMTP host…). */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** SecretBox ciphertext of the secret fields; never returned. */
    secretEnc: text('secret_enc').notNull(),
    lastSentAt: ts('last_sent_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('notification_channels_org_name_uq').on(t.orgId, sql`lower(${t.name})`)],
);

/** Outbox of notifications, delivered by the worker with retries. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    alertId: uuid('alert_id').references(() => alerts.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    status: notificationStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_due_idx').on(t.status, t.nextAttemptAt)],
);

export type DeviceMonitoring = typeof deviceMonitoring.$inferSelect;
export type InterfaceCounter = typeof interfaceCounters.$inferSelect;
export type AlertRule = typeof alertRules.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type MaintenanceWindow = typeof maintenanceWindows.$inferSelect;
export type NotificationChannel = typeof notificationChannels.$inferSelect;

/* ============================================================== Phase 5: power */

export const powerSourceEnum = pgEnum('power_source', ['pdu_outlet', 'redfish', 'ipmi', 'nxos', 'routeros', 'snmp']);

/** Power collection configuration and health per device (a server's BMC, a switch, a PDU). */
export const powerMonitoring = pgTable(
  'power_monitoring',
  {
    deviceId: uuid('device_id')
      .primaryKey()
      .references(() => devices.id, { onDelete: 'cascade' }),
    orgId: orgRef(),
    enabled: boolean('enabled').notNull().default(true),
    credentialKind: credentialKindEnum('credential_kind').notNull(),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    nextPollAt: ts('next_poll_at'),
    lastPollAt: ts('last_poll_at'),
    lastOkAt: ts('last_ok_at'),
    lastError: text('last_error'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastDurationMs: integer('last_duration_ms'),
    lastWatts: real('last_watts'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('power_monitoring_due_idx').on(t.nextPollAt), check('power_monitoring_interval_ck', sql`${t.intervalSeconds} between 30 and 3600`)],
);

/** Admin power estimate and inclusion per device. */
export const powerProfiles = pgTable('power_profiles', {
  deviceId: uuid('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  orgId: orgRef(),
  estimateW: integer('estimate_w'),
  includeInTotals: boolean('include_in_totals').notNull().default(true),
  notes: text('notes'),
  updatedAt: updatedAt(),
});

/** Outlets of a metered PDU as last reported, and which device each one feeds. */
export const pduOutlets = pgTable(
  'pdu_outlets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    pduDeviceId: uuid('pdu_device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    outletNumber: integer('outlet_number').notNull(),
    /** Name reported by the PDU. */
    name: text('name'),
    /** Admin label. */
    label: text('label'),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    lastWatts: real('last_watts'),
    lastAt: ts('last_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('pdu_outlets_pdu_number_uq').on(t.pduDeviceId, t.outletNumber), index('pdu_outlets_device_idx').on(t.deviceId), check('pdu_outlets_not_self_ck', sql`${t.deviceId} is distinct from ${t.pduDeviceId}`)],
);

/** Measured readings (raw). One row per device, source and instant. */
export const powerReadings = pgTable(
  'power_readings',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    source: powerSourceEnum('source').notNull(),
    at: ts('at').notNull(),
    orgId: orgRef(),
    watts: real('watts').notNull(),
    /** Polling interval in force; readings further apart than 3× this are not joined. */
    periodSeconds: integer('period_seconds').notNull(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.source, t.at] }), index('power_readings_at_idx').on(t.at)],
);

/**
 * Hourly energy per device: measured part (one source), estimated part and
 * unknown time, kept apart. Device attributes are copied in so later moves
 * don't rewrite history.
 */
export const powerHourly = pgTable(
  'power_hourly',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    hour: ts('hour').notNull(),
    orgId: orgRef(),
    datacenterId: uuid('datacenter_id'),
    rackId: uuid('rack_id'),
    customerId: uuid('customer_id'),
    category: text('category').notNull(),
    /** Counted in equipment totals (powered, included, not a PDU/UPS). */
    counted: boolean('counted').notNull(),
    source: powerSourceEnum('source'),
    measuredWh: doublePrecision('measured_wh').notNull().default(0),
    measuredSeconds: integer('measured_seconds').notNull().default(0),
    estimatedWh: doublePrecision('estimated_wh').notNull().default(0),
    estimatedSeconds: integer('estimated_seconds').notNull().default(0),
    estimateKind: text('estimate_kind'),
    /** The estimate in force when the hour was first computed (kept when the hour is recomputed later). */
    estimateW: real('estimate_w'),
    unknownSeconds: integer('unknown_seconds').notNull().default(0),
    avgMeasuredW: real('avg_measured_w'),
    maxMeasuredW: real('max_measured_w'),
    samples: integer('samples').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.hour] }), index('power_hourly_org_hour_idx').on(t.orgId, t.hour)],
);

export const powerTariffs = pgTable(
  'power_tariffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    datacenterId: uuid('datacenter_id').references(() => datacenters.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    pricePerKwh: numeric('price_per_kwh', { precision: 14, scale: 6 }).notNull(),
    validFrom: ts('valid_from').notNull(),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('power_tariffs_org_idx').on(t.orgId, t.validFrom), check('power_tariffs_price_ck', sql`${t.pricePerKwh} > 0`), check('power_tariffs_currency_ck', sql`${t.currency} ~ '^[A-Z]{3}$'`)],
);

/** How far the hourly energy rollup has got (one row). */
export const powerRollupState = pgTable('power_rollup_state', {
  id: integer('id').primaryKey().default(1),
  rolledTo: ts('rolled_to').notNull(),
});

export const powerSettings = pgTable('power_settings', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  rawDays: integer('raw_days').notNull().default(35),
  hourlyDays: integer('hourly_days').notNull().default(1095),
  updatedAt: updatedAt(),
});

export type PowerMonitoring = typeof powerMonitoring.$inferSelect;
export type PduOutlet = typeof pduOutlets.$inferSelect;
export type PowerTariff = typeof powerTariffs.$inferSelect;

/* ============================================================== Phase 6: provisioning and virtualization */

export const jobKindEnum = pgEnum('job_kind', ['power_action', 'os_install', 'image_verify', 'guest_action']);
export const jobStatusEnum = pgEnum('job_status', ['queued', 'running', 'waiting', 'verifying', 'completed', 'failed', 'cancelled', 'recovery']);
export const stepStatusEnum = pgEnum('job_step_status', ['pending', 'running', 'done', 'failed', 'skipped']);
export const bmcKindEnum = pgEnum('bmc_kind', ['redfish', 'ipmi']);
export const imageVerifyEnum = pgEnum('image_verify_status', ['unverified', 'verifying', 'verified', 'mismatch', 'error']);
export const virtKindEnum = pgEnum('virt_kind', ['proxmox', 'virtualizor']);

/**
 * BMC access with a privilege that can change power and boot settings.
 * Kept apart from the read-only `device_credentials` used for monitoring.
 */
export const controlCredentials = pgTable('control_credentials', {
  deviceId: uuid('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  orgId: orgRef(),
  kind: bmcKindEnum('kind').notNull(),
  host: text('host').notNull(),
  port: integer('port'),
  username: text('username').notNull(),
  params: jsonb('params').$type<CredentialParams>().notNull().default(sql`'{}'::jsonb`),
  /** SecretBox ciphertext, AAD (org, device, "control", kind, host, port). */
  secretEnc: text('secret_enc').notNull(),
  rotatedAt: ts('rotated_at').notNull().defaultNow(),
  lastTestAt: ts('last_test_at'),
  lastTestOk: boolean('last_test_ok'),
  lastTestMessage: text('last_test_message'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const osImages = pgTable(
  'os_images',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    name: text('name').notNull(),
    family: text('family').notNull(),
    version: text('version'),
    arch: text('arch').notNull().default('x86_64'),
    isoUrl: text('iso_url'),
    isoSha256: text('iso_sha256'),
    kernelUrl: text('kernel_url'),
    kernelSha256: text('kernel_sha256'),
    initrdUrl: text('initrd_url'),
    initrdSha256: text('initrd_sha256'),
    bootArgs: text('boot_args'),
    templateKind: text('template_kind').notNull().default('none'),
    template: text('template'),
    enabled: boolean('enabled').notNull().default(true),
    notes: text('notes'),
    verifyStatus: imageVerifyEnum('verify_status').notNull().default('unverified'),
    verifiedAt: ts('verified_at'),
    verifyError: text('verify_error'),
    /** Sizes found by the last verification, per file. */
    sizes: jsonb('sizes').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('os_images_org_name_uq').on(t.orgId, sql`lower(${t.name})`)],
);

/**
 * Provisioning jobs. A job runs as numbered steps; each step is recorded so an
 * interrupted job resumes (or stops for a decision) at the right place.
 */
export const provisioningJobs = pgTable(
  'provisioning_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    kind: jobKindEnum('kind').notNull(),
    status: jobStatusEnum('status').notNull().default('queued'),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    guestId: uuid('guest_id'),
    imageId: uuid('image_id').references(() => osImages.id, { onDelete: 'set null' }),
    /** What was asked (no secrets). */
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Working data written by the steps (what was done, for idempotent re-runs and cleanup). */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Written only by the boot endpoints (script fetched, config fetched, installer callback); read by the steps. */
    signals: jsonb('signals').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** SecretBox ciphertext of job secrets (e.g. the root password), AAD bound to the job. */
    secretEnc: text('secret_enc'),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash'),
    /** sha256 of the boot token handed to the installer (PXE script, config, callback). */
    bootTokenHash: text('boot_token_hash'),
    bootMac: text('boot_mac'),
    currentStep: integer('current_step').notNull().default(0),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    nextRunAt: ts('next_run_at').notNull().defaultNow(),
    leaseUntil: ts('lease_until'),
    workerId: text('worker_id'),
    deadlineAt: ts('deadline_at'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    createdBy: text('created_by'),
    createdByUserId: uuid('created_by_user_id'),
    customerRequest: boolean('customer_request').notNull().default(false),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('provisioning_jobs_idem_uq').on(t.orgId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
    // One active job per device and per VM: no two operations fight over the same machine.
    uniqueIndex('provisioning_jobs_device_active_uq').on(t.deviceId).where(sql`${t.deviceId} is not null and ${t.status} in ('queued','running','waiting','verifying','recovery')`),
    uniqueIndex('provisioning_jobs_guest_active_uq').on(t.guestId).where(sql`${t.guestId} is not null and ${t.status} in ('queued','running','waiting','verifying','recovery')`),
    uniqueIndex('provisioning_jobs_boot_token_uq').on(t.bootTokenHash).where(sql`${t.bootTokenHash} is not null`),
    // Boot endpoints look jobs up by MAC across organizations: one active install per MAC (cleared when a job ends).
    uniqueIndex('provisioning_jobs_mac_active_uq').on(t.bootMac).where(sql`${t.bootMac} is not null`),
    uniqueIndex('provisioning_jobs_image_verify_active_uq').on(t.imageId).where(sql`${t.kind} = 'image_verify' and ${t.status} in ('queued','running','waiting','verifying','recovery')`),
    index('provisioning_jobs_due_idx').on(t.status, t.nextRunAt),
    index('provisioning_jobs_org_idx').on(t.orgId, t.createdAt),
  ],
);

export const provisioningSteps = pgTable(
  'provisioning_steps',
  {
    jobId: uuid('job_id')
      .notNull()
      .references(() => provisioningJobs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    status: stepStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    detail: text('detail'),
    error: text('error'),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.seq] })],
);

export const provisioningEvents = pgTable(
  'provisioning_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => provisioningJobs.id, { onDelete: 'cascade' }),
    at: ts('at').notNull().defaultNow(),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
  },
  (t) => [index('provisioning_events_job_idx').on(t.jobId, t.id)],
);

export const virtIntegrations = pgTable(
  'virt_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    kind: virtKindEnum('kind').notNull(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    verifyTls: boolean('verify_tls').notNull().default(true),
    /** Non-secret settings (token ids). */
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    secretEnc: text('secret_enc').notNull(),
    actionsEnabled: boolean('actions_enabled').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    syncMinutes: integer('sync_minutes').notNull().default(5),
    nextSyncAt: ts('next_sync_at').notNull().defaultNow(),
    lastSyncAt: ts('last_sync_at'),
    lastSyncOk: boolean('last_sync_ok'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('virt_integrations_org_name_uq').on(t.orgId, sql`lower(${t.name})`)],
);

export const virtHosts = pgTable(
  'virt_hosts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => virtIntegrations.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    status: text('status'),
    cpuPct: real('cpu_pct'),
    cpus: integer('cpus'),
    memUsed: bigint('mem_used', { mode: 'number' }),
    memTotal: bigint('mem_total', { mode: 'number' }),
    uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
    /** The DCIM device this host runs on (staff mapping; also matched by hostname on first sync). */
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    lastSeenAt: ts('last_seen_at'),
    missingSince: ts('missing_since'),
  },
  (t) => [uniqueIndex('virt_hosts_ext_uq').on(t.integrationId, t.externalId)],
);

export const virtGuests = pgTable(
  'virt_guests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => virtIntegrations.id, { onDelete: 'cascade' }),
    hostId: uuid('host_id').references(() => virtHosts.id, { onDelete: 'set null' }),
    externalId: text('external_id').notNull(),
    /** Proxmox: qemu or lxc. Virtualizor: kvm, xen, openvz… */
    virtType: text('virt_type'),
    name: text('name').notNull(),
    status: text('status'),
    cpus: integer('cpus'),
    memBytes: bigint('mem_bytes', { mode: 'number' }),
    diskBytes: bigint('disk_bytes', { mode: 'number' }),
    uptimeSeconds: bigint('uptime_seconds', { mode: 'number' }),
    ipAddresses: text('ip_addresses').array().notNull().default(sql`'{}'::text[]`),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    lastSeenAt: ts('last_seen_at'),
    missingSince: ts('missing_since'),
  },
  (t) => [uniqueIndex('virt_guests_ext_uq').on(t.integrationId, t.externalId), index('virt_guests_customer_idx').on(t.customerId)],
);

export type ProvisioningJob = typeof provisioningJobs.$inferSelect;
export type OsImage = typeof osImages.$inferSelect;
export type ControlCredential = typeof controlCredentials.$inferSelect;
export type VirtIntegration = typeof virtIntegrations.$inferSelect;
export type VirtGuest = typeof virtGuests.$inferSelect;

/* ============================================================== Phase 7: colocation, services, tickets */

export const serviceKindEnum = pgEnum('service_kind', ['colocation', 'dedicated_server', 'vps', 'ip_transit', 'cross_connect', 'remote_hands', 'other']);
export const serviceStatusEnum = pgEnum('service_status', ['pending', 'active', 'suspended', 'cancelled', 'terminated']);
export const allocationKindEnum = pgEnum('allocation_kind', ['full', 'half', 'quarter', 'custom']);
export const crossConnectStatusEnum = pgEnum('cross_connect_status', ['requested', 'approved', 'rejected', 'in_progress', 'active', 'decommissioned']);
export const shipmentStatusEnum = pgEnum('shipment_status', ['expected', 'received', 'delivered', 'shipped_out', 'cancelled']);
export const visitStatusEnum = pgEnum('visit_status', ['requested', 'approved', 'denied', 'checked_in', 'checked_out', 'cancelled']);
export const ticketKindEnum = pgEnum('ticket_kind', ['support', 'remote_hands', 'cross_connect', 'shipment', 'access', 'billing', 'other']);
export const ticketPriorityEnum = pgEnum('ticket_priority', ['low', 'normal', 'high', 'urgent']);
export const ticketStatusEnum = pgEnum('ticket_status', ['open', 'in_progress', 'waiting_customer', 'resolved', 'closed']);

/** A customer's service (an order line): what they have, its lifecycle and its billing reference. */
export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    kind: serviceKindEnum('kind').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: serviceStatusEnum('status').notNull().default('pending'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    billingReference: text('billing_reference'),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    guestId: uuid('guest_id').references(() => virtGuests.id, { onDelete: 'set null' }),
    /** Staff only. */
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('services_customer_idx').on(t.customerId), index('services_org_idx').on(t.orgId, t.status)],
);

export const serviceEvents = pgTable(
  'service_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    at: createdAt(),
    actorLabel: text('actor_label'),
    fromStatus: serviceStatusEnum('from_status'),
    toStatus: serviceStatusEnum('to_status'),
    summary: text('summary').notNull(),
  },
  (t) => [index('service_events_service_idx').on(t.serviceId, t.at)],
);

/** Rack space contracted to a customer. Its units are held by a linked rack reservation while active. */
export const coloAllocations = pgTable(
  'colo_allocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    rackId: uuid('rack_id')
      .notNull()
      .references(() => racks.id, { onDelete: 'restrict' }),
    kind: allocationKindEnum('kind').notNull(),
    part: smallint('part'),
    startU: integer('start_u').notNull(),
    endU: integer('end_u').notNull(),
    contractedPowerW: integer('contracted_power_w').notNull(),
    feeds: text('feeds').notNull().default('single'),
    breakerAmps: integer('breaker_amps'),
    voltage: integer('voltage'),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    endedAt: ts('ended_at'),
    endReason: text('end_reason'),
    notes: text('notes'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('colo_allocations_customer_idx').on(t.customerId),
    index('colo_allocations_rack_idx').on(t.rackId),
    check('colo_allocations_range_ck', sql`${t.startU} >= 1 and ${t.endU} >= ${t.startU}`),
  ],
);

export const crossConnects = pgTable(
  'cross_connects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    serviceId: uuid('service_id').references(() => services.id, { onDelete: 'set null' }),
    aDeviceId: uuid('a_device_id').references(() => devices.id, { onDelete: 'set null' }),
    aInterfaceId: uuid('a_interface_id').references(() => interfaces.id, { onDelete: 'set null' }),
    aLabel: text('a_label').notNull(),
    zLabel: text('z_label').notNull(),
    loaReference: text('loa_reference'),
    media: text('media').notNull(),
    speed: text('speed'),
    status: crossConnectStatusEnum('status').notNull().default('requested'),
    circuitId: text('circuit_id'),
    cableId: uuid('cable_id').references(() => cables.id, { onDelete: 'set null' }),
    statusReason: text('status_reason'),
    notes: text('notes'),
    requestedBy: text('requested_by'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
    decommissionedAt: ts('decommissioned_at'),
    updatedAt: updatedAt(),
  },
  (t) => [index('cross_connects_customer_idx').on(t.customerId), index('cross_connects_org_idx').on(t.orgId, t.status)],
);

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    datacenterId: uuid('datacenter_id')
      .notNull()
      .references(() => datacenters.id, { onDelete: 'restrict' }),
    direction: text('direction').notNull().default('inbound'),
    carrier: text('carrier').notNull(),
    trackingNumber: text('tracking_number'),
    expectedOn: date('expected_on'),
    packages: integer('packages').notNull().default(1),
    description: text('description').notNull(),
    instructions: text('instructions'),
    status: shipmentStatusEnum('status').notNull().default('expected'),
    packagesReceived: integer('packages_received'),
    storageLocation: text('storage_location'),
    conditionNote: text('condition_note'),
    receivedAt: ts('received_at'),
    receivedBy: text('received_by'),
    closedAt: ts('closed_at'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('shipments_customer_idx').on(t.customerId), index('shipments_org_idx').on(t.orgId, t.status)],
);

export const visits = pgTable(
  'visits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    datacenterId: uuid('datacenter_id')
      .notNull()
      .references(() => datacenters.id, { onDelete: 'restrict' }),
    /** [{ name, company, idLast4 }] — no full ID numbers are stored. */
    visitors: jsonb('visitors').$type<{ name: string; company?: string | null; idLast4?: string | null }[]>().notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    purpose: text('purpose').notNull(),
    status: visitStatusEnum('status').notNull().default('requested'),
    escort: boolean('escort').notNull().default(false),
    badge: text('badge'),
    decisionNote: text('decision_note'),
    decidedBy: text('decided_by'),
    checkedInAt: ts('checked_in_at'),
    checkedOutAt: ts('checked_out_at'),
    requestedBy: text('requested_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('visits_customer_idx').on(t.customerId), index('visits_org_idx').on(t.orgId, t.startsAt), check('visits_time_ck', sql`${t.endsAt} > ${t.startsAt}`)],
);

export const ticketCounters = pgTable('ticket_counters', {
  orgId: uuid('org_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  next: integer('next').notNull().default(1),
});

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: orgRef(),
    number: integer('number').notNull(),
    /** Null for internal tickets (staff only). */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'restrict' }),
    kind: ticketKindEnum('kind').notNull(),
    priority: ticketPriorityEnum('priority').notNull().default('normal'),
    status: ticketStatusEnum('status').notNull().default('open'),
    subject: text('subject').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorizedMinutes: integer('authorized_minutes'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdBy: text('created_by').notNull(),
    /** Who acts next, for queues: staff or customer. */
    lastPublicReplyBy: text('last_public_reply_by'),
    firstResponseAt: ts('first_response_at'),
    resolvedAt: ts('resolved_at'),
    closedAt: ts('closed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tickets_org_number_uq').on(t.orgId, t.number), index('tickets_customer_idx').on(t.customerId, t.status), index('tickets_org_status_idx').on(t.orgId, t.status)],
);

export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    at: createdAt(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Display name at the time; null for system lines (status changes). */
    authorLabel: text('author_label'),
    authorType: text('author_type').notNull(),
    /** Staff-only note: never returned to customers. */
    internal: boolean('internal').notNull().default(false),
    body: text('body').notNull(),
  },
  (t) => [index('ticket_messages_ticket_idx').on(t.ticketId, t.id)],
);

export const ticketTimeEntries = pgTable(
  'ticket_time_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    at: createdAt(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    userLabel: text('user_label').notNull(),
    minutes: integer('minutes').notNull(),
    note: text('note').notNull(),
    billable: boolean('billable').notNull().default(true),
  },
  (t) => [index('ticket_time_ticket_idx').on(t.ticketId), check('ticket_time_minutes_ck', sql`${t.minutes} > 0`)],
);

export type Service = typeof services.$inferSelect;
export type ColoAllocation = typeof coloAllocations.$inferSelect;
export type CrossConnect = typeof crossConnects.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type Visit = typeof visits.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
