/**
 * Unit formatting used by bandwidth and power views. Decimal (SI) prefixes
 * are used for bit rates because link speeds are specified that way
 * (1 Gbps = 10^9 bps).
 */
const BIT_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'] as const;

export function formatBitRate(bps: number | null | undefined, digits = 2): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  if (bps < 0) throw new RangeError('Bit rate cannot be negative');
  let value = bps;
  let i = 0;
  while (value >= 1000 && i < BIT_UNITS.length - 1) {
    value /= 1000;
    i++;
  }
  return `${i === 0 ? Math.round(value) : value.toFixed(digits)} ${BIT_UNITS[i]}`;
}

export function formatWatts(w: number | null | undefined): string {
  if (w === null || w === undefined || !Number.isFinite(w)) return '—';
  return w >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`;
}
