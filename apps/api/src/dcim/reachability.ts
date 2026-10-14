/** How often each in-service device's management address is pinged. */
export const DEVICE_CHECK_SECONDS = 60;
/** Lifecycle states of equipment that is physically installed, so worth checking. */
export const CHECKED_STATES = ['racked', 'provisioning', 'active', 'maintenance'] as const;

export type ReachabilityState = 'up' | 'down' | 'unknown';
export type ReachabilityKind = 'mgmt' | 'server';

export interface ReachabilityView {
  state: ReachabilityState;
  /** Why the state is unknown (not in service, no address, not checked yet, stale, check error). */
  reason: string | null;
  /** The address that was pinged (staff only). */
  target?: string | null;
  rttMs: number | null;
  checkedAt: Date | null;
  lastSeenAt: Date | null;
  changedAt: Date | null;
}

export interface ReachabilityRow {
  target?: string | null;
  reachable: boolean | null;
  rttMs: number | null;
  checkedAt: Date | null;
  lastSeenAt: Date | null;
  changedAt: Date | null;
  error: string | null;
}

/** A result older than this is not shown as up or down (the worker may be stopped). */
const STALE_MS = 5 * DEVICE_CHECK_SECONDS * 1000;

/**
 * Up / down only from a recent ping of the management address. Everything
 * else is "unknown" with the reason, never shown as down.
 */
export function reachabilityView(lifecycleState: string, hasAddress: boolean, r: ReachabilityRow | null, now = Date.now(), noAddress = 'Not checked: no management address'): ReachabilityView {
  const base = { rttMs: null, checkedAt: r?.checkedAt ?? null, lastSeenAt: r?.lastSeenAt ?? null, changedAt: r?.changedAt ?? null };
  const unknown = (reason: string): ReachabilityView => ({ state: 'unknown', reason, ...base });
  if (!(CHECKED_STATES as readonly string[]).includes(lifecycleState)) return unknown('Not checked: the device is not in service');
  if (!hasAddress) return unknown(noAddress);
  if (!r?.checkedAt || r.reachable === null) return unknown('Not checked yet');
  if (r.error) return unknown(r.error);
  if (now - r.checkedAt.getTime() > STALE_MS) return unknown('No recent check (is the worker running?)');
  return { state: r.reachable ? 'up' : 'down', reason: null, ...base, rttMs: r.reachable ? r.rttMs : null };
}

export interface DeviceReachability {
  /** Both checks together: up (all checked answer), down (none answers), partial, or unknown (nothing checked). */
  state: ReachabilityState | 'partial';
  mgmt: ReachabilityView;
  server: ReachabilityView;
}

/**
 * The device's two checks and their combined state. A check that isn't
 * running (unknown) doesn't count either way.
 */
export function deviceReachabilityView(
  lifecycleState: string,
  has: { mgmt: boolean; server: boolean },
  rows: Partial<Record<ReachabilityKind, ReachabilityRow>>,
  staff: boolean,
  now = Date.now(),
): DeviceReachability {
  const one = (k: ReachabilityKind, missing: string) => {
    const v = reachabilityView(lifecycleState, has[k], rows[k] ?? null, now, missing);
    return staff && has[k] && rows[k]?.target ? { ...v, target: rows[k]!.target } : v;
  };
  const mgmt = one('mgmt', 'Not checked: no management (BMC) address');
  const server = one('server', 'Not checked: no server address or full host name');
  const known = [mgmt.state, server.state].filter((s) => s !== 'unknown');
  const state = !known.length ? 'unknown' : known.every((s) => s === 'up') ? 'up' : known.every((s) => s === 'down') ? 'down' : 'partial';
  return { state, mgmt, server };
}
