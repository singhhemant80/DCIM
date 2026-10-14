/**
 * Remote console: BMC web link, graphical console over the BMC's VNC server,
 * and Serial-over-LAN, through the API's WebSocket and the worker's relay.
 * Simulated VNC server and ipmitool; not yet tried against a real iDRAC.
 */
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { auditEvents, consoleCredentials, consoleSessions } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { startConsoleRelay } from '../src/worker/console/relay';
import { Client, setupTestApp, type TestContext } from './helpers';
import { fakeSolIpmitool, startVncServer } from './simulators/console-devices';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let acme: Client;
let vnc: Awaited<ReturnType<typeof startVncServer>>;
let relay: Awaited<ReturnType<typeof startConsoleRelay>>;
const ipmi = fakeSolIpmitool('sol-pass-123');
const ids: Record<string, string> = {};
const C = '/api/v1/console';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201, 204]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

/** A WebSocket client that collects bytes and can wait for a number of them. */
function open(path: string, origin?: string) {
  const port = ((ctx.server as unknown as import('node:http').Server).address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, ['binary'], origin ? { headers: { Origin: origin } } : {});
  let buf = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  ws.on('message', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    wake?.();
  });
  const closed = new Promise<{ code: number }>((r) => ws.on('close', (code) => r({ code })));
  const failed = new Promise<string>((r) => ws.on('error', (e) => r(e.message)));
  const opened = new Promise<void>((r) => ws.on('open', () => r()));
  const read = async (n: number, ms = 5000) => {
    const end = Date.now() + ms;
    while (buf.length < n) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${n} bytes (have ${buf.length}: ${buf.toString('latin1')})`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, 50);
      });
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  const until = async (re: RegExp, ms = 5000) => {
    const end = Date.now() + ms;
    while (!re.test(buf.toString())) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${re}: ${buf.toString()}`);
      await new Promise((r) => setTimeout(r, 30));
    }
    const s = buf.toString();
    buf = Buffer.alloc(0);
    return s;
  };
  return { ws, read, until, closed, failed, opened };
}
const wsPath = (s: { sessionId: string; ticket: string }) => `${C}/ws?session=${s.sessionId}&ticket=${s.ticket}`;

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  vnc = await startVncServer('vnc-pw-1');
  relay = await startConsoleRelay({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent, port: 0, ipmitool: ipmi.path, checkMs: 150 });
  process.env.CONSOLE_RELAY_PORT = String(relay.port);
  const m = (await ok(admin.post('/api/v1/dcim/manufacturers', { name: 'Dell C' }))).id;
  const model = (await ok(admin.post('/api/v1/dcim/models', { manufacturerId: m, name: 'R640 C', category: 'server', uHeight: 1, depthMm: 750, fullDepth: true }))).id;
  ids.srv = (await ok(admin.post('/api/v1/dcim/devices', { modelId: model, assetTag: 'CON-1', initialState: 'inventory', mgmtAddress: '127.0.0.1', customerId: ctx.customers.acme, ownership: 'customer' }))).id;
});
afterAll(async () => {
  await relay?.close();
  await vnc?.close();
  await ctx?.close();
});

describe('access', () => {
  it('needs the console permission; setting passwords is staff-only and write-only', async () => {
    expect((await noc.get(`${C}/devices/${ids.srv}`)).status).toBe(403);
    expect((await acme.get(`${C}/devices/${ids.srv}`)).status).toBe(403);
    await ok(admin.put(`${C}/devices/${ids.srv}/credentials`, { kind: 'vnc', host: '127.0.0.1', port: vnc.port, password: 'vnc-pw-1' }));
    await ok(admin.put(`${C}/devices/${ids.srv}/credentials`, { kind: 'sol', host: '127.0.0.1', username: 'root', password: 'sol-pass-123' }));
    const st = await ok(admin.get(`${C}/devices/${ids.srv}`));
    expect(st.vnc).toMatchObject({ configured: true, host: '127.0.0.1', port: vnc.port });
    expect(st.sol).toMatchObject({ configured: true, username: 'root', privilege: 'ADMINISTRATOR' });
    expect(JSON.stringify(st)).not.toMatch(/vnc-pw-1|sol-pass-123/);
    const [row] = await ctx.db.select().from(consoleCredentials).where(eq(consoleCredentials.kind, 'vnc'));
    expect(row!.secretEnc).not.toMatch(/vnc-pw-1/);
  });

  it('opens the BMC web interface for staff only, with an audit record', async () => {
    expect((await ok(admin.post(`${C}/devices/${ids.srv}/web`))).url).toBe('https://127.0.0.1/');
    await ok(admin.put(`${C}/devices/${ids.srv}/credentials`, { kind: 'web', url: 'https://idrac-con1.example.net' }));
    expect((await ok(admin.post(`${C}/devices/${ids.srv}/web`))).url).toBe('https://idrac-con1.example.net');
    expect((await ctx.db.select().from(auditEvents).where(eq(auditEvents.action, 'console.web_open'))).length).toBe(2);
    expect((await admin.put(`${C}/devices/${ids.srv}/credentials`, { kind: 'web', url: 'javascript:alert(1)' })).status).toBe(400);
  });
});

describe('graphical console (VNC)', () => {
  it('relays RFB: the browser needs no password, the BMC gets the real one', async () => {
    const s = await ok(admin.post(`${C}/devices/${ids.srv}/sessions`, { kind: 'vnc' }));
    const c = open(wsPath(s));
    expect((await c.read(12)).toString()).toBe('RFB 003.008\n');
    c.ws.send(Buffer.from('RFB 003.008\n'));
    expect([...(await c.read(2))]).toEqual([1, 1]); // one type offered: None
    c.ws.send(Buffer.from([1]));
    expect([...(await c.read(4))]).toEqual([0, 0, 0, 0]);
    c.ws.send(Buffer.from([1])); // ClientInit
    const init = await c.read(24);
    expect(init.readUInt16BE(0)).toBe(1024);
    expect((await c.read(init.readUInt32BE(20))).toString()).toBe('iDRAC Virtual Console');
    c.ws.send(Buffer.from('keys'));
    expect((await c.read(9)).toString()).toBe('ECHO:keys');
    const st = await ok(admin.get(`${C}/devices/${ids.srv}`));
    expect(st.live).toHaveLength(1);
    // Only one session per console at a time.
    expect((await admin.post(`${C}/devices/${ids.srv}/sessions`, { kind: 'vnc' })).body.error).toBe('console_in_use');
    // Ending it from the page disconnects the relay.
    await ok(admin.post(`${C}/sessions/${s.sessionId}/end`));
    await c.closed;
    const [row] = await ctx.db.select().from(consoleSessions).where(eq(consoleSessions.id, s.sessionId));
    expect(row).toMatchObject({ status: 'ended', endReason: 'Closed by the user' });
    expect(row!.bytesIn).toBeGreaterThan(0);
    expect(row!.bytesOut).toBeGreaterThan(0);
  });

  it('a ticket works once, only from the same site', async () => {
    const s = await ok(admin.post(`${C}/devices/${ids.srv}/sessions`, { kind: 'vnc' }));
    const evil = open(wsPath(s), 'https://evil.example');
    expect(await evil.failed).toMatch(/403/);
    const c = open(wsPath(s));
    await c.opened;
    const again = open(wsPath(s));
    expect(await again.failed).toMatch(/401/);
    c.ws.close();
    await c.closed;
    expect((await open(`${C}/ws?session=${s.sessionId}&ticket=${'x'.repeat(43)}`).failed)).toMatch(/401/);
  });

  it('a wrong VNC password is reported to the browser and in the session log', async () => {
    await new Promise((r) => setTimeout(r, 300));
    await ok(admin.put(`${C}/devices/${ids.srv}/credentials`, { kind: 'vnc', host: '127.0.0.1', port: vnc.port, password: 'wrong-pw' }));
    const s = await ok(admin.post(`${C}/devices/${ids.srv}/sessions`, { kind: 'vnc' }));
    const c = open(wsPath(s));
    await c.read(12);
    c.ws.send(Buffer.from('RFB 003.008\n'));
    const fail = await c.read(5);
    expect(fail[0]).toBe(0); // no security types: failure with a reason
    const reason = (await c.read(fail.readUInt32BE(1))).toString();
    expect(reason).toMatch(/refused the VNC password/);
    expect(reason).not.toMatch(/wrong-pw/);
    await c.closed;
    const [row] = await ctx.db.select().from(consoleSessions).where(eq(consoleSessions.id, s.sessionId));
    expect(row!.status).toBe('failed');
  });
});

describe('serial console (SOL)', () => {
  it('runs ipmitool sol with the password in its environment only', async () => {
    const s = await ok(admin.post(`${C}/devices/${ids.srv}/sessions`, { kind: 'sol' }));
    const c = open(wsPath(s));
    expect(await c.until(/SOL Session operational/)).toMatch(/Connecting to the serial console of 127\.0\.0\.1/);
    c.ws.send(Buffer.from('ls -la\n'));
    expect(await c.until(/LS -LA/)).toMatch(/LS -LA/);
    c.ws.close();
    await c.closed;
    const args = readFileSync(ipmi.argsFile, 'utf8');
    expect(args).toMatch(/"sol","deactivate"/);
    expect(args).toMatch(/"-U","root","-E","-L","ADMINISTRATOR","sol","activate"/);
    expect(args).not.toMatch(/sol-pass-123/);
    await new Promise((r) => setTimeout(r, 300));
    const [row] = await ctx.db.select().from(consoleSessions).where(eq(consoleSessions.id, s.sessionId));
    expect(row!.status).toBe('ended');
  });

  it('every session is in the log with who and how it ended', async () => {
    const st = await ok(admin.get(`${C}/devices/${ids.srv}`));
    expect(st.recent.length).toBeGreaterThanOrEqual(4);
    expect(st.recent.every((r: { user: string }) => r.user === ctx.emails.superAdmin)).toBe(true);
    expect((await ctx.db.select().from(auditEvents).where(eq(auditEvents.action, 'console.start'))).length).toBeGreaterThanOrEqual(4);
  });
});
