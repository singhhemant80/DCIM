import { z } from 'zod';
import { PERMISSION_KEYS } from './permissions';

/** Password policy: length beats complexity rules; we also reject a small set of trivially weak values server-side. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const totpCodeSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const mfaVerifySchema = z.object({
  /** Short-lived challenge token returned by /auth/login when MFA is required. */
  challengeToken: z.string().min(20).max(200),
  code: z.union([totpCodeSchema, z.string().trim().regex(/^[a-z0-9]{5}-[a-z0-9]{5}$/, 'Invalid recovery code')]),
});

export const mfaEnableSchema = z.object({ code: totpCodeSchema });
export const mfaDisableSchema = z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

export const userTypeSchema = z.enum(['staff', 'customer']);

export const createUserSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(1).max(120),
    password: passwordSchema,
    userType: userTypeSchema,
    customerId: z.string().uuid().nullable().optional(),
    roleIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .refine((v) => (v.userType === 'customer') === !!v.customerId, {
    message: 'Customer users must belong to exactly one customer; staff users must not',
    path: ['customerId'],
  });
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  roleIds: z.array(z.string().uuid()).min(1).max(20).optional(),
});

export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  scope: userTypeSchema,
  permissions: z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])).max(200),
});

export const customerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,30}$/, 'Code must be 2–31 letters, digits or dashes'),
  contactEmail: emailSchema.nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  billingReference: z.string().trim().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(['active', 'suspended', 'closed']).default('active'),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export const settingsSchema = z.object({
  organizationName: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).optional(),
  sessionIdleMinutes: z.number().int().min(5).max(24 * 60).optional(),
  sessionMaxHours: z.number().int().min(1).max(24 * 30).optional(),
  requireMfaForStaff: z.boolean().optional(),
});
export type SettingsInput = z.infer<typeof settingsSchema>;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().max(100).optional(),
  actorId: z.string().uuid().optional(),
  targetType: z.string().max(60).optional(),
  outcome: z.enum(['success', 'failure', 'denied']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
