import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
