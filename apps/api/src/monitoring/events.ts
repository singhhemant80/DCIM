/**
 * Live monitoring events, published by the worker on Redis pub/sub and
 * relayed by the API to browsers over Server-Sent Events. Events carry only
 * measured values and ids, never credentials. The data is persisted in
 * PostgreSQL before an event is published, so a client that misses events
 * (or Redis being down) loses only the live push, never the data.
 */
export const monitoringChannel = (orgId: string) => `cdcim:monitoring:${orgId}`;
export const MONITORING_PATTERN = 'cdcim:monitoring:*';

export interface RatesEvent {
  type: 'rates';
  deviceId: string;
  at: string;
  ok: boolean;
  /** Short, redacted reason when the poll failed. */
  error?: string;
  ports: {
    interfaceId: string;
    inBps: number | null;
    outBps: number | null;
    utilIn: number | null;
    utilOut: number | null;
    errorsPs: number | null;
    discardsPs: number | null;
    operUp: boolean | null;
    skip: string | null;
  }[];
}

export interface AlertLiveEvent {
  type: 'alert';
  alertId: string;
  status: 'firing' | 'resolved';
  severity: string;
  deviceId: string | null;
  interfaceId: string | null;
  message: string;
  suppressed: boolean;
}

/**
 * Second-by-second rates while someone is watching a port (live view). Not
 * stored: the regular poll keeps writing history. Measured from counters
 * read once a second.
 */
export interface LiveEvent {
  type: 'live';
  deviceId: string;
  at: string;
  ports: { interfaceId: string; inBps: number | null; outBps: number | null; operUp: boolean | null }[];
}

/** Devices someone is watching live: sorted set of "<orgId>:<deviceId>" scored by expiry (ms). */
export const LIVE_WATCH_KEY = 'cdcim:live:watch';
export const LIVE_WATCH_TTL_MS = 20_000;

export type MonitoringEvent = RatesEvent | AlertLiveEvent | LiveEvent;
