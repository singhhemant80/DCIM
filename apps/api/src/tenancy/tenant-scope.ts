import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Principal } from '../auth/principal';

/**
 * Builds the row filter every tenant-aware query must include.
 *
 *  - Always restricts to the principal's organization.
 *  - For customer users, additionally restricts to their customer. Rows with
 *    no customer (company-owned infrastructure) are therefore invisible to
 *    customers by construction — they only see what is assigned to them.
 *
 * Services take the result and AND it into their WHERE clause. Combined with
 * returning 404 (not 403) for out-of-scope ids, a customer cannot even learn
 * whether another tenant's resource exists.
 */
export function tenantFilter(
  principal: Principal,
  cols: { orgId: PgColumn; customerId?: PgColumn },
): SQL {
  const orgCond = eq(cols.orgId, principal.orgId);
  if (principal.userType === 'staff') return orgCond;
  if (!principal.customerId) {
    // Defensive: a customer principal without a customer must see nothing.
    throw new Error('Customer principal without customerId');
  }
  if (!cols.customerId) {
    throw new Error('tenantFilter: customer principals require a customerId column on this resource');
  }
  return and(orgCond, eq(cols.customerId, principal.customerId))!;
}

/** True when the principal may act on a row owned by `customerId` (null = company-owned). */
export function canAccessCustomerRow(principal: Principal, rowOrgId: string, rowCustomerId: string | null): boolean {
  if (rowOrgId !== principal.orgId) return false;
  if (principal.userType === 'staff') return true;
  return rowCustomerId !== null && rowCustomerId === principal.customerId;
}
