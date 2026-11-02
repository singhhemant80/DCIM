import type { FlowDiagnostics } from '../worker/flows/diagnostics';

/**
 * How far the per-IP bandwidth from flow records can be trusted, per
 * exporter: what its records show (export timeout, addresses outside IPAM,
 * sampling) and, when the uplink interface is known and monitored, how the
 * flow totals compare with that interface's counters. Pure: no I/O.
 */
export interface FlowCoverage {
  from: string;
  to: string;
  interfaceName: string;
  deviceName: string | null;
  /** Bytes measured on the interface (counters) and attributed from flows, over the same 30 minutes. */
  counterDownBytes: number;
  counterUpBytes: number;
  flowDownBytes: number;
  flowUpBytes: number;
  /** flow / counter; null when the interface carried almost nothing. */
  download: number | null;
  upload: number | null;
}
export interface AccuracyFinding {
  level: 'ok' | 'info' | 'warning' | 'critical';
  code: string;
  text: string;
  /** Commands to run on the router (MikroTik), shown as advice; DCIM never runs them. */
  fix?: string[];
  causes?: string[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function flowAccuracy(
  e: { name: string; liveInterface: string | null; exportersInOrg: number; coverageNote?: string | null },
  d: FlowDiagnostics | null,
  cov: FlowCoverage | null,
): { level: 'ok' | 'warning' | 'critical' | 'unknown'; findings: AccuracyFinding[] } {
  const f: AccuracyFinding[] = [];
  if (d && d.records > 0) {
    const longMin = Math.round(d.longestSeconds / 60);
    if (d.longestSeconds >= 300 && d.atLongestRecords >= 3)
      f.push({
        level: d.longFlowByteShare >= 0.3 ? 'critical' : 'warning',
        code: 'long_active_timeout',
        text: `${e.name} reports long-running flows only every ~${longMin} min (its active flow timeout). Their bytes arrive in one lump when the timeout expires, so the live view and "now" rates show much less than the real traffic (${pct(d.longFlowByteShare)} of the bytes in the last ${d.windowMinutes} min came in records over 2 minutes long). Hourly and daily totals spread each record over its duration, so they are right once the records arrive.`,
        fix: ['/ip traffic-flow set active-flow-timeout=1m inactive-flow-timeout=15s'],
      });
    const outside = d.bytes ? 1 - d.matchedBytes / d.bytes : 0;
    if (outside >= 0.2)
      f.push({
        level: outside >= 0.5 ? 'critical' : 'warning',
        code: 'outside_ipam',
        text: `${pct(outside)} of the bytes in ${e.name}'s flow records are for addresses outside your IPAM prefixes, so they are not counted per IP. Add your public prefixes to IPAM; if the router exports after NAT, the records carry the router's own address instead of your servers'.`,
      });
    if (d.sampling > 1) f.push({ level: 'info', code: 'sampled', text: `Records are sampled 1 in ${d.sampling}; bytes are multiplied by ${d.sampling}, so small addresses can be missed or jumpy.` });
    if (d.ipv6Records === 0) f.push({ level: 'info', code: 'no_ipv6', text: `No IPv6 flows from ${e.name} in the last ${d.windowMinutes} min. If you route IPv6, check that Traffic Flow exports it (NetFlow v9 or IPFIX; v5 has no IPv6).` });
    if (d.untimedRecords / d.records > 0.5) f.push({ level: 'info', code: 'untimed', text: 'Most records carry no start/end time, so their bytes are counted when they arrive.' });
  } else if (d) f.push({ level: 'info', code: 'no_records', text: `No flow records from ${e.name} in the last ${d.windowMinutes} min.` });

  if (cov) {
    const where = `${cov.deviceName ? `${cov.deviceName} ` : ''}${cov.interfaceName}`;
    const when = `${cov.from.slice(11, 16)}–${cov.to.slice(11, 16)} UTC`;
    const several = e.exportersInOrg > 1 ? ' (flows from all your exporters are compared with this one interface)' : '';
    if (cov.download === null) f.push({ level: 'info', code: 'coverage_idle', text: `${where} carried almost no traffic ${when}; nothing to compare.` });
    else if (cov.download < 0.7) {
      const causes = [
        'L3 hardware offloading (CCR2116/CCR2216, CRS3xx): routed traffic is switched in hardware and never reaches Traffic Flow. Check /interface/ethernet/switch print (l3-hw-offloading).',
        'Traffic Flow watches only some interfaces: /ip traffic-flow print should show interfaces=all.',
        'Part of the traffic goes through another router that does not export flows to DCIM.',
      ];
      if (d && d.ipv6Records === 0) causes.push('IPv6 traffic is not exported.');
      if (d && d.bytes && 1 - d.matchedBytes / d.bytes >= 0.2) causes.push('Addresses outside your IPAM prefixes (see above).');
      if (f.some((x) => x.code === 'long_active_timeout')) causes.unshift('Long flows not yet reported (active flow timeout, see above): this comparison uses 35–65 minutes ago to allow for a 30-minute timeout.');
      f.push({
        level: 'critical',
        code: 'coverage_low',
        text: `Flow records account for only ${pct(cov.download)} of the download and ${cov.upload === null ? '—' : pct(cov.upload)} of the upload measured on ${where} by its interface counters, ${when}${several}.`,
        causes,
      });
    } else if (cov.download > 1.3)
      f.push({
        level: 'warning',
        code: 'coverage_high',
        text: `Flow records show ${pct(cov.download)} of the download measured on ${where}${several}: traffic is counted twice (two routers or two interfaces exporting the same packets), or the interface set on the exporter is not the uplink.`,
      });
    else f.push({ level: 'ok', code: 'coverage_ok', text: `Flow records match ${where}'s interface counters: ${pct(cov.download)} of download, ${cov.upload === null ? '—' : pct(cov.upload)} of upload (${when}).` });
  } else if (!e.liveInterface) f.push({ level: 'info', code: 'no_interface', text: `Set the uplink interface on ${e.name} to compare the flow totals with its counters, and to get exact per-second rates per IP (Torch) in the live view.` });
  else if (e.coverageNote) f.push({ level: 'info', code: 'coverage_unavailable', text: e.coverageNote });

  const level = f.some((x) => x.level === 'critical') ? 'critical' : f.some((x) => x.level === 'warning') ? 'warning' : f.some((x) => x.level === 'ok') || (d && d.records > 0) ? 'ok' : 'unknown';
  return { level, findings: f };
}
