import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceRequest } from './http';

const servers: net.Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

describe('deviceRequest timeouts', () => {
  it('says the connection opened but the device did not answer', async () => {
    const srv = net.createServer(() => undefined); // accepts, never answers
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    await expect(deviceRequest({ host: '127.0.0.1', port, params: { scheme: 'http', timeoutMs: 600 }, secret: {} } as never, 'GET', '/', { defaultPort: 80 })).rejects.toThrow(/Connected to 127\.0\.0\.1:\d+, but no answer within/);
  });
});
