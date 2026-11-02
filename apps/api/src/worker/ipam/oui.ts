import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * MAC address vendor from the IEEE OUI registry (oui-data package, BSD-2-Clause),
 * loaded on first use. Locally administered addresses (virtual machines,
 * randomised client MACs) are labelled as such rather than given a vendor.
 */
let table: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (table) return table;
  try {
    const path = createRequire(__filename).resolve('oui-data');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    table = new Map(Object.entries(raw).map(([k, v]) => [k.toUpperCase(), v.split('\n')[0]!.trim()]));
  } catch {
    table = new Map();
  }
  return table;
}

export function macVendor(mac: string | null | undefined): string | null {
  const hex = (mac ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  if (hex.startsWith('525400')) return 'QEMU/KVM virtual machine';
  // Second-lowest bit of the first octet: locally administered (not registered to a vendor).
  if (parseInt(hex.slice(0, 2), 16) & 0x02) return 'Locally administered (virtual or randomised)';
  return load().get(hex.slice(0, 6)) ?? null;
}
