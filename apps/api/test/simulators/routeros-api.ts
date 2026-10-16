import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { decodeSentences, encodeSentence } from '../../src/worker/adapters/routeros-api';
import { ROUTEROS_FIXTURE } from './http-devices';

/**
 * A TCP server speaking the MikroTik RouterOS API protocol (plain `api`
 * service), answering /login and `…/print` from the same fixture as the REST
 * mock. It records every command received so tests can prove the client
 * only ever reads.
 */
export interface MockApi {
  port: number;
  commands: string[][];
  close: () => Promise<void>;
}

/**
 * `torch`: rows the read-only Torch monitor streams (a new `.section` every `everyMs`),
 * like `/tool/torch interface=… src-address=0.0.0.0/0 dst-address=0.0.0.0/0`.
 */
export async function startRouterOsApi(user: string, pass: string, fixture: Record<string, unknown> = ROUTEROS_FIXTURE, opts: { torch?: { rows: Record<string, unknown>[] | (() => Record<string, unknown>[]); everyMs?: number }; port?: number } = {}): Promise<MockApi> {
  const commands: string[][] = [];
  const sockets = new Set<net.Socket>();
  const torchTimers = new Set<NodeJS.Timeout>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    let authed = false;
    const send = (...sentences: string[][]) => sock.write(Buffer.concat(sentences.map(encodeSentence)));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const { sentences, rest } = decodeSentences(buf);
      buf = rest;
      for (const s of sentences) {
        commands.push(s.map((w) => (w.startsWith('=password=') ? '=password=***' : w)));
        const attrs = Object.fromEntries(s.slice(1).filter((w) => w.startsWith('=')).map((w) => [w.slice(1, w.indexOf('=', 1)), w.slice(w.indexOf('=', 1) + 1)]));
        if (s[0] === '/login') {
          if (attrs.name === user && attrs.password === pass) {
            authed = true;
            send(['!done']);
          } else send(['!trap', '=message=invalid user name or password (6)'], ['!done']);
          continue;
        }
        if (!authed) {
          send(['!fatal', 'not logged in']);
          sock.end();
          continue;
        }
        if (s[0] === '/tool/torch') {
          const tag = s.find((w) => w.startsWith('.tag='))?.slice(5) ?? '';
          if (!opts.torch) {
            send(['!trap', '=message=no such command', `.tag=${tag}`], ['!done', `.tag=${tag}`]);
            continue;
          }
          let section = 0;
          const timer = setInterval(() => {
            if (sock.destroyed) return clearInterval(timer);
            const rows = typeof opts.torch!.rows === 'function' ? opts.torch!.rows() : opts.torch!.rows;
            send(...rows.map((r) => ['!re', ...Object.entries(r).map(([k, v]) => `=${k}=${String(v)}`), `=.section=${section}`, `.tag=${tag}`]));
            section++;
          }, opts.torch.everyMs ?? 1000);
          torchTimers.add(timer);
          sock.on('close', () => clearInterval(timer));
          continue;
        }
        if (s[0] === '/cancel') {
          torchTimers.forEach(clearInterval);
          const tag = attrs.tag ?? '';
          send(['!trap', '=category=2', '=message=interrupted', `.tag=${tag}`], ['!done', `.tag=${tag}`], ['!done']);
          continue;
        }
        const m = /^(\/.*)\/print$/.exec(s[0] ?? '');
        const data = m ? fixture[`/rest${m[1]}`] : undefined;
        if (!m || data === undefined) {
          send(['!trap', '=message=no such command prefix'], ['!done']);
          continue;
        }
        const rows = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
        send(...rows.map((r) => ['!re', ...Object.entries(r).map(([k, v]) => `=${k}=${String(v)}`)]), ['!done']);
      }
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    commands,
    close: () =>
      new Promise((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}
