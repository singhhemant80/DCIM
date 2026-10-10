/** AAD for a DNS server's API key: bound to the organization, server row, kind and API URL. */
export function dnsServerContext(orgId: string, serverId: string, kind: string, url: string | null) {
  return `dns_server:${orgId}:${serverId}:${kind}:${(url ?? '').toLowerCase()}`;
}

/** Longest zone that contains `name` (or equals it). */
export function zoneFor<T extends { name: string }>(zones: T[], name: string): T | null {
  const n = name.toLowerCase().replace(/\.$/, '');
  let best: T | null = null;
  for (const z of zones) {
    if ((n === z.name || n.endsWith(`.${z.name}`)) && (!best || z.name.length > best.name.length)) best = z;
  }
  return best;
}
