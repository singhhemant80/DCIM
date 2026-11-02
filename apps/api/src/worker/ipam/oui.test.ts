import { describe, expect, it } from 'vitest';
import { macVendor } from './oui';

describe('MAC vendor', () => {
  it('looks up the IEEE registry and labels virtual MACs', () => {
    expect(macVendor('00:00:00:12:34:56')).toMatch(/XEROX/);
    expect(macVendor('52:54:00:aa:bb:cc')).toBe('QEMU/KVM virtual machine');
    expect(macVendor('02:11:22:33:44:55')).toMatch(/Locally administered/);
    expect(macVendor('nonsense')).toBeNull();
    expect(macVendor(null)).toBeNull();
  });
});
