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

export type MonitoringEvent = RatesEvent | AlertLiveEvent;
