import { describe, expect, it } from 'vitest';
import { formatBps, formatUptime } from './network';

describe('network formatting', () => {
  it('formats bit rates', () => {
    expect(formatBps(null)).toBe('—');
    expect(formatBps(1e9)).toBe('1 Gbit/s');
    expect(formatBps(2.5e9)).toBe('2.5 Gbit/s');
    expect(formatBps(100e6)).toBe('100 Mbit/s');
    expect(formatBps(4e11)).toBe('400 Gbit/s');
  });
  it('formats uptime', () => {
    expect(formatUptime(90061)).toBe('1 d 1 h');
    expect(formatUptime(3720)).toBe('1 h 2 min');
    expect(formatUptime(null)).toBe('—');
  });
});
