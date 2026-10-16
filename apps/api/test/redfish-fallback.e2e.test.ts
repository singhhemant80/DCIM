import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { deviceRequest } from '../src/worker/adapters/http';
import { redfishAdapter } from '../src/worker/adapters/redfish';
import { deviceErrorText } from '../src/worker/adapters/http';
import { startRedfish } from './simulators/power-devices';

const target = (port: number, password = 'pw') => ({ host: '127.0.0.1', port, username: 'root', params: { scheme: 'http' as const }, secret: { password } }) as never;

describe('Redfish when the BMC fails on its system list', () => {
  it('reads the system at the known iDRAC path and says the list failed', async () => {
    const sim = await startRedfish('root', 'pw', { systemsError: 500 });
    try {
      const r = await redfishAdapter().test(target(sim.port));
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/^Connected: Dell/);
      expect(r.message).toMatch(/system list failed \(HTTP 500 from \/redfish\/v1\/Systems: Unable to complete the operation because of an internal error\. Retry the operation\. If the issue persists, reset iDRAC\.\)/);
      expect(r.message).toMatch(/System\.Embedded\.1 was read directly/);
      // Only GET requests went to the BMC.
      expect(sim.requests.every((q) => q.method === 'GET')).toBe(true);
    } finally {
      await sim.close();
    }
  });

  it('hardware inventory still works and carries the note as a warning', async () => {
    const sim = await startRedfish('root', 'pw', { systemsError: 500 });
    try {
      const inv = await redfishAdapter().hardware!(target(sim.port));
      expect(inv.memory.length).toBeGreaterThan(0);
      expect(inv.warnings.join('\n')).toMatch(/system list failed/);
    } finally {
      await sim.close();
    }
  });

  it('a wrong password is still an authentication error, not a fallback', async () => {
    const sim = await startRedfish('root', 'pw', { systemsError: 500 });
    try {
      await expect(redfishAdapter().test(target(sim.port, 'wrong'))).rejects.toThrow(/Authentication failed \(HTTP 401\)/);
    } finally {
      await sim.close();
    }
  });

  it('follows a redirect on the same host (e.g. /Systems to /Systems/)', async () => {
    const sim = await startRedfish('root', 'pw', { redirectSystems: 'slash' });
    try {
      const r = await redfishAdapter().test(target(sim.port));
      expect(r.ok).toBe(true);
      expect(r.message).not.toMatch(/Note/);
    } finally {
      await sim.close();
    }
  });

  it('a redirect to HTTPS is reported with what to change, not followed', async () => {
    const sim = await startRedfish('root', 'pw', { redirectSystems: 'https' });
    try {
      // The known system path still answers, so the test connects and says why the list failed.
      const r = await redfishAdapter().test(target(sim.port));
      expect(r.message).toMatch(/redirected \(HTTP 301\) to https:\/\/127\.0\.0\.1:8443\/redfish\/v1\/Systems; set this credential's protocol to HTTPS and port 8443/);
      expect(sim.requests.some((q) => q.url.includes('8443'))).toBe(false);
    } finally {
      await sim.close();
    }
  });

  it('accepts absolute member links, using only their path on the credential host', async () => {
    const sim = await startRedfish('root', 'pw', { absoluteLinks: true });
    try {
      const r = await redfishAdapter().test(target(sim.port));
      expect(r.ok).toBe(true);
      expect(r.message).not.toMatch(/Note/);
    } finally {
      await sim.close();
    }
  });

  it('uses a fresh connection per request and retries one reset', async () => {
    let n = 0;
    const perSocket = new WeakMap<object, number>();
    const server = http.createServer((req, res) => {
      const c = (perSocket.get(req.socket) ?? 0) + 1;
      perSocket.set(req.socket, c);
      // Like a BMC that drops reused keep-alive sockets, and resets the very first connection.
      if (c > 1 || ++n === 1) return req.socket.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ n }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const t = { host: '127.0.0.1', port, username: 'u', params: { scheme: 'http' }, secret: {} } as never;
      for (let i = 0; i < 3; i++) expect((await deviceRequest(t, 'GET', '/x', { defaultPort: 80 })).status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('a device that keeps resetting gets a clear message', async () => {
    const server = http.createServer((req) => req.socket.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const t = { host: '127.0.0.1', port, username: 'u', params: { scheme: 'http' }, secret: {} } as never;
      await expect(deviceRequest(t, 'GET', '/x', { defaultPort: 80 })).rejects.toThrow(/closed the connection \(twice\)\. The device is reachable/);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('uses a complete answer even when the device sends bytes after Connection: close (older iDRAC)', async () => {
    const body = JSON.stringify({ '@odata.id': '/redfish/v1', Product: 'Integrated Dell Remote Access Controller', pad: 'x'.repeat(5000) });
    const server = net.createServer((sock) => {
      sock.once('data', () => {
        sock.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}\r\n\r\n0\r\n\r\n`);
        setTimeout(() => sock.end(), 20);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const t = { host: '127.0.0.1', port, username: 'u', params: { scheme: 'http' }, secret: {} } as never;
      for (let i = 0; i < 5; i++) {
        const r = await deviceRequest(t, 'GET', '/redfish/v1/', { defaultPort: 80 });
        expect((r.json as { Product: string }).Product).toBe('Integrated Dell Remote Access Controller');
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('old iDRAC 8 with broken Redfish: test, hardware and power come over WS-Man', async () => {
    const sim = await startRedfish('root', 'pw', { brokenRedfish: true, watts: 188 });
    try {
      const a = redfishAdapter();
      const r = await a.test(target(sim.port));
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/^Connected over WS-Man: Dell Inc\. PowerEdge R630 \(service tag SIM630X\), power On\./);
      expect(r.message).toMatch(/HTTP 500 from \/redfish\/v1\/Systems: internal error:/);
      expect(r.facts?.serial).toBe('SIM630X');

      const inv = await a.hardware!(target(sim.port));
      expect(inv.source).toBe('WS-Man');
      expect(inv.system).toMatchObject({ model: 'PowerEdge R630', serial: 'SIM630X', powerState: 'On', cpuCount: 2, logicalCpus: 56, memoryGb: 96, biosVersion: '2.17.0' });
      expect(inv.processors).toHaveLength(2);
      expect(inv.memory).toHaveLength(3);
      expect(inv.drives[0]).toMatchObject({ model: 'ST600MM0088', mediaType: 'HDD', protocol: 'SAS', capacityGb: 599.6, failurePredicted: false, health: 'OK' });
      expect(inv.controllers[0]).toMatchObject({ model: 'PERC H730P Mini', firmware: '25.5.9.0001' });
      expect(inv.volumes[0]).toMatchObject({ raid: 'RAID1', capacityGb: 598.9 });
      expect(inv.psus).toHaveLength(2);
      expect(inv.nics[0]).toMatchObject({ mac: '24:6E:96:00:00:01', speedMbps: 10000 });
      expect(inv.temperatures[0]).toMatchObject({ celsius: 23, upperCritical: 47 });
      expect(inv.fans[0]).toMatchObject({ reading: 5040, units: 'RPM' });
      expect(inv.bmc).toEqual({ model: 'Enterprise', firmware: '2.30.30.30' });
      expect(inv.warnings[0]).toMatch(/^Redfish: /);

      const p = await a.power!(target(sim.port));
      expect(p).toMatchObject({ watts: 188, detail: 'WS-Man System Board Pwr Consumption' });
      // Read-only: GETs to Redfish, WS-Man Enumerate/Pull only.
      expect(sim.requests.every((q) => q.method === 'GET' || (q.method === 'POST' && q.url === '/wsman'))).toBe(true);
    } finally {
      await sim.close();
    }
  });

  it('malformed HTTP from old firmware is read with the lenient parser', async () => {
    const body = JSON.stringify({ Members: [] });
    const server = net.createServer((sock) =>
      sock.once('data', () => {
        // Bare LF line endings instead of CRLF: invalid for the strict parser.
        sock.end(`HTTP/1.1 200 OK\nContent-Type: application/json\nContent-Length: ${body.length}\n\n${body}`);
      }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const t = { host: '127.0.0.1', port, username: 'u', params: { scheme: 'http' }, secret: {} } as never;
      expect((await deviceRequest(t, 'GET', '/redfish/v1/Systems', { defaultPort: 80 })).json).toEqual({ Members: [] });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('a read that gets no answer is tried once more on a new connection', async () => {
    let n = 0;
    const server = http.createServer((req, res) => {
      // The first request is left hanging, as a busy BMC does now and then.
      if (++n === 1) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const t = { host: '127.0.0.1', port, username: 'u', params: { scheme: 'http', timeoutMs: 300 }, secret: {} } as never;
      expect((await deviceRequest(t, 'GET', '/x', { defaultPort: 80 })).json).toEqual({ ok: true });
      expect(n).toBe(2);
      // Writes are never repeated.
      n = 0;
      await expect(deviceRequest(t, 'POST', '/x', { defaultPort: 80, body: {} })).rejects.toThrow(/no answer within 0 s$/);
      expect(n).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('power readings after the first read only the power link', async () => {
    const sim = await startRedfish('root', 'pw', { watts: 250 });
    try {
      const a = redfishAdapter();
      expect((await a.power!(target(sim.port))).watts).toBe(250);
      const before = sim.requests.length;
      sim.setWatts(260);
      const p = await a.power!(target(sim.port));
      expect(p.watts).toBe(260);
      expect(sim.requests.length - before).toBe(1);
    } finally {
      await sim.close();
    }
  });

  it('device error text is taken from the Redfish body, single line and capped', () => {
    expect(deviceErrorText(JSON.stringify({ error: { message: 'General', '@Message.ExtendedInfo': [{ Message: 'Bad\nthing.', Resolution: 'Reset.' }] } }))).toBe('Bad thing. Reset.');
    expect(deviceErrorText(JSON.stringify({ error: { message: 'x'.repeat(400) } }))!.length).toBe(240);
    expect(deviceErrorText('<html>500</html>')).toBeNull();
    expect(deviceErrorText(JSON.stringify({ error: 'Not found' }))).toBe('Not found');
  });
});
