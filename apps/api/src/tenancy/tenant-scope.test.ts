import { describe, expect, it } from 'vitest';
import type { Principal } from '../auth/principal';
import { canAccessCustomerRow } from './tenant-scope';

const principal = (over: Partial<Principal>): Principal => ({
  userId: 'u',
  orgId: 'org1',
  email: 'x@y.z',
  name: 'x',
  userType: 'staff',
  customerId: null,
  permissions: new Set(),
  sessionId: 's',
  mfaEnrollmentRequired: false,
  ...over,
});

describe('canAccessCustomerRow', () => {
  const staff = principal({});
  const cust = principal({ userType: 'customer', customerId: 'c1' });

  it('never crosses organizations', () => {
    expect(canAccessCustomerRow(staff, 'org2', null)).toBe(false);
    expect(canAccessCustomerRow(cust, 'org2', 'c1')).toBe(false);
  });
  it('staff see company-owned and customer-owned rows in their org', () => {
    expect(canAccessCustomerRow(staff, 'org1', null)).toBe(true);
    expect(canAccessCustomerRow(staff, 'org1', 'c9')).toBe(true);
  });
  it('customers see only their own rows, never company-owned ones', () => {
    expect(canAccessCustomerRow(cust, 'org1', 'c1')).toBe(true);
    expect(canAccessCustomerRow(cust, 'org1', 'c2')).toBe(false);
    expect(canAccessCustomerRow(cust, 'org1', null)).toBe(false);
  });
});
