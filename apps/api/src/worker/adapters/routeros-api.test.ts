import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterOsApiClient } from './routeros-api';

const servers: net.Server[] = [];
async function serve(onConn: (s: net.Socket) => void): Promise<number> {
  const srv = net.createServer(onConn);
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return (srv.address() as net.AddressInfo).port;
}
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function loginTo(port: number) {
  const c = new RouterOsApiClient({ host: '127.0.0.1', port, params: { tls: false, timeoutMs: 2000 }, secret: { username: 'dcim', password: 'x' } } as never);
  await c.connect();
  return c.login();
}

describe('RouterOS API connection errors', () => {
  it('names the web service when the port answers HTTP (www / www-ssl)', async () => {
    const port = await serve((s) => s.once('data', () => s.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n')));
    await expect(loginTo(port)).rejects.toThrow(/web \(HTTP\) service.*REST API/);
  });

  it('explains a silent close before any answer (wrong port, service disabled or address-restricted)', async () => {
    const port = await serve((s) => s.once('data', () => s.destroy()));
    await expect(loginTo(port)).rejects.toThrow(new RegExp(`port ${port} before it answered.*8729.*address=`));
  });
});
