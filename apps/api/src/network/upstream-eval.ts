import { cidrLast, parseCidr, type PrefixRoutingData, type RoutingFinding, type RoutingLevel, type UpstreamCheckData, type UpstreamPrefixStatus } from '@crapplet/shared';

/**
 * Works out whether your prefixes go out properly through one upstream (an IX
 * peering service such as a provider re-announcing them at exchanges, or a
 * transit provider), from what the worker read (IRR, your routers) and the
 * latest prefix checks (RIPE RIS, RPKI). Pure: no I/O.
 */
export interface UpstreamInput {
  asn: number;
  name: string;
  kind: string;
  asSet: string | null;
}
export interface PrefixInput {
  id: string;
  prefix: string;
  description: string | null;
  originAsn: number | null;
  checked: boolean;
  data: PrefixRoutingData | null;
}

const covers = (outer: string, inner: string) => {
  const a = parseCidr(outer, true);
  const b = parseCidr(inner, true);
  return !!a && !!b && a.family === b.family && a.length <= b.length && a.network <= b.network && cidrLast(a) >= cidrLast(b);
};
const worst = (xs: RoutingLevel[]): RoutingLevel => (xs.includes('critical') ? 'critical' : xs.includes('warning') ? 'warning' : 'ok');
const dur = (s: number | null) => (s === null ? '' : s >= 86400 ? `${Math.floor(s / 86400)} d` : s >= 3600 ? `${Math.floor(s / 3600)} h` : `${Math.max(1, Math.floor(s / 60))} min`);

export function evaluateUpstream(u: UpstreamInput, data: UpstreamCheckData | null, ourAsns: number[], prefixes: PrefixInput[]) {
  const findings: RoutingFinding[] = [];
  const ix = u.kind === 'ix_peering';
  const who = `${u.name} (AS${u.asn})`;
  // Your own prefixes (expected origin is one of your ASNs) that are announcement units: announced exactly,
  // sent exactly by a router, or not announced at all. Pools routed through a covering announcement are left out.
  const advertisedAll = data?.routers.some((r) => r.advertised) ? new Set(data.routers.flatMap((r) => r.advertised ?? [])) : null;
  const candidates = prefixes.filter((p) => p.checked && (p.originAsn === null || ourAsns.includes(p.originAsn)) && (!p.data?.effective || p.data.effective.prefix === p.prefix || advertisedAll?.has(p.prefix)));
  // A prefix inside another one listed here counts only when it is itself announced or sent.
  const own = (p: PrefixInput) => p.data?.effective?.prefix === p.prefix || !!advertisedAll?.has(p.prefix);
  const units = candidates.filter((p) => own(p) || !candidates.some((q) => q !== p && covers(q.prefix, p.prefix)));
  const objects = new Map<string, number[]>();
  for (const ro of data?.routeObjects ?? []) for (const pfx of ro.prefixes) objects.set(pfx, [...(objects.get(pfx) ?? []), ro.asn]);
  const routeObjectsKnown = !!data && data.routeObjects.length > 0 && data.routeObjects.every((r) => !r.error);

  const rows: UpstreamPrefixStatus[] = units.map((p) => {
    const origin = p.originAsn ? [p.originAsn] : ourAsns;
    const notes: string[] = [];
    const levels: RoutingLevel[] = [];
    let routeObject: UpstreamPrefixStatus['routeObject'] = null;
    let coveringObject: string | null = null;
    if (routeObjectsKnown) {
      if ((objects.get(p.prefix) ?? []).some((a) => origin.includes(a))) routeObject = 'exact';
      else {
        coveringObject = [...objects.entries()].find(([pfx, asns]) => pfx !== p.prefix && covers(pfx, p.prefix) && asns.some((a) => origin.includes(a)))?.[0] ?? null;
        routeObject = coveringObject ? 'covering' : 'none';
      }
      if (routeObject === 'none') {
        levels.push('critical');
        notes.push(`No route object for ${p.prefix} with origin ${origin.map((a) => `AS${a}`).join('/')}: peers that filter on the IRR drop it`);
      } else if (routeObject === 'covering') {
        levels.push('warning');
        notes.push(`Only the covering route object ${coveringObject}: filters built from AS-SETs usually accept exact prefixes only`);
      }
    }
    let advertised: boolean | null = null;
    if (advertisedAll) {
      advertised = advertisedAll.has(p.prefix);
      if (!advertised) {
        levels.push('critical');
        notes.push(`Your router does not send ${p.prefix} to ${u.name}`);
      }
    }
    const rpki = p.data?.rpki.find((r) => origin.includes(r.origin))?.status ?? p.data?.rpki[0]?.status ?? null;
    if (rpki?.startsWith('invalid')) {
      levels.push('critical');
      notes.push('RPKI invalid: IX route servers and most peers drop it');
    } else if (rpki === 'unknown' && p.data?.announced) {
      levels.push('warning');
      notes.push('No ROA: some IX route servers and peers only accept RPKI-valid routes');
    }
    const seenVia = p.data?.upstreams.find((x) => x.asn === u.asn)?.peers ?? 0;
    if (p.data && !p.data.announced && advertised !== true) {
      levels.push(ix ? 'warning' : 'critical');
      notes.push('Not seen in the global routing table (RIPE RIS)');
    }
    return { prefixId: p.id, prefix: p.prefix, description: p.description, routeObject, coveringObject, advertised, seenVia, announced: p.data ? p.data.announced : null, rpki, level: worst(levels), notes };
  });

  // The provider's AS-SET.
  if (!ourAsns.length) findings.push({ level: 'warning', code: 'no_asn', text: 'Add your ASN first: everything here is checked against it' });
  if (!u.asSet) findings.push({ level: 'warning', code: 'no_as_set', text: `Enter ${u.name}'s customer AS-SET (see their PeeringDB "IRR as-set") to check that your ASN is in it` });
  else if (data) {
    const irr = data.irr;
    if (irr.error) findings.push({ level: 'warning', code: 'irr_error', text: `Could not read ${u.asSet} from ${irr.server}: ${irr.error}` });
    else if (irr.found === false) findings.push({ level: 'critical', code: 'as_set_missing', text: `${u.asSet} does not exist in the IRR (${irr.server})` });
    else if (irr.found) {
      for (const o of irr.ourAsns) {
        if (!o.inSet)
          findings.push({
            level: 'critical',
            code: 'not_in_as_set',
            text: `AS${o.asn} is not in ${u.asSet}: peers and route servers that build filters from ${u.name}'s AS-SET will drop your prefixes. Ask ${u.name} to add AS${o.asn}${irr.ourSetsListed.length ? '' : ' (or your AS-SET)'} to it`,
          });
        else
          findings.push({
            level: 'ok',
            code: 'in_as_set',
            text: `AS${o.asn} is in ${u.asSet} (${o.direct ? 'listed directly' : irr.ourSetsListed.length ? `through ${irr.ourSetsListed.join(', ')}` : 'through a nested set'}; ${irr.size} ASNs in the set)`,
          });
      }
    }
  }
  // Your routers.
  if (data) {
    const withSession = data.routers.filter((r) => r.sessions.length);
    if (!data.routersRead) findings.push({ level: 'info', code: 'no_routers', text: 'No MikroTik router with RouterOS credentials in DCIM: add them (read-only) to see the BGP session and the prefixes sent' });
    else if (!withSession.length && !data.routers.some((r) => r.error))
      findings.push({ level: 'warning', code: 'no_session', text: `None of your ${data.routersRead} router${data.routersRead === 1 ? '' : 's'} has a BGP session to AS${u.asn}` });
    for (const r of data.routers) {
      if (r.error) findings.push({ level: 'warning', code: 'router_error', text: `${r.name}: could not read BGP (${r.error})` });
      for (const s of r.sessions) {
        if (s.state === 'established')
          findings.push({
            level: 'ok',
            code: 'session_up',
            text: `${r.name}: session ${s.name ?? s.peer} to ${s.peer} established${s.uptimeSeconds !== null ? ` for ${dur(s.uptimeSeconds)}` : ''}${s.prefixesReceived !== null ? `, ${s.prefixesReceived} prefixes received` : ''}`,
          });
        else findings.push({ level: 'critical', code: 'session_down', text: `${r.name}: session ${s.name ?? s.peer} to ${s.peer} is ${s.state}` });
      }
      if (r.sessions.length && r.advertised === null) findings.push({ level: 'info', code: 'no_sent_list', text: `${r.name} does not list the prefixes it sends (RouterOS 7 shows them when the BGP connection keeps sent attributes)` });
    }
  }
  // What RIPE's collectors see.
  const announced = rows.filter((r) => r.announced);
  const via = rows.filter((r) => r.seenVia > 0);
  if (announced.length)
    findings.push(
      via.length || ix
        ? {
            level: 'info',
            code: 'ris_via',
            text: `RIPE RIS sees ${via.length} of ${announced.length} announced prefixes through AS${u.asn}${ix ? '. Routes exchanged at IXs mostly stay inside the exchange, so RIS seeing few or none is normal for IX peering' : ''}`,
          }
        : { level: 'warning', code: 'ris_not_via', text: `RIPE RIS sees none of your ${announced.length} announced prefixes through AS${u.asn}` },
    );
  const level = worst([...findings.filter((f) => f.level !== 'info').map((f) => f.level as RoutingLevel), ...rows.map((r) => r.level)]);
  return { level, findings, prefixes: rows };
}
