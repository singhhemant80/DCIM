import type { IncomingMessage, Server } from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Db } from '../db/db';
import { sha256 } from './console.service';

export const CONSOLE_WS_PATH = '/api/v1/console/ws';
/** The worker's console relay listens on this local port only. */
export const consoleRelayPort = () => Number(process.env.CONSOLE_RELAY_PORT || 4011);

const reject = (socket: Duplex, status: number, text: string) => {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

/** Same-origin only: a page on another site can't use a leaked ticket from a browser. */
function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const hosts = [req.headers.host, req.headers['x-forwarded-host']].flatMap((h) => (typeof h === 'string' ? h.split(',').map((x) => x.trim()) : []));
    return hosts.includes(o.host);
  } catch {
    return false;
  }
}

/**
 * Console WebSocket. The browser presents its one-time ticket; the API
 * claims the session and pipes the bytes, unchanged, to the worker's relay on
 * 127.0.0.1, which alone connects to the BMC. The API never talks to the
 * management network and never sees a console password.
 */
export function attachConsoleGateway(server: Server, db: Db, logger: Pick<Logger, 'warn' | 'info'>) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== CONSOLE_WS_PATH) return reject(socket, 404, 'Not Found');
    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
    const sid = url.searchParams.get('session') ?? '';
    const ticket = url.searchParams.get('ticket') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(sid) || ticket.length < 20 || ticket.length > 100) return reject(socket, 401, 'Unauthorized');
    const relayToken = randomBytes(32).toString('base64url');
    void db
      .execute<{ id: string }>(
        sql`update console_sessions set status = 'connecting', ticket_hash = null, relay_hash = ${sha256(relayToken)}
             where id = ${sid} and status = 'pending' and ticket_hash = ${sha256(ticket)} and ticket_expires_at > now()
             returning id`,
      )
      .then((r) => {
        if (!r.rows.length) return reject(socket, 401, 'Unauthorized');
        wss.handleUpgrade(req, socket, head, (ws) => bridge(ws, sid, relayToken, db, logger));
      })
      .catch(() => reject(socket, 500, 'Internal Server Error'));
  });
  return wss;
}

function bridge(ws: WebSocket, sid: string, relayToken: string, db: Db, logger: Pick<Logger, 'warn'>) {
  const tcp = net.connect(consoleRelayPort(), '127.0.0.1');
  let done = false;
  const close = (code: number, reason: string) => {
    if (done) return;
    done = true;
    tcp.destroy();
    if (ws.readyState === ws.OPEN) ws.close(code, reason.slice(0, 120));
  };
  tcp.on('connect', () => tcp.write(`${sid} ${relayToken}\n`));
  tcp.on('data', (d) => {
    ws.send(d, { binary: true });
    // Backpressure: a slow browser pauses the device side.
    if (ws.bufferedAmount > 4 << 20) {
      tcp.pause();
      const t = setInterval(() => {
        if (ws.bufferedAmount < 1 << 20 || ws.readyState !== ws.OPEN) {
          clearInterval(t);
          tcp.resume();
        }
      }, 50);
    }
  });
  tcp.on('error', (e) => {
    if (!done) {
      logger.warn({ sessionId: sid, err: e.message }, 'console relay unreachable');
      void db.execute(sql`update console_sessions set status = 'failed', ended_at = now(), end_reason = 'The console relay (worker) is not running' where id = ${sid} and status in ('connecting','active')`);
    }
    close(1011, 'The console relay is not running');
  });
  tcp.on('close', () => close(1000, 'Console closed'));
  ws.on('message', (d: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d);
    tcp.write(buf);
  });
  ws.on('close', () => close(1000, 'Closed'));
  ws.on('error', () => close(1011, 'Error'));
}
