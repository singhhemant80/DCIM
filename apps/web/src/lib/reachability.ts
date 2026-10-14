import type { DeviceReachabilityT, ReachCheckT } from './dcim';

export function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}

const ms = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;

/** "Reachable (0.8 ms, checked 20 s ago)", "Not reachable since 5 min ago (last answered 2 h ago)" or the reason it isn't checked. */
export function checkText(r: ReachCheckT) {
  if (r.state === 'up') return `Reachable (${r.rttMs !== null ? ms(r.rttMs) : 'ping ok'}, checked ${ago(r.checkedAt)})`;
  if (r.state === 'down') return `Not reachable since ${ago(r.changedAt)} (last answered ${ago(r.lastSeenAt)})`;
  return r.reason ?? 'Not checked';
}

export const MGMT_LABEL = 'Management (BMC)';
export const SERVER_LABEL = 'Server (OS)';

export function reachTitle(r: DeviceReachabilityT) {
  const t = (c: ReachCheckT) => (c.target ? ` ${c.target}` : '');
  return `${MGMT_LABEL}${t(r.mgmt)}: ${checkText(r.mgmt)}\n${SERVER_LABEL}${t(r.server)}: ${checkText(r.server)}`;
}

export const DOT: Record<ReachCheckT['state'], string> = { up: 'bg-[#4ade80]', down: 'bg-[#f87171]', unknown: 'bg-[#9aa4b2]' };
