/**
 * What the flow records from one exporter look like over the last 15 minutes,
 * to tell how far the per-IP numbers can be trusted: how long the exported
 * flows run (a router that exports long flows only every 30 minutes makes the
 * live view show far too little), how many bytes concern addresses outside
 * IPAM, IPv6, sampling. Measured from the records themselves; nothing is
 * estimated.
 */
export interface FlowDiagnostics {
  windowMinutes: number;
  records: number;
  /** Bytes after sampling. */
  bytes: number;
  /** Bytes to or from your IPAM addresses. */
  matchedBytes: number;
  ipv6Records: number;
  /** Records without start/end times (counted when they arrive). */
  untimedRecords: number;
  /** Longest flow duration seen, in seconds. */
  longestSeconds: number;
  /** Share of bytes in records lasting more than 2 minutes. */
  longFlowByteShare: number;
  /** Records lasting at least 90 % of the longest one: many of them means the router's active timeout is about that long. */
  atLongestRecords: number;
  /** Highest 1-in-N sampling seen (1: none). */
  sampling: number;
}

const MINUTE = 60_000;
interface Slot {
  minute: number;
  records: number;
  bytes: number;
  matched: number;
  v6: number;
  untimed: number;
  longBytes: number;
  sampling: number;
  durations: number[];
}

export class FlowProfile {
  private slots: Slot[] = [];
  constructor(private readonly minutes = 15) {}

  private slot(now: number): Slot {
    const minute = Math.floor(now / MINUTE);
    let s = this.slots[this.slots.length - 1];
    if (!s || s.minute !== minute) {
      s = { minute, records: 0, bytes: 0, matched: 0, v6: 0, untimed: 0, longBytes: 0, sampling: 1, durations: [] };
      this.slots.push(s);
      this.slots = this.slots.filter((x) => x.minute > minute - this.minutes);
    }
    return s;
  }

  add(r: { src: string; start: number | null; end: number | null }, bytes: number, sampling: number, matched: boolean, now = Date.now()) {
    const s = this.slot(now);
    s.records++;
    s.bytes += bytes;
    if (matched) s.matched += bytes;
    if (r.src.includes(':')) s.v6++;
    s.sampling = Math.max(s.sampling, sampling);
    if (r.start === null || r.end === null || r.end < r.start) {
      s.untimed++;
      return;
    }
    const d = (r.end - r.start) / 1000;
    if (d > 120) s.longBytes += bytes;
    // Durations of the longer flows are what reveal the export timeout; keep a bounded sample.
    if (d > 60 && s.durations.length < 5000) s.durations.push(d);
  }

  snapshot(now = Date.now()): FlowDiagnostics {
    const minute = Math.floor(now / MINUTE);
    const live = this.slots.filter((x) => x.minute > minute - this.minutes);
    const sum = (k: keyof Omit<Slot, 'durations'>) => live.reduce((a, x) => a + x[k], 0);
    const durations = live.flatMap((x) => x.durations);
    const longest = durations.length ? Math.max(...durations) : 0;
    const bytes = sum('bytes');
    return {
      windowMinutes: this.minutes,
      records: sum('records'),
      bytes,
      matchedBytes: sum('matched'),
      ipv6Records: sum('v6'),
      untimedRecords: sum('untimed'),
      longestSeconds: Math.round(longest),
      longFlowByteShare: bytes ? sum('longBytes') / bytes : 0,
      atLongestRecords: longest ? durations.filter((d) => d >= longest * 0.9).length : 0,
      sampling: live.reduce((a, x) => Math.max(a, x.sampling), 1),
    };
  }
}
