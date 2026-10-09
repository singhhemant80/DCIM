import { describe, expect, it } from 'vitest';
import {
  deviceSchema,
  NAV_SECTIONS,
  PERMISSION_KEYS,
  SYSTEM_ROLES,
  createUserSchema,
  customerSchema,
  formatBitRate,
  formatWatts,
  isPermission,
  staffOnlyViolations,
} from './index';

describe('permission catalog', () => {
  it('has unique keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
  });

  it('every nav permission exists', () => {
    for (const s of NAV_SECTIONS) if (s.permission) expect(isPermission(s.permission)).toBe(true);
  });

  it('defines all 27 required navigation sections with unique paths', () => {
    expect(NAV_SECTIONS).toHaveLength(27);
    expect(new Set(NAV_SECTIONS.map((s) => s.path)).size).toBe(27);
  });

  it('customer system roles hold no staff-only permissions', () => {
    for (const r of SYSTEM_ROLES.filter((x) => x.scope === 'customer')) {
      expect(staffOnlyViolations(r.permissions)).toEqual([]);
    }
  });

  it('treats unknown permissions as staff-only (fail closed)', () => {
    expect(staffOnlyViolations(['made.up'])).toEqual(['made.up']);
  });

  it('read-only NOC role cannot perform control operations', () => {
    const noc = SYSTEM_ROLES.find((r) => r.key === 'noc_engineer')!;
    for (const k of ['hardware.control', 'network.config', 'provisioning.execute', 'users.write']) {
      expect(noc.permissions).not.toContain(k);
    }
  });
});

describe('schemas', () => {
  const role = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
  it('requires customerId for customer users and forbids it for staff', () => {
    const base = { email: 'a@b.co', name: 'A', password: 'x'.repeat(12), roleIds: [role] };
    expect(createUserSchema.safeParse({ ...base, userType: 'customer' }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, userType: 'staff', customerId: role }).success).toBe(false);
    expect(createUserSchema.safeParse({ ...base, userType: 'staff' }).success).toBe(true);
    expect(createUserSchema.safeParse({ ...base, userType: 'customer', customerId: role }).success).toBe(true);
  });

  it('rejects short passwords', () => {
    const r = createUserSchema.safeParse({ email: 'a@b.co', name: 'A', password: 'short', userType: 'staff', roleIds: [role] });
    expect(r.success).toBe(false);
  });

  it('normalizes customer codes to upper case', () => {
    expect(customerSchema.parse({ name: 'Acme', code: 'acme-01' }).code).toBe('ACME-01');
    expect(customerSchema.safeParse({ name: 'Acme', code: 'bad code' }).success).toBe(false);
  });
});

describe('units', () => {
  it('formats bit rates with SI prefixes', () => {
    expect(formatBitRate(0)).toBe('0 bps');
    expect(formatBitRate(999)).toBe('999 bps');
    expect(formatBitRate(1_500)).toBe('1.50 Kbps');
    expect(formatBitRate(10e9)).toBe('10.00 Gbps');
    expect(formatBitRate(400e12)).toBe('400.00 Tbps');
    expect(formatBitRate(null)).toBe('—');
    expect(() => formatBitRate(-1)).toThrow();
  });
  it('formats watts', () => {
    expect(formatWatts(245.4)).toBe('245 W');
    expect(formatWatts(1250)).toBe('1.25 kW');
    expect(formatWatts(undefined)).toBe('—');
  });
});

describe('device dates', () => {
  const base = { modelId: '6f9619ff-8b86-4011-b42d-00c04fc964ff', assetTag: 'A1' };
  it('accepts real dates and rejects impossible ones', () => {
    expect(deviceSchema.safeParse({ ...base, warrantyExpires: '2028-02-29' }).success).toBe(true);
    expect(deviceSchema.safeParse({ ...base, warrantyExpires: '2027-02-29' }).success).toBe(false);
    expect(deviceSchema.safeParse({ ...base, warrantyExpires: '2024-13-45' }).success).toBe(false);
    expect(deviceSchema.safeParse({ ...base, warrantyExpires: '31-12-2026' }).success).toBe(false);
  });
});
