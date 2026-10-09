import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
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
