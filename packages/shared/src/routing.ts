import { z } from 'zod';
import { cidrLast, parseCidr, type ParsedCidr } from './network';

/**
 * Global routing (BGP) check of the organization's prefixes: whether each is
 * seen in the global routing table, by which origin AS, with which upstreams,
 * and whether RPKI and the routing registries (IRR) agree. Observed from the
 * outside through RIPEstat (RIPE RIS route collectors, RIPE NCC's RPKI
 * validator). Read-only: NexoraDC never announces or changes routes.
 */
export const asnSchema = z.number().int().min(1).max(4294967295);
/** An IRR set name such as AS-EXAMPLE or AS152565:AS-JOYSVC (RPSL hierarchical names allowed). */
export const asSetSchema = z
  .string()
  .trim()
  .toUpperCase()
  .max(100)
  .regex(/^((AS\d+|AS-[A-Z0-9_-]+):)*AS-[A-Z0-9_-]+(:(AS\d+|AS-[A-Z0-9_-]+))*$/, 'Use an AS-SET name such as AS-EXAMPLE or AS65000:AS-CUSTOMERS');
export const bgpAsnSchema = z.object({
  asn: asnSchema,
  name: z.string().trim().max(120).nullable().optional(),
  /** Your own AS-SET (what upstreams and IX peers expand to build filters), if you have one. */
  asSet: asSetSchema.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type BgpAsnInput = z.infer<typeof bgpAsnSchema>;

export const UPSTREAM_KINDS = ['ix_peering', 'transit', 'other'] as const;
export type UpstreamKind = (typeof UPSTREAM_KINDS)[number];
export const UPSTREAM_KIND_LABELS: Record<UpstreamKind, string> = { ix_peering: 'IX peering service', transit: 'IP transit', other: 'Other BGP neighbour' };
/** A network your routes go through: an IX peering service (a provider re-announcing them at exchanges) or a transit provider. */
export const bgpUpstreamSchema = z.object({
  asn: asnSchema,
  name: z.string().trim().min(1).max(120),
  kind: z.enum(UPSTREAM_KINDS).default('ix_peering'),
  /** The provider's customer AS-SET that must contain your ASN (or your AS-SET), e.g. AS152565:AS-JOYSVC. */
  asSet: asSetSchema.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export type BgpUpstreamInput = z.infer<typeof bgpUpstreamSchema>;
export const routingCheckRequestSchema = z.object({ prefixId: z.string().uuid().optional(), asnId: z.string().uuid().optional(), upstreamId: z.string().uuid().optional() });

/** What the worker reads for one upstream (IRR, your routers). Findings are worked out when shown, with the latest prefix checks. */
export interface UpstreamCheckData {
  irr: {
    server: string;
    asSet: string | null;
    /** null: no AS-SET entered. */
    found: boolean | null;
    /** ASNs in the set, fully expanded. */
    size: number | null;
    ourAsns: { asn: number; inSet: boolean; direct: boolean }[];
    /** Your own AS-SETs listed directly in the provider's set. */
    ourSetsListed: string[];
    error: string | null;
  };
  /** Route objects (route / route6) registered with each of your ASNs as origin, in any IRR the server mirrors. */
  routeObjects: { asn: number; prefixes: string[]; error: string | null }[];
  /** MikroTik routers with credentials that were read (or tried). */
  routersRead: number;
  routers: {
    deviceId: string;
    name: string;
    readAt: string;
    sessions: { name: string | null; peer: string; state: string; uptimeSeconds: number | null; prefixesReceived: number | null }[];
    /** Prefixes the router sends to this provider; null when the router does not report them. */
    advertised: string[] | null;
    error: string | null;
    warnings: string[];
  }[];
}

export interface UpstreamPrefixStatus {
  prefixId: string;
  prefix: string;
  description: string | null;
  /** exact: a route object for this prefix and your ASN; covering: only for a larger prefix; none. null: not looked up. */
  routeObject: 'exact' | 'covering' | 'none' | null;
  coveringObject: string | null;
  /** Sent to the provider by one of your routers; null when unknown. */
  advertised: boolean | null;
  /** RIS peers that see the prefix through this provider (AS path … provider, your ASN). */
  seenVia: number;
  announced: boolean | null;
  rpki: RpkiStatus | null;
  level: RoutingLevel;
  notes: string[];
}

export type RoutingLevel = 'ok' | 'warning' | 'critical';
export interface RoutingFinding {
  level: RoutingLevel | 'info';
  code: string;
  text: string;
}
export type RpkiStatus = 'valid' | 'invalid_asn' | 'invalid_length' | 'invalid' | 'unknown';
export const RPKI_LABELS: Record<RpkiStatus, string> = { valid: 'Valid', invalid_asn: 'Invalid (AS)', invalid_length: 'Invalid (length)', invalid: 'Invalid', unknown: 'No ROA' };

export interface PrefixRoutingData {
  source: string;
  /** The time RIS data is valid for. */
  queryTime: string | null;
  expectedAsns: number[];
  /** Seen in BGP, exactly or through a covering (less specific) prefix. */
  announced: boolean;
  /** Origins of the exact prefix, with the IRR sources that hold a matching route object. */
  exact: { asn: number; routeObjects: string[] }[];
  covering: { prefix: string; origin: number }[];
  moreSpecifics: { prefix: string; origin: number }[];
  /** The announcement that carries traffic for this prefix: the exact one, else the most specific covering one. */
  effective: { prefix: string; origins: number[] } | null;
  visibility: { seeing: number; total: number } | null;
  firstSeen: { time: string; origin: number | null; prefix: string | null } | null;
  lastSeen: { time: string; origin: number | null; prefix: string | null } | null;
  rpki: { prefix: string; origin: number; status: RpkiStatus; roas: { origin: number; prefix: string; maxLength: number | null }[] }[];
  /** Neighbour ASes the origin is seen through (from RIS peers' AS paths), with how many peers see each. */
  upstreams: { asn: number; peers: number }[];
  pathPeers: number;
  findings: RoutingFinding[];
  level: RoutingLevel;
}

export interface AsnRoutingData {
  source: string;
  queryTime: string | null;
  holder: string | null;
  prefixes: string[];
  v4Prefixes: number | null;
  v6Prefixes: number | null;
  neighbours: number | null;
}

/** Ranges that are never in the global routing table (private, shared, documentation, multicast, reserved). */
export const ROUTING_SPECIAL_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/3',
  '2001:db8::/32',
  '2001::/32',
  '2002::/16',
];
const SPECIAL = ROUTING_SPECIAL_RANGES.map((s) => parseCidr(s)!);
const GLOBAL_V6 = parseCidr('2000::/3')!;
const within = (a: ParsedCidr, b: ParsedCidr) => a.family === b.family && a.length >= b.length && a.network >= b.network && cidrLast(a) <= cidrLast(b);
const overlaps = (a: ParsedCidr, b: ParsedCidr) => a.family === b.family && a.network <= cidrLast(b) && b.network <= cidrLast(a);

/** Why a prefix is not checked in the global table, or null when it is a candidate. */
export function routingSkipReason(prefix: string): string | null {
  const c = parseCidr(prefix, true);
  if (!c) return 'Not a prefix';
  if (SPECIAL.some((s) => overlaps(c, s))) return 'Private or reserved range (not globally routable)';
  if (c.family === 6 && !within(c, GLOBAL_V6)) return 'Not global unicast IPv6';
  if (c.family === 4 && c.length > 24) return 'Longer than /24: checked through the covering prefix';
  if (c.family === 6 && c.length > 48) return 'Longer than /48: checked through the covering prefix';
  return null;
}
