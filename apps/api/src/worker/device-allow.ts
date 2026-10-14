import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Optional allow-list of the networks the worker may connect to with stored
 * device, BMC, console and hypervisor credentials (CDCIM_DEVICE_ALLOW, CIDRs,
 * comma-separated; e.g. the management networks). Unset: no restriction
 * (the install check warns). With it, a credential pointed at any other
 * address (an internal service, a cloud metadata address, the internet) is
 * refused before a connection is made. Names are resolved and every address
 * must be inside the list.
 */
export function parseAllowList(raw: string | undefined): BlockList | null {
  const parts = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const list = new BlockList();
  for (const cidr of parts) {
    const [addr, len] = cidr.split('/');
    const family = isIP(addr ?? '');
    const bits = len === undefined ? (family === 4 ? 32 : 128) : Number(len);
    if (!family || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) throw new Error(`CDCIM_DEVICE_ALLOW: "${cidr}" is not an address or CIDR`);
    list.addSubnet(addr!, bits, family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

let cached: { raw: string | undefined; list: BlockList | null } | null = null;
function current(): BlockList | null {
  const raw = process.env.CDCIM_DEVICE_ALLOW;
  if (!cached || cached.raw !== raw) cached = { raw, list: parseAllowList(raw) };
  return cached.list;
}

const strip = (h: string) => h.replace(/^\[|\]$/g, '');

/** Throws when `host` resolves to an address outside CDCIM_DEVICE_ALLOW. */
export async function assertDeviceHost(host: string, list: BlockList | null = current()): Promise<void> {
  if (!list) return;
  const h = strip(host.trim());
  const addrs = isIP(h) ? [{ address: h, family: isIP(h) }] : await lookup(h, { all: true, verbatim: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Cannot resolve ${host}`);
  for (const a of addrs) {
    const ip = a.address.startsWith('::ffff:') ? a.address.slice(7) : a.address;
    const fam = isIP(ip);
    if (!list.check(ip, fam === 4 ? 'ipv4' : 'ipv6')) throw new Error(`${host} (${ip}) is outside the networks this server may reach with device credentials (CDCIM_DEVICE_ALLOW)`);
  }
}

/** Wraps every method of a client so each call first checks the host. */
export function guarded<T extends object>(client: T, host: () => string): T {
  return Object.fromEntries(
    Object.entries(client).map(([k, v]) => [
      k,
      typeof v === 'function'
        ? async (...args: unknown[]) => {
            await assertDeviceHost(host());
            return (v as (...a: unknown[]) => unknown).apply(client, args);
          }
        : v,
    ]),
  ) as T;
}
