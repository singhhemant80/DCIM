import { useEffect, useRef, useState } from 'react';
import { formatBitRate } from '@crapplet/shared';

export interface PortRateT {
  interfaceId: string;
  name: string;
  description: string | null;
  kind: string;
  enabled: boolean;
  deviceId: string;
  deviceName: string;
  datacenterId: string | null;
  speedBps: number | null;
  countInTotals: boolean;
  lagId: string | null;
  pollingEnabled: boolean;
  intervalSeconds: number;
  operUp: boolean | null;
  sampledAt: string | null;
  lastRateAt: string | null;
  fresh: boolean;
  lastSkip: string | null;
  inBps: number | null;
  outBps: number | null;
  utilIn: number | null;
  utilOut: number | null;
  errorsPs: number | null;
  discardsPs: number | null;
}

export interface HistoryPoint {
  t: string;
  inBps: number | null;
  outBps: number | null;
  inMax: number | null;
  outMax: number | null;
  utilIn: number | null;
  utilOut: number | null;
  errorsPs: number | null;
  discardsPs: number | null;
  coveredSeconds: number | null;
  flags: string[];
}

export interface PortHistoryT {
  port: PortRateT;
  range: string;
  resolution: 'raw' | '5m' | '1h';
  stepSeconds: number;
  points: HistoryPoint[];
  p95: { inBps: number | null; outBps: number | null; samples: number; basis: string };
}

export interface TotalsT {
  inBps: number | null;
  outBps: number | null;
  ports: number;
  freshPorts: number;
  stalePorts: number;
  excludedLagMembers: number;
  top: PortRateT[];
}

export interface TotalsHistoryT {
  range: string;
  stepSeconds: number;
  ports: number;
  points: { t: string; inBps: number; outBps: number; ports: number }[];
  p95: { inBps: number | null; outBps: number | null; samples: number };
}

export interface AlertSummaryT {
  firing: number;
  unacknowledged: number;
  critical: number;
  warning: number;
  info: number;
}

export interface LivePort {
  interfaceId: string;
  inBps: number | null;
  outBps: number | null;
  utilIn: number | null;
  utilOut: number | null;
  errorsPs: number | null;
  discardsPs: number | null;
  operUp: boolean | null;
  skip: string | null;
  at: string;
}

/** Why a poll gave no rate, in words. */
export const SKIP_LABELS: Record<string, string> = {
  first: 'First reading; the rate appears after the next poll',
  duplicate: 'Two readings too close together',
  gap: 'Polls were missed; no rate across the gap',
  reset: 'Counters reset (device restarted); new baseline taken',
  implausible: 'Reading above the link speed was discarded',
  no_counters: 'The device reported no byte counters for this port',
};

export const bps = (v: number | null | undefined) => formatBitRate(v ?? null);
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`);
export const perSec = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v === 0 ? '0' : v < 0.01 ? '<0.01/s' : `${v < 10 ? v.toFixed(2) : Math.round(v)}/s`);

/**
 * Live monitoring events over Server-Sent Events. The browser reconnects by
 * itself; `connected` is false while it does. The data on screen is also
 * refetched periodically, so a missed event only delays an update.
 */
export function useMonitoringStream(enabled = true) {
  const [live, setLive] = useState<Map<string, LivePort>>(() => new Map());
  const [connected, setConnected] = useState(false);
  const [feed, setFeed] = useState<boolean | null>(null);
  const [lastAlertAt, setLastAlertAt] = useState(0);
  const pending = useRef<Map<string, LivePort>>(new Map());
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/v1/monitoring/stream');
    // Batch updates so a burst of devices re-renders once.
    const flush = setInterval(() => {
      if (!pending.current.size) return;
      const batch = pending.current;
      pending.current = new Map();
      setLive((prev) => {
        const next = new Map(prev);
        for (const [k, v] of batch) next.set(k, v);
        return next;
      });
    }, 500);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.addEventListener('hello', (e) => {
      setConnected(true);
      setFeed(!!JSON.parse((e as MessageEvent).data).live);
    });
    es.addEventListener('ping', (e) => setFeed(!!JSON.parse((e as MessageEvent).data).live));
    es.addEventListener('rates', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as { at: string; ports: Omit<LivePort, 'at'>[] };
      for (const p of ev.ports) pending.current.set(p.interfaceId, { ...p, at: ev.at });
    });
    es.addEventListener('alert', () => setLastAlertAt(Date.now()));
    return () => {
      clearInterval(flush);
      es.close();
    };
  }, [enabled]);
  return { live, connected, feed, lastAlertAt };
}

/** A port row with the newest live values applied (when they are newer than the row). */
export function withLive(p: PortRateT, live: Map<string, LivePort>): PortRateT {
  const l = live.get(p.interfaceId);
  if (!l || (p.sampledAt && new Date(l.at) <= new Date(p.sampledAt))) return p;
  const fresh = l.skip === null;
  return { ...p, sampledAt: l.at, lastRateAt: fresh ? l.at : p.lastRateAt, fresh, lastSkip: l.skip, operUp: l.operUp, inBps: l.inBps, outBps: l.outBps, utilIn: l.utilIn, utilOut: l.utilOut, errorsPs: l.errorsPs, discardsPs: l.discardsPs };
}
