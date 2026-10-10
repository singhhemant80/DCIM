import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { Adapter, AdapterTarget, CounterSnapshot, DiscoveryResult, TestResult } from '../../network/discovery/types';
import { parseRouterOs, parseRouterOsCounters, routerosUptime } from './routeros';
import { str } from './http';

/**
 * MikroTik RouterOS API (the binary protocol on the `api` / `api-ssl`
 * services, default ports 8728 / 8729). Read-only: the client refuses to send
 * anything other than /login and `…/print` commands.
 */
type Row = Record<string, unknown>;

export class RouterOsApiError extends Error {
  constructor(
    message: string,
    readonly auth = false,
  ) {
    super(message);
  }
}

/** Encodes a word length as the API's variable-length prefix. */
export function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 0xff]);
  if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 0xff, n & 0xff]);
  if (n < 0x10000000) return Buffer.from([(n >>> 24) | 0xe0, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0xf0, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

/** Decodes one length prefix at `off`; returns null when more bytes are needed. */
export function decodeLength(b: Buffer, off: number): { len: number; size: number } | null {
  if (off >= b.length) return null;
  const c = b[off]!;
  const need = c < 0x80 ? 1 : c < 0xc0 ? 2 : c < 0xe0 ? 3 : c < 0xf0 ? 4 : 5;
  if (off + need > b.length) return null;
  if (need === 1) return { len: c, size: 1 };
  if (need === 2) return { len: ((c & 0x3f) << 8) | b[off + 1]!, size: 2 };
  if (need === 3) return { len: ((c & 0x1f) << 16) | (b[off + 1]! << 8) | b[off + 2]!, size: 3 };
  if (need === 4) return { len: ((c & 0x0f) * 0x1000000) + (b[off + 1]! << 16) + (b[off + 2]! << 8) + b[off + 3]!, size: 4 };
  return { len: b.readUInt32BE(off + 1), size: 5 };
}

export function encodeSentence(words: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const w of words) {
    const data = Buffer.from(w, 'utf8');
    parts.push(encodeLength(data.length), data);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Splits a buffer into complete sentences; returns the unconsumed remainder. */
export function decodeSentences(buf: Buffer): { sentences: string[][]; rest: Buffer } {
  const sentences: string[][] = [];
  let off = 0;
  let start = 0;
  let words: string[] = [];
  while (true) {
    const l = decodeLength(buf, off);
    if (!l || off + l.size + l.len > buf.length) break;
    off += l.size;
    if (l.len === 0) {
      sentences.push(words);
      words = [];
      start = off;
      continue;
    }
    words.push(buf.subarray(off, off + l.len).toString('utf8'));
    off += l.len;
  }
  return { sentences, rest: buf.subarray(start) };
}

const MAX_BUFFER = 32 * 1024 * 1024;

export class RouterOsApiClient {
  private sock!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiting: { resolve: (s: string[][]) => void; reject: (e: Error) => void; acc: string[][] } | null = null;
  private failure: Error | null = null;

  constructor(private readonly t: AdapterTarget) {}

  async connect(): Promise<void> {
    const timeout = this.t.params.timeoutMs ?? 5000;
    const useTls = this.t.params.tls !== false;
    const port = this.t.port ?? (useTls ? 8729 : 8728);
    const host = this.t.host.replace(/^\[|\]$/g, '');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sock?.destroy();
        reject(new RouterOsApiError(`Timed out connecting to ${this.t.host}:${port}`));
      }, timeout);
      const done = (e?: Error) => {
        clearTimeout(timer);
        if (e) reject(e);
        else resolve();
      };
      this.sock = useTls
        ? tls.connect({ host, port, rejectUnauthorized: this.t.params.verifyTls !== false, servername: net.isIP(host) ? undefined : host }, () => done())
        : net.connect({ host, port }, () => done());
      this.sock.once('error', (e: NodeJS.ErrnoException) => {
        const tlsErr = /certificate|self[- ]signed|SSL|TLS|handshake/i.test(e.message);
        done(new RouterOsApiError(tlsErr ? `TLS error: ${e.message} (assign a certificate to api-ssl, or untick certificate verification for a self-signed one)` : e.code ? `${e.code}: cannot reach ${this.t.host}:${port}` : e.message));
      });
    });
    this.sock.setTimeout(timeout, () => this.fail(new RouterOsApiError(`No reply within ${timeout} ms`)));
    this.sock.on('data', (d: Buffer) => this.onData(d));
    this.sock.on('error', (e) => this.fail(e));
    this.sock.on('close', () => this.fail(new RouterOsApiError('Connection closed by the router')));
  }

  private fail(e: Error) {
    this.failure ??= e;
    const w = this.waiting;
    this.waiting = null;
    w?.reject(this.failure);
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > MAX_BUFFER) return this.fail(new RouterOsApiError('Reply too large'));
    const { sentences, rest } = decodeSentences(this.buf);
    this.buf = rest;
    for (const s of sentences) {
      const w = this.waiting;
      if (!w) continue;
      w.acc.push(s);
      if (s[0] === '!done' || s[0] === '!fatal') {
        this.waiting = null;
        w.resolve(w.acc);
      }
    }
  }

  /** Sends one command and collects replies up to !done. */
  private send(words: string[]): Promise<string[][]> {
    const cmd = words[0] ?? '';
    // Read-only guard: nothing but login and print can ever leave this client.
    if (cmd !== '/login' && !/^\/[a-z0-9/-]+\/print$/.test(cmd)) throw new RouterOsApiError(`Refusing to send non-read command ${cmd}`);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject, acc: [] };
      this.sock.write(encodeSentence(words));
    });
  }

  private static attrs(s: string[]): Row {
    const row: Row = {};
    for (const w of s.slice(1)) {
      if (!w.startsWith('=')) continue;
      const i = w.indexOf('=', 1);
      if (i > 0) row[w.slice(1, i)] = w.slice(i + 1);
    }
    return row;
  }

  private static trap(replies: string[][]): string | null {
    const t = replies.find((s) => s[0] === '!trap' || s[0] === '!fatal');
    if (!t) return null;
    return String(RouterOsApiClient.attrs(t).message ?? t.slice(1).join(' ') ?? 'error');
  }

  async login(): Promise<void> {
    const user = String(this.t.username ?? '');
    const pass = String(this.t.secret.password ?? '');
    let r = await this.send(['/login', `=name=${user}`, `=password=${pass}`]);
    let err = RouterOsApiClient.trap(r);
    // Pre-6.43 routers answer with a challenge instead.
    const ret = r.find((s) => s[0] === '!done') && RouterOsApiClient.attrs(r.find((s) => s[0] === '!done')!).ret;
    if (!err && typeof ret === 'string' && /^[0-9a-f]{32}$/i.test(ret)) {
      const md5 = createHash('md5').update(Buffer.concat([Buffer.from([0]), Buffer.from(pass, 'utf8'), Buffer.from(ret, 'hex')])).digest('hex');
      r = await this.send(['/login', `=name=${user}`, `=response=00${md5}`]);
      err = RouterOsApiClient.trap(r);
    }
    if (err) throw new RouterOsApiError(/invalid user name or password|cannot log in|not allowed/i.test(err) ? 'Authentication failed; check the user, password and that its group has the api and read policies' : `Login failed: ${err}`, true);
  }

  /** Runs `<path>/print` and returns the rows. */
  async print(path: string): Promise<Row[]> {
    const r = await this.send([`${path}/print`]);
    const err = RouterOsApiClient.trap(r);
    if (err) throw new RouterOsApiError(`${path}: ${err}`);
    return r.filter((s) => s[0] === '!re').map(RouterOsApiClient.attrs);
  }

  close() {
    this.waiting = null;
    this.failure ??= new RouterOsApiError('closed');
    this.sock?.destroy();
  }
}

export function routerOsApiAdapter(): Adapter {
  const open = async (t: AdapterTarget) => {
    const c = new RouterOsApiClient(t);
    await c.connect();
    try {
      await c.login();
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  };
  return {
    async test(t): Promise<TestResult> {
      const started = Date.now();
      const c = await open(t);
      try {
        const [res] = await c.print('/system/resource');
        const [id] = await c.print('/system/identity').catch(() => [] as Row[]);
        return {
          ok: true,
          message: `Connected: ${str(id?.name) ?? 'RouterOS'} — ${str(res?.['board-name']) ?? ''} RouterOS ${str(res?.version) ?? '?'}`.trim(),
          latencyMs: Date.now() - started,
          facts: { sysName: str(id?.name), osVersion: str(res?.version)?.split(' ')[0] ?? null, uptimeSeconds: routerosUptime(res?.uptime), vendor: 'MikroTik' },
        };
      } finally {
        c.close();
      }
    },
    async counters(t): Promise<CounterSnapshot> {
      const c = await open(t);
      try {
        const [resource] = await c.print('/system/resource');
        const rows = await c.print('/interface');
        if (!rows.length) throw new Error('RouterOS returned no interfaces');
        return parseRouterOsCounters(resource ?? null, rows);
      } finally {
        c.close();
      }
    },
    async discover(t): Promise<DiscoveryResult> {
      const warnings: string[] = [];
      const c = await open(t);
      try {
        const list = async (path: string, label: string) => {
          try {
            return await c.print(path);
          } catch (e) {
            if ((e as RouterOsApiError).auth) throw e;
            // A failed command (feature absent, no permission) is a warning; a dead connection is fatal.
            if (!(e instanceof RouterOsApiError) || /closed|No reply|too large/.test(e.message)) throw e;
            warnings.push(`${label}: ${e.message}`);
            return [] as Row[];
          }
        };
        const [resource] = await c.print('/system/resource');
        const interfaces = await list('/interface', 'interfaces');
        if (!interfaces.length) throw new Error('RouterOS returned no interfaces');
        // Sequential: the API multiplexes with tags, but one command at a time keeps the router load low.
        const identity = (await list('/system/identity', 'identity'))[0] ?? null;
        const routerboard = (await list('/system/routerboard', 'routerboard'))[0] ?? null;
        const ethernet = await list('/interface/ethernet', 'ethernet');
        const bonding = await list('/interface/bonding', 'bonding');
        const ip = await list('/ip/address', 'IPv4 addresses');
        const ipv6 = await list('/ipv6/address', 'IPv6 addresses');
        const neighbors = await list('/ip/neighbor', 'neighbors');
        const bgp = await list('/routing/bgp/session', 'BGP sessions');
        return { source: 'routeros_api', collectedAt: new Date().toISOString(), ...parseRouterOs({ resource: resource ?? null, identity, routerboard, interfaces, ethernet, bonding, ip, ipv6, neighbors, bgp }, warnings), warnings };
      } finally {
        c.close();
      }
    },
  };
}
