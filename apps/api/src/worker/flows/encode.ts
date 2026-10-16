/**
 * Builds NetFlow v5, v9 and IPFIX datagrams like a router's flow exporter
 * would. Used by the tests and the development flow simulator only.
 */

export interface SimFlow {
  src: string;
  dst: string;
  bytes: number;
  packets: number;
  /** Epoch ms. */
  start: number;
  end: number;
}

const v4 = (ip: string) => Buffer.from(ip.split('.').map(Number));
function v6(ip: string) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return b;
}

export function encodeV5(flows: SimFlow[], opts: { sysUptimeMs: number; nowMs: number; sampling?: number; sequence?: number }) {
  const b = Buffer.alloc(24 + flows.length * 48);
  b.writeUInt16BE(5, 0);
  b.writeUInt16BE(flows.length, 2);
  b.writeUInt32BE(opts.sysUptimeMs >>> 0, 4);
  b.writeUInt32BE(Math.floor(opts.nowMs / 1000), 8);
  b.writeUInt32BE((opts.nowMs % 1000) * 1e6, 12);
  b.writeUInt32BE(opts.sequence ?? 0, 16);
  if (opts.sampling && opts.sampling > 1) b.writeUInt16BE((1 << 14) | opts.sampling, 22);
  flows.forEach((f, i) => {
    const o = 24 + i * 48;
    v4(f.src).copy(b, o);
    v4(f.dst).copy(b, o + 4);
    b.writeUInt32BE(f.packets, o + 16);
    b.writeUInt32BE(f.bytes, o + 20);
    b.writeUInt32BE((opts.sysUptimeMs - (opts.nowMs - f.start)) >>> 0, o + 24);
    b.writeUInt32BE((opts.sysUptimeMs - (opts.nowMs - f.end)) >>> 0, o + 28);
    b[o + 38] = 6;
  });
  return b;
}

/** Template fields (id, length) as MikroTik's v9 and IPFIX exports use them. */
const V4_FIELDS: [number, number][] = [
  [8, 4], // src
  [12, 4], // dst
  [1, 4], // bytes
  [2, 4], // packets
  [22, 4], // first switched (uptime ms)
  [21, 4], // last switched
  [7, 2], // src port
  [11, 2], // dst port
  [4, 1], // protocol
];
const V6_FIELDS: [number, number][] = [
  [27, 16],
  [28, 16],
  [1, 8],
  [2, 8],
  [152, 8], // flowStartMilliseconds
  [153, 8], // flowEndMilliseconds
];

function dataRecord(f: SimFlow, fields: [number, number][], sysUptimeMs: number, nowMs: number) {
  const parts: Buffer[] = [];
  for (const [id, len] of fields) {
    const b = Buffer.alloc(len);
    switch (id) {
      case 8:
      case 12:
        v4(id === 8 ? f.src : f.dst).copy(b);
        break;
      case 27:
      case 28:
        v6(id === 27 ? f.src : f.dst).copy(b);
        break;
      case 1:
      case 2: {
        const v = id === 1 ? f.bytes : f.packets;
        if (len === 8) b.writeBigUInt64BE(BigInt(v));
        else b.writeUInt32BE(v);
        break;
      }
      case 22:
      case 21:
        b.writeUInt32BE((sysUptimeMs - (nowMs - (id === 22 ? f.start : f.end))) >>> 0);
        break;
      case 152:
      case 153:
        b.writeBigUInt64BE(BigInt(id === 152 ? f.start : f.end));
        break;
      case 4:
        b[0] = 6;
        break;
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

function set(id: number, body: Buffer) {
  const pad = (4 - ((body.length + 4) % 4)) % 4;
  const h = Buffer.alloc(4);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(body.length + 4 + pad, 2);
  return Buffer.concat([h, body, Buffer.alloc(pad)]);
}

function templateBody(id: number, fields: [number, number][]) {
  const b = Buffer.alloc(4 + fields.length * 4);
  b.writeUInt16BE(id, 0);
  b.writeUInt16BE(fields.length, 2);
  fields.forEach(([fid, len], i) => {
    b.writeUInt16BE(fid, 4 + i * 4);
    b.writeUInt16BE(len, 6 + i * 4);
  });
  return b;
}

/** A templated packet (v9 or IPFIX); with `withTemplate`, the templates are included first. */
export function encodeTemplated(version: 9 | 10, flows: SimFlow[], opts: { sysUptimeMs: number; nowMs: number; domain?: number; withTemplate?: boolean; sequence?: number; sampling?: number }) {
  const ipv6 = (f: SimFlow) => f.src.includes(':');
  const sets: Buffer[] = [];
  if (opts.withTemplate !== false) {
    const tplSet = version === 9 ? 0 : 2;
    sets.push(set(tplSet, Buffer.concat([templateBody(256, V4_FIELDS), templateBody(257, V6_FIELDS)])));
    if (opts.sampling) {
      // Options template 258 announcing 1-in-N sampling.
      if (version === 9) {
        const t = Buffer.alloc(14);
        t.writeUInt16BE(258, 0);
        t.writeUInt16BE(4, 2); // scope length
        t.writeUInt16BE(4, 4); // option length
        t.writeUInt16BE(1, 6); // scope: system
        t.writeUInt16BE(4, 8);
        t.writeUInt16BE(34, 10); // SAMPLING_INTERVAL
        t.writeUInt16BE(4, 12);
        sets.push(set(1, t));
      } else {
        const t = Buffer.alloc(14);
        t.writeUInt16BE(258, 0);
        t.writeUInt16BE(2, 2); // field count
        t.writeUInt16BE(1, 4); // scope field count
        t.writeUInt16BE(149, 6); // observationDomainId
        t.writeUInt16BE(4, 8);
        t.writeUInt16BE(305, 10); // samplingPacketInterval
        t.writeUInt16BE(4, 12);
        sets.push(set(3, t));
      }
      const d = Buffer.alloc(8);
      d.writeUInt32BE(opts.domain ?? 0, 0);
      d.writeUInt32BE(opts.sampling, 4);
      sets.push(set(258, d));
    }
  }
  const four = flows.filter((f) => !ipv6(f));
  const six = flows.filter(ipv6);
  if (four.length) sets.push(set(256, Buffer.concat(four.map((f) => dataRecord(f, V4_FIELDS, opts.sysUptimeMs, opts.nowMs)))));
  if (six.length) sets.push(set(257, Buffer.concat(six.map((f) => dataRecord(f, V6_FIELDS, opts.sysUptimeMs, opts.nowMs)))));
  const body = Buffer.concat(sets);
  const header = Buffer.alloc(version === 9 ? 20 : 16);
  header.writeUInt16BE(version, 0);
  if (version === 9) {
    header.writeUInt16BE(sets.length, 2);
    header.writeUInt32BE(opts.sysUptimeMs >>> 0, 4);
    header.writeUInt32BE(Math.floor(opts.nowMs / 1000), 8);
    header.writeUInt32BE(opts.sequence ?? 0, 12);
    header.writeUInt32BE(opts.domain ?? 0, 16);
  } else {
    header.writeUInt16BE(16 + body.length, 2);
    header.writeUInt32BE(Math.floor(opts.nowMs / 1000), 4);
    header.writeUInt32BE(opts.sequence ?? 0, 8);
    header.writeUInt32BE(opts.domain ?? 0, 12);
  }
  return Buffer.concat([header, body]);
}
