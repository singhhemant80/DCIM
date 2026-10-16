/**
 * NetFlow v5, NetFlow v9 and IPFIX decoding (RFC 3954, RFC 7011), the formats
 * MikroTik RouterOS "Traffic Flow" exports. Only what per-IP bandwidth needs
 * is kept: addresses, bytes, packets, the flow's start and end, and the
 * sampling rate. Templates are remembered per exporter and observation domain.
 * Everything arrives over unauthenticated UDP, so every length is checked and a
 * malformed packet is rejected as a whole, never half-read.
 */

export interface FlowRecord {
  src: string;
  dst: string;
  bytes: number;
  packets: number;
  /** Epoch milliseconds, when the exporter said (null: use the arrival time). */
  start: number | null;
  end: number | null;
  /** 1 = every packet; N = one in N packets was counted (multiply by N). */
  sampling: number;
}

interface TemplateField {
  id: number;
  length: number; // 65535 = variable length (IPFIX)
  enterprise: boolean;
}
interface Template {
  fields: TemplateField[];
  /** Options templates carry exporter settings such as the sampling interval. */
  options: boolean;
  at: number;
}

export class FlowDecodeError extends Error {}

const MAX_TEMPLATES = 4096;
const TEMPLATE_TTL_MS = 6 * 3600_000;

/** Templates and sampling settings learned from each exporter. */
export class TemplateCache {
  private templates = new Map<string, Template>();
  private sampling = new Map<string, number>();

  get(key: string) {
    const t = this.templates.get(key);
    if (t && Date.now() - t.at > TEMPLATE_TTL_MS) {
      this.templates.delete(key);
      return undefined;
    }
    return t;
  }
  set(key: string, t: Template) {
    if (this.templates.size >= MAX_TEMPLATES && !this.templates.has(key)) {
      // Drop the oldest; a busy or misbehaving exporter cannot grow this without bound.
      const first = this.templates.keys().next().value;
      if (first !== undefined) this.templates.delete(first);
    }
    this.templates.set(key, t);
  }
  setSampling(exporter: string, n: number) {
    if (Number.isFinite(n) && n >= 1 && n <= 1_000_000) this.sampling.set(exporter, Math.round(n));
  }
  samplingOf(exporter: string) {
    return this.sampling.get(exporter) ?? 1;
  }
  count() {
    return this.templates.size;
  }
}

const ipv4 = (b: Buffer, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
function ipv6(b: Buffer, o: number) {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(o + i).toString(16));
  // Compress the longest run of zero groups, as in the canonical form.
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (parts[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && parts[j] === '0') j++;
    if (j - i > bestLen && j - i > 1) (best = i), (bestLen = j - i);
    i = j;
  }
  if (best < 0) return parts.join(':');
  const head = parts.slice(0, best).join(':');
  const tail = parts.slice(best + bestLen).join(':');
  return `${head}::${tail}`;
}

/** Unsigned big-endian integer of 1–8 bytes (as a JS number; exact below 2^53). */
function uint(b: Buffer, o: number, len: number): number {
  if (len === 1) return b[o]!;
  if (len === 2) return b.readUInt16BE(o);
  if (len === 4) return b.readUInt32BE(o);
  if (len === 8) return Number(b.readBigUInt64BE(o));
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[o + i]!;
  return v;
}

function need(b: Buffer, end: number) {
  if (end > b.length) throw new FlowDecodeError('truncated packet');
}

/* ------------------------------------------------------------- NetFlow v5 */

function decodeV5(b: Buffer, exporter: string): FlowRecord[] {
  need(b, 24);
  const count = b.readUInt16BE(2);
  if (count < 1 || count > 30) throw new FlowDecodeError('bad v5 record count');
  need(b, 24 + count * 48);
  const sysUptime = b.readUInt32BE(4);
  const unixMs = b.readUInt32BE(8) * 1000 + Math.floor(b.readUInt32BE(12) / 1e6);
  const samplingField = b.readUInt16BE(22);
  const sampling = samplingField & 0x3fff || 1;
  const out: FlowRecord[] = [];
  for (let i = 0; i < count; i++) {
    const o = 24 + i * 48;
    const first = b.readUInt32BE(o + 24);
    const last = b.readUInt32BE(o + 28);
    out.push({
      src: ipv4(b, o),
      dst: ipv4(b, o + 4),
      packets: b.readUInt32BE(o + 16),
      bytes: b.readUInt32BE(o + 20),
      start: unixMs - (sysUptime - first),
      end: unixMs - (sysUptime - last),
      sampling: sampling > 1 ? sampling : 0,
    });
  }
  return finish(out, exporter, null);
}

/* -------------------------------------------------- NetFlow v9 and IPFIX */

const F = {
  IN_BYTES: 1,
  IN_PKTS: 2,
  IPV4_SRC: 8,
  IPV4_DST: 12,
  LAST_SWITCHED: 21,
  FIRST_SWITCHED: 22,
  OUT_BYTES: 23,
  OUT_PKTS: 24,
  IPV6_SRC: 27,
  IPV6_DST: 28,
  SAMPLING_INTERVAL: 34,
  START_SEC: 150,
  END_SEC: 151,
  START_MS: 152,
  END_MS: 153,
  SYS_INIT_MS: 160,
  SAMPLING_PACKET_INTERVAL: 305,
  SAMPLING_PACKET_SPACE: 306,
} as const;

function readTemplates(b: Buffer, start: number, end: number, ipfix: boolean, options: boolean, keyBase: string, cache: TemplateCache) {
  let o = start;
  while (o + 4 <= end) {
    const id = b.readUInt16BE(o);
    const fieldCount = b.readUInt16BE(o + 2);
    o += 4;
    let scopeCount = 0;
    if (options) {
      if (ipfix) {
        // IPFIX options template: field count includes the scope fields.
        need(b, o + 2);
        scopeCount = b.readUInt16BE(o);
        o += 2;
      } else {
        // v9 options template: scope and option lengths are in bytes.
        const scopeLen = fieldCount; // reinterpretation below
        need(b, o + 2);
        const optionLen = b.readUInt16BE(o);
        o += 2;
        const fields: TemplateField[] = [];
        for (let k = 0; k < (scopeLen + optionLen) / 4; k++) {
          need(b, o + 4);
          fields.push({ id: b.readUInt16BE(o), length: b.readUInt16BE(o + 2), enterprise: false });
          o += 4;
        }
        if (id >= 256) cache.set(`${keyBase}|${id}`, { fields, options: true, at: Date.now() });
        // v9 options templates are padded to 4 bytes inside the flowset.
        continue;
      }
    }
    if (id < 256 || fieldCount === 0 || fieldCount > 512) {
      // Template withdrawal or nonsense: nothing more can be read safely from this set.
      return;
    }
    const fields: TemplateField[] = [];
    for (let k = 0; k < fieldCount; k++) {
      need(b, o + 4);
      let fid = b.readUInt16BE(o);
      const len = b.readUInt16BE(o + 2);
      o += 4;
      let enterprise = false;
      if (ipfix && fid & 0x8000) {
        need(b, o + 4);
        enterprise = true;
        fid &= 0x7fff;
        o += 4;
      }
      fields.push({ id: fid, length: len, enterprise });
    }
    void scopeCount;
    cache.set(`${keyBase}|${id}`, { fields, options, at: Date.now() });
  }
}

function readData(b: Buffer, start: number, end: number, t: Template, ctx: { exportMs: number; sysUptime: number | null; exporter: string; cache: TemplateCache }, out: FlowRecord[]) {
  // Shortest possible record (a variable-length field takes at least its 1-byte length).
  const minLen = t.fields.reduce((a, f) => a + (f.length === 65535 ? 1 : f.length), 0);
  if (minLen === 0) return;
  let o = start;
  let guard = 0;
  while (o < end && guard++ < 10_000) {
    if (o + minLen > end) break; // set padding
    let src: string | null = null;
    let dst: string | null = null;
    let bytes: number | null = null;
    let outBytes: number | null = null;
    let packets: number | null = null;
    let outPackets: number | null = null;
    let first: number | null = null;
    let last: number | null = null;
    let startMs: number | null = null;
    let endMs: number | null = null;
    let initMs: number | null = null;
    let sampling = 0;
    let space: number | null = null;
    for (const f of t.fields) {
      let len = f.length;
      if (len === 65535) {
        need(b, o + 1);
        len = b[o]!;
        o += 1;
        if (len === 255) {
          need(b, o + 2);
          len = b.readUInt16BE(o);
          o += 2;
        }
      }
      need(b, o + len);
      if (!f.enterprise) {
        switch (f.id) {
          case F.IPV4_SRC:
            if (len === 4) src = ipv4(b, o);
            break;
          case F.IPV4_DST:
            if (len === 4) dst = ipv4(b, o);
            break;
          case F.IPV6_SRC:
            if (len === 16) src = ipv6(b, o);
            break;
          case F.IPV6_DST:
            if (len === 16) dst = ipv6(b, o);
            break;
          case F.IN_BYTES:
            if (len <= 8) bytes = uint(b, o, len);
            break;
          case F.OUT_BYTES:
            if (len <= 8) outBytes = uint(b, o, len);
            break;
          case F.IN_PKTS:
            if (len <= 8) packets = uint(b, o, len);
            break;
          case F.OUT_PKTS:
            if (len <= 8) outPackets = uint(b, o, len);
            break;
          case F.FIRST_SWITCHED:
            if (len === 4) first = b.readUInt32BE(o);
            break;
          case F.LAST_SWITCHED:
            if (len === 4) last = b.readUInt32BE(o);
            break;
          case F.START_SEC:
            if (len === 4) startMs = b.readUInt32BE(o) * 1000;
            break;
          case F.END_SEC:
            if (len === 4) endMs = b.readUInt32BE(o) * 1000;
            break;
          case F.START_MS:
            if (len === 8) startMs = uint(b, o, 8);
            break;
          case F.END_MS:
            if (len === 8) endMs = uint(b, o, 8);
            break;
          case F.SYS_INIT_MS:
            if (len === 8) initMs = uint(b, o, 8);
            break;
          case F.SAMPLING_INTERVAL:
          case F.SAMPLING_PACKET_INTERVAL:
            if (len <= 4) sampling = uint(b, o, len);
            break;
          case F.SAMPLING_PACKET_SPACE:
            if (len <= 4) space = uint(b, o, len);
            break;
        }
      }
      o += len;
    }
    if (t.options) {
      // Exporter settings: 1-in-N sampling (interval, or packet interval + space).
      const n = space !== null && sampling > 0 ? (sampling + space) / sampling : sampling;
      if (n >= 1) ctx.cache.setSampling(ctx.exporter, n);
      continue;
    }
    if (!src || !dst) continue;
    const by = bytes ?? outBytes;
    if (by === null) continue;
    let s: number | null = startMs;
    let e: number | null = endMs;
    if (s === null && first !== null) {
      if (initMs !== null) s = initMs + first;
      else if (ctx.sysUptime !== null) s = ctx.exportMs - (ctx.sysUptime - first);
    }
    if (e === null && last !== null) {
      if (initMs !== null) e = initMs + last;
      else if (ctx.sysUptime !== null) e = ctx.exportMs - (ctx.sysUptime - last);
    }
    out.push({ src, dst, bytes: by, packets: packets ?? outPackets ?? 0, start: s, end: e, sampling });
  }
}

function decodeTemplated(b: Buffer, version: 9 | 10, exporter: string, cache: TemplateCache): FlowRecord[] {
  const ipfix = version === 10;
  const headerLen = ipfix ? 16 : 20;
  need(b, headerLen);
  let end = b.length;
  let exportMs: number;
  let sysUptime: number | null;
  let domain: number;
  if (ipfix) {
    end = b.readUInt16BE(2);
    if (end < headerLen || end > b.length) throw new FlowDecodeError('bad IPFIX length');
    exportMs = b.readUInt32BE(4) * 1000;
    sysUptime = null;
    domain = b.readUInt32BE(12);
  } else {
    sysUptime = b.readUInt32BE(4);
    exportMs = b.readUInt32BE(8) * 1000;
    domain = b.readUInt32BE(16);
  }
  const keyBase = `${exporter}|${version}|${domain}`;
  const out: FlowRecord[] = [];
  let o = headerLen;
  let sets = 0;
  while (o + 4 <= end && sets++ < 256) {
    const setId = b.readUInt16BE(o);
    const setLen = b.readUInt16BE(o + 2);
    if (setLen < 4 || o + setLen > end) throw new FlowDecodeError('bad set length');
    const body = o + 4;
    const setEnd = o + setLen;
    if ((!ipfix && setId === 0) || (ipfix && setId === 2)) readTemplates(b, body, setEnd, ipfix, false, keyBase, cache);
    else if ((!ipfix && setId === 1) || (ipfix && setId === 3)) readTemplates(b, body, setEnd, ipfix, true, keyBase, cache);
    else if (setId >= 256) {
      const t = cache.get(`${keyBase}|${setId}`);
      // Data before its template (e.g. right after a collector restart) cannot be read; the
      // exporter resends templates periodically.
      if (t) readData(b, body, setEnd, t, { exportMs, sysUptime, exporter, cache }, out);
    }
    o = setEnd;
  }
  return finish(out, exporter, cache);
}

function finish(out: FlowRecord[], exporter: string, cache: TemplateCache | null) {
  const learned = cache?.samplingOf(exporter) ?? 1;
  for (const r of out) if (!r.sampling || r.sampling < 1) r.sampling = learned;
  return out;
}

/** Decodes one UDP datagram from an exporter. Throws FlowDecodeError when it is malformed. */
export function decodeFlowPacket(b: Buffer, exporter: string, cache: TemplateCache): { version: number; records: FlowRecord[] } {
  if (b.length < 4) throw new FlowDecodeError('packet too short');
  const version = b.readUInt16BE(0);
  if (version === 5) return { version, records: decodeV5(b, exporter) };
  if (version === 9 || version === 10) return { version, records: decodeTemplated(b, version, exporter, cache) };
  throw new FlowDecodeError(`unsupported flow version ${version}`);
}
