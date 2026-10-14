import { assertDeviceHost } from '../device-allow';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '../../db/db';
import { consoleCredentials, devices } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { consoleContext, sha256 } from '../../console/console.service';
import { vncAuthResponse } from './des';

export interface RelayDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  port?: number;
  ipmitool?: string;
  /** End a session after this long without keyboard / mouse input. */
  idleMs?: number;
  /** End a session after this long in any case. */
  maxMs?: number;
  /** How often the session row is checked (ended from the web page or by staff). */
  checkMs?: number;
}

/** Reads exact byte counts from a socket, keeping whatever arrives early. */
class Reader {
  private buf = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private closed = false;
  constructor(private readonly sock: net.Socket) {
    sock.on('data', this.onData);
    sock.on('close', () => {
      this.closed = true;
      this.waiting?.();
    });
  }
  private onData = (d: Buffer) => {
    this.buf = Buffer.concat([this.buf, d]);
    this.waiting?.();
  };
  async read(n: number, timeoutMs = 15_000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.closed) throw new Error('Connection closed');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Timed out');
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiting = () => {
          clearTimeout(t);
          r();
        };
      });
      this.waiting = null;
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async line(max = 300, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        const s = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 1);
        return s;
      }
      if (this.buf.length > max) throw new Error('Line too long');
      await this.read(this.buf.length + 1, deadline - Date.now()).then((b) => (this.buf = Buffer.concat([b, this.buf])));
    }
  }
  /** Stops buffering and returns what is left; later data goes to the caller's handler. */
  detach(): Buffer {
    this.sock.off('data', this.onData);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

/** RFB: connects and authenticates to the BMC's VNC server, up to the point where ClientInit is due. */
export async function connectVnc(host: string, port: number, password: string): Promise<{ sock: net.Socket; reader: Reader }> {
  const sock = net.connect({ host, port });
  sock.setNoDelay(true);
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => (sock.destroy(), fail(new Error(`Could not connect to ${host}:${port} (VNC) within 10 s`))), 10_000);
    sock.once('connect', () => (clearTimeout(t), ok()));
    sock.once('error', (e) => (clearTimeout(t), fail(new Error(`Could not connect to ${host}:${port} (VNC): ${e.message}`))));
  });
  const r = new Reader(sock);
  try {
    const ver = (await r.read(12)).toString('latin1');
    const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(ver);
    if (!m) throw new Error('The BMC did not answer as a VNC server');
    const minor = Number(m[2]);
    const v38 = minor >= 8;
    sock.write(v38 ? 'RFB 003.008\n' : minor >= 7 ? 'RFB 003.007\n' : 'RFB 003.003\n');
    let type: number;
    if (minor >= 7) {
      const count = (await r.read(1))[0]!;
      if (count === 0) {
        const len = (await r.read(4)).readUInt32BE(0);
        throw new Error(`The VNC server refused: ${(await r.read(Math.min(len, 1000))).toString('utf8')}`);
      }
      const types = [...(await r.read(count))];
      type = types.includes(2) ? 2 : types.includes(1) ? 1 : -1;
      if (type < 0) throw new Error(`The VNC server offers no supported authentication (types ${types.join(', ')}); turn off VNC SSL encryption on the BMC`);
      sock.write(Buffer.from([type]));
    } else {
      type = (await r.read(4)).readUInt32BE(0);
      if (type !== 1 && type !== 2) throw new Error('The VNC server refused the connection');
    }
    if (type === 2) {
      sock.write(vncAuthResponse(password, await r.read(16)));
    }
    if (type === 2 || v38) {
      const result = (await r.read(4)).readUInt32BE(0);
      if (result !== 0) {
        let why = '';
        if (v38) {
          const len = (await r.read(4)).readUInt32BE(0);
          why = (await r.read(Math.min(len, 1000))).toString('utf8');
        }
        throw new Error(`The BMC refused the VNC password${why ? `: ${why}` : ''}`);
      }
    }
    return { sock, reader: r };
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

/**
 * The browser side of RFB: we present ourselves as a VNC server that needs no
 * password (the real password stays here), then hand over to plain piping.
 * When the BMC side failed, the browser is told why in the RFB failure reason.
 */
async function browserHandshake(client: Reader, sock: net.Socket, failure?: string): Promise<boolean> {
  sock.write('RFB 003.008\n');
  await client.read(12);
  if (failure) {
    const reason = Buffer.from(failure.slice(0, 300), 'utf8');
    const head = Buffer.alloc(5);
    head.writeUInt8(0, 0);
    head.writeUInt32BE(reason.length, 1);
    sock.end(Buffer.concat([head, reason]));
    return false;
  }
  sock.write(Buffer.from([1, 1]));
  const choice = (await client.read(1))[0];
  if (choice !== 1) throw new Error('Unexpected security type from the browser');
  sock.write(Buffer.from([0, 0, 0, 0]));
  return true;
}

/**
 * Console relay, in the worker: the only process that connects to BMCs.
 * Listens on 127.0.0.1 only; the API hands over each browser connection
 * with the session id and a single-use relay token.
 */
export async function startConsoleRelay(deps: RelayDeps): Promise<{ port: number; close: () => Promise<void> }> {
  const { db, logger } = deps;
  const idleMs = deps.idleMs ?? 15 * 60_000;
  const maxMs = deps.maxMs ?? 8 * 3600_000;
  const checkMs = deps.checkMs ?? 5000;
  // Sessions cut off by a worker restart are closed, not left "active".
  await db.execute(sql`update console_sessions set status = 'ended', ended_at = now(), end_reason = 'The worker restarted' where status in ('connecting', 'active')`);

  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => undefined);
    void handle(client).catch((e) => {
      logger.warn({ err: (e as Error).message }, 'console relay connection failed');
      client.destroy();
    });
  });

  async function handle(client: net.Socket) {
    client.setNoDelay(true);
    const reader = new Reader(client);
    const [sid, token] = (await reader.line()).trim().split(' ');
    if (!sid || !token) return client.destroy();
    const claimed = await db.execute<{ org_id: string; device_id: string; kind: string; user_label: string }>(sql`
      update console_sessions set status = 'active', connected_at = now(), relay_hash = null
       where id = ${sid} and status = 'connecting' and relay_hash = ${sha256(token)}
       returning org_id, device_id, kind, user_label`);
    const s = claimed.rows[0];
    if (!s) return client.destroy();
    const started = Date.now();
    let lastInput = Date.now();
    let bytesIn = 0;
    let bytesOut = 0;
    let ended = false;
    let device: net.Socket | null = null;
    let child: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;
    const finish = async (status: 'ended' | 'failed', reason: string) => {
      if (ended) return;
      ended = true;
      if (timer) clearInterval(timer);
      device?.destroy();
      if (child && child.exitCode === null) child.kill('SIGTERM');
      if (s.kind === 'sol' && !client.destroyed) client.write(`\r\n[NexoraDC] ${reason}\r\n`);
      client.end();
      await db
        .execute(sql`update console_sessions set status = case when status = 'active' then ${status} else status end, ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, ${reason.slice(0, 300)}), bytes_in = ${bytesIn}, bytes_out = ${bytesOut} where id = ${sid}`)
        .catch(() => undefined);
      logger.info({ sessionId: sid, kind: s.kind, reason, seconds: Math.round((Date.now() - started) / 1000) }, 'console session ended');
    };
    client.on('close', () => void finish('ended', 'Closed by the user'));

    const [cred] = await db.select().from(consoleCredentials).where(and(eq(consoleCredentials.deviceId, s.device_id), eq(consoleCredentials.kind, s.kind)));
    const [dev] = await db.select({ mgmtAddress: devices.mgmtAddress }).from(devices).where(eq(devices.id, s.device_id));
    const host = cred?.host ?? dev?.mgmtAddress?.trim() ?? null;
    let password = '';
    try {
      if (!cred?.secretEnc || !host) throw new Error('This console is not set up');
      password = String((JSON.parse(deps.secrets.decrypt(cred.secretEnc, consoleContext(cred.orgId, cred.deviceId, cred.kind, cred.host, cred.port))) as { password?: string }).password ?? '');
    } catch (e) {
      if (s.kind === 'vnc') await browserHandshake(reader, client, (e as Error).message).catch(() => undefined);
      return finish('failed', (e as Error).message);
    }
    const hide = (m: string) => (password ? m.split(password).join('***') : m);

    // Watch for: session ended from the web page or by staff, idle, maximum length.
    timer = setInterval(() => {
      if (Date.now() - lastInput > idleMs) return void finish('ended', `No input for ${Math.round(idleMs / 60_000)} minutes`);
      if (Date.now() - started > maxMs) return void finish('ended', `Maximum session length (${Math.round(maxMs / 3600_000)} h) reached`);
      void db
        .execute<{ status: string; end_reason: string | null }>(sql`select status, end_reason from console_sessions where id = ${sid}`)
        .then((r) => {
          const row = r.rows[0];
          if (!row || row.status !== 'active') void finish('ended', row?.end_reason ?? 'Ended');
        })
        .catch(() => undefined);
    }, checkMs);

    if (s.kind === 'vnc') {
      let vnc: Awaited<ReturnType<typeof connectVnc>>;
      try {
        await assertDeviceHost(host);
        vnc = await connectVnc(host, cred!.port ?? 5901, password);
      } catch (e) {
        const msg = hide((e as Error).message);
        await browserHandshake(reader, client, msg).catch(() => undefined);
        return finish('failed', msg);
      }
      device = vnc.sock;
      if (!(await browserHandshake(reader, client).catch(() => false))) return finish('failed', 'The browser closed during the handshake');
      // From ClientInit on, RFB is passed through unchanged in both directions.
      const early = reader.detach();
      const fromDevice = vnc.reader.detach();
      if (early.length) ((bytesIn += early.length), (lastInput = Date.now()), device.write(early));
      if (fromDevice.length) ((bytesOut += fromDevice.length), client.write(fromDevice));
      client.on('data', (d) => {
        bytesIn += d.length;
        lastInput = Date.now();
        device!.write(d);
      });
      device.on('data', (d) => {
        bytesOut += d.length;
        if (!client.write(d)) device!.pause();
      });
      client.on('drain', () => device?.resume());
      device.on('close', () => void finish('ended', 'The BMC closed the console'));
      device.on('error', (e) => void finish('failed', hide(e.message)));
      return;
    }

    // Serial-over-LAN through ipmitool; the password only in its environment.
    const bin = deps.ipmitool || process.env.IPMITOOL_PATH || 'ipmitool';
    const base = ['-I', 'lanplus', '-H', host, '-p', String(cred!.port ?? 623), '-U', cred!.username ?? '', '-E', '-L', String(cred!.params.privilege ?? 'ADMINISTRATOR')];
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', IPMI_PASSWORD: password };
    try {
      await assertDeviceHost(host);
    } catch (e) {
      client.write(`[NexoraDC] ${hide((e as Error).message)}\r\n`);
      return finish('failed', hide((e as Error).message));
    }
    client.write(`[NexoraDC] Connecting to the serial console of ${host}…\r\n`);
    // A previous session left open on the BMC would block this one.
    await new Promise<void>((r) => execFile(bin, [...base, 'sol', 'deactivate'], { env, timeout: 15_000 }, () => r()));
    if (ended) return;
    const c = spawn(bin, [...base, 'sol', 'activate'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child = c;
    let stderr = '';
    c.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
    const early = reader.detach();
    if (early.length) c.stdin!.write(early);
    client.on('data', (d) => {
      bytesIn += d.length;
      lastInput = Date.now();
      c.stdin!.write(d);
    });
    c.stdout!.on('data', (d: Buffer) => {
      bytesOut += d.length;
      if (!client.write(d)) c.stdout!.pause();
    });
    client.on('drain', () => c.stdout!.resume());
    c.on('error', (e) => void finish('failed', (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ipmitool is not installed on the worker host (apt install ipmitool)' : hide(e.message)));
    c.on('exit', (code) => void finish(code === 0 ? 'ended' : 'failed', code === 0 ? 'The serial console closed' : `Serial console stopped: ${hide(stderr.trim().split('\n').pop() || `ipmitool exited with ${code}`)}`));
  }

  const port = deps.port ?? Number(process.env.CONSOLE_RELAY_PORT || 4011);
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok());
  });
  const actual = (server.address() as net.AddressInfo).port;
  logger.info({ port: actual }, 'console relay listening on 127.0.0.1');
  return {
    port: actual,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
