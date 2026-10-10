import { PERMISSION_KEYS, type Permission } from '@crapplet/shared';
import type { Principal } from '../auth/principal';

/**
 * An organization-wide, read-oriented identity for work that no user starts
 * (signed billing-module calls, scheduled reports). It is never attached to a
 * request, so it can't reach any route; services use it only for scoping.
 */
export function systemPrincipal(orgId: string, label: string, permissions: readonly Permission[] = PERMISSION_KEYS): Principal {
  return {
    userId: '00000000-0000-0000-0000-000000000000',
    orgId,
    email: label,
    name: label,
    userType: 'staff',
    customerId: null,
    permissions: new Set(permissions),
    sessionId: `system:${label}`,
    mfaEnrollmentRequired: false,
    apiKey: null,
  };
}
