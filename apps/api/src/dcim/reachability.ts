/** How often each in-service device's management address is pinged. */
export const DEVICE_CHECK_SECONDS = 60;
/** Lifecycle states of equipment that is physically installed, so worth checking. */
export const CHECKED_STATES = ['racked', 'provisioning', 'active', 'maintenance'] as const;

export type ReachabilityState = 'up' | 'down' | 'unknown';

export interface ReachabilityView {
  state: ReachabilityState;
  /** Why the state is unknown (not in service, no address, not checked yet, stale, check error). */
  reason: string | null;
  rttMs: number | null;
  checkedAt: Date | null;
  lastSeenAt: Date | null;
  changedAt: Date | null;
}

export interface ReachabilityRow {
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
export function reachabilityView(lifecycleState: string, hasAddress: boolean, r: ReachabilityRow | null, now = Date.now()): ReachabilityView {
  const base = { rttMs: null, checkedAt: r?.checkedAt ?? null, lastSeenAt: r?.lastSeenAt ?? null, changedAt: r?.changedAt ?? null };
  const unknown = (reason: string): ReachabilityView => ({ state: 'unknown', reason, ...base });
  if (!(CHECKED_STATES as readonly string[]).includes(lifecycleState)) return unknown('Not checked: the device is not in service');
  if (!hasAddress) return unknown('Not checked: no management address');
  if (!r?.checkedAt || r.reachable === null) return unknown('Not checked yet');
  if (r.error) return unknown(r.error);
  if (now - r.checkedAt.getTime() > STALE_MS) return unknown('No recent check (is the worker running?)');
  return { state: r.reachable ? 'up' : 'down', reason: null, ...base, rttMs: r.reachable ? r.rttMs : null };
}
