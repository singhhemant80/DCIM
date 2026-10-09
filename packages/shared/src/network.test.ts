import { describe, expect, it } from 'vitest';
import {
  cidrContains,
  cidrSchema,
  cidrSize,
  credentialSchema,
  expandInterfacePattern,
  formatIp,
  ipSchema,
  parseCidr,
  parseIp,
  parseSpeed,
  ptrName,
  usableRange,
} from './network';

describe('IP parsing', () => {
  it('parses and normalizes IPv4 and IPv6', () => {
    expect(parseIp('192.0.2.7')).toEqual({ family: 4, value: 0xc0000207n });
    expect(parseIp('192.0.2.256')).toBeNull();
    expect(parseIp('01.2.3.4')).toBeNull();
    const v6 = parseIp('2001:DB8:0:0:0:0:0:1')!;
    expect(formatIp(6, v6.value)).toBe('2001:db8::1');
    expect(formatIp(6, parseIp('::')!.value)).toBe('::');
    expect(formatIp(6, parseIp('2001:db8:0:1:0:0:0:1')!.value)).toBe('2001:db8:0:1::1');
    expect(formatIp(6, parseIp('::ffff:192.0.2.1')!.value)).toBe('::ffff:c000:201');
    expect(parseIp('2001:db8::1::2')).toBeNull();
    expect(parseIp('2001:db8:1:2:3:4:5:6:7')).toBeNull();
  });

  it('validates prefixes and rejects host bits', () => {
    expect(cidrSchema.safeParse('203.0.113.0/24')).toMatchObject({ success: true, data: '203.0.113.0/24' });
    expect(cidrSchema.safeParse('203.0.113.5/24').success).toBe(false);
    expect(cidrSchema.safeParse('2001:DB8::/48')).toMatchObject({ success: true, data: '2001:db8::/48' });
    expect(cidrSchema.safeParse('10.0.0.0/33').success).toBe(false);
    expect(ipSchema.safeParse('2001:0db8::0001')).toMatchObject({ success: true, data: '2001:db8::1' });
  });

  it('computes usable ranges', () => {
    const v4 = parseCidr('203.0.113.0/29')!;
    expect(usableRange(v4)).toEqual({ first: v4.network + 1n, last: v4.network + 6n, count: 6n });
    expect(usableRange(v4, true).count).toBe(8n);
    expect(usableRange(parseCidr('198.51.100.0/31')!).count).toBe(2n);
    expect(usableRange(parseCidr('198.51.100.1/32')!).count).toBe(1n);
    const v6 = parseCidr('2001:db8::/64')!;
    expect(usableRange(v6).count).toBe(cidrSize(v6) - 1n);
    expect(cidrContains(v6, parseIp('2001:db8::ffff')!)).toBe(true);
    expect(cidrContains(v6, parseIp('2001:db8:0:1::')!)).toBe(false);
    expect(cidrContains(v4, parseIp('2001:db8::1')!)).toBe(false);
  });

  it('builds reverse DNS names', () => {
    expect(ptrName(parseIp('192.0.2.7')!)).toBe('7.2.0.192.in-addr.arpa');
    expect(ptrName(parseIp('2001:db8::1')!)).toMatch(/^1\.0\.0\.0\..*\.8\.b\.d\.0\.1\.0\.0\.2\.ip6\.arpa$/);
  });
});

describe('helpers', () => {
  it('parses link speeds from vendor strings', () => {
    expect(parseSpeed('10Gbps')).toBe(10e9);
    expect(parseSpeed('10 Gb/s')).toBe(10e9);
    expect(parseSpeed('1000Mbps')).toBe(1e9);
    expect(parseSpeed('25G')).toBe(25e9);
    expect(parseSpeed('auto')).toBeNull();
    expect(parseSpeed(0)).toBeNull();
  });

  it('expands interface patterns', () => {
    expect(expandInterfacePattern('ether[1-3]')).toEqual(['ether1', 'ether2', 'ether3']);
    expect(expandInterfacePattern('Ethernet1/[47-48]')).toEqual(['Ethernet1/47', 'Ethernet1/48']);
    expect(expandInterfacePattern('lo0')).toEqual(['lo0']);
    expect(() => expandInterfacePattern('x[5-1]')).toThrow();
  });

  it('requires the right secret fields per credential type', () => {
    expect(credentialSchema.safeParse({ kind: 'snmp_v2c', community: 'public-ro' }).success).toBe(true);
    expect(credentialSchema.safeParse({ kind: 'snmp_v2c' }).success).toBe(false);
    expect(credentialSchema.safeParse({ kind: 'routeros_rest', username: 'dcim', password: 'pass-1' }).success).toBe(true);
    expect(credentialSchema.safeParse({ kind: 'fortios_rest', token: 'tok-123' }).success).toBe(true);
    // Secrets shorter than 3 characters are refused (they could not be redacted reliably from error text).
    expect(credentialSchema.safeParse({ kind: 'routeros_rest', username: 'dcim', password: 'x' }).success).toBe(false);
    expect(credentialSchema.safeParse({ kind: 'telnet', password: 'x' }).success).toBe(false);
  });
});
