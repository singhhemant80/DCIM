/**
 * The BMC entered once (PUT /dcim/devices/:id/bmc) and stored for each use:
 * read-only monitoring (hardware, health, power readings), power control and
 * the consoles — separate encrypted credentials, never returned.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleCredentials, controlCredentials, deviceCredentials, devices, powerMonitoring, serverHealth } from '../src/db/schema';
import { SecretBox } from '../src/common/secret-box';
import { pollDueServerHealth } from '../src/worker/hardware/server-health';
import { Client, setupTestApp, type TestContext } from './helpers';
import { startRedfish, type MockRedfish } from './simulators/power-devices';

let ctx: TestContext;
let admin: Client;
let noc: Client;
let bmc: MockRedfish;
let id = '';
const D = '/api/v1/dcim';
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201, 204].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  noc = await Client.login(ctx.server, ctx.emails.noc);
  bmc = await startRedfish('root', 'calvin-Secret-1');
  const m = (await ok(admin.post(`${D}/manufacturers`, { name: 'Dell BMC' }))).id;
  const model = (await ok(admin.post(`${D}/models`, { manufacturerId: m, name: 'R640 BMC', category: 'server', uHeight: 1, depthMm: 750, fullDepth: true }))).id;
  id = (await ok(admin.post(`${D}/devices`, { modelId: model, assetTag: 'BMC-1', hostname: 'bmc-1', initialState: 'inventory' }))).id;
  await ctx.db.execute(sql`update devices set lifecycle_state = 'active' where id = ${id}`);
});
afterAll(async () => {
  await bmc?.close();
  await ctx?.close();
});

describe('BMC set up in one place', () => {
  it('stores one login for monitoring, power readings, power control and the consoles; passwords never come back', async () => {
    expect((await ok(admin.get(`${D}/devices/${id}/bmc`))).configured).toBe(false);
    const body = { type: 'idrac', host: '127.0.0.1', port: bmc.port, username: 'root', password: 'calvin-Secret-1', control: true, serialConsole: true, vncPassword: 'vnc-Pass-9' };
    // HTTP for the simulator: set scheme after (the form always uses HTTPS).
    const r = await ok(admin.put(`${D}/devices/${id}/bmc`, body));
    expect(JSON.stringify(r)).not.toMatch(/calvin-Secret-1|vnc-Pass-9/);
    expect(r.results).toEqual([
      { use: 'monitoring', status: 'set' },
      { use: 'power', status: 'set' },
      { use: 'control', status: 'set' },
      { use: 'serialConsole', status: 'set' },
      { use: 'vnc', status: 'set' },
    ]);
    expect(r.status).toMatchObject({
      configured: true,
      type: 'idrac',
      host: '127.0.0.1',
      monitoring: { kind: 'redfish', username: 'root' },
      power: { enabled: true, kind: 'redfish' },
      control: { kind: 'redfish', sameLogin: true },
      console: { sol: true, vnc: true },
    });
    const [d] = await ctx.db.select().from(devices).where(eq(devices.id, id));
    expect(d).toMatchObject({ mgmtAddress: '127.0.0.1', mgmtType: 'idrac' });
    const [mon] = await ctx.db.select().from(deviceCredentials).where(eq(deviceCredentials.deviceId, id));
    const [ctl] = await ctx.db.select().from(controlCredentials).where(eq(controlCredentials.deviceId, id));
    const cons = await ctx.db.select().from(consoleCredentials).where(eq(consoleCredentials.deviceId, id));
    // Separate ciphertexts, none containing the password in clear.
    expect(new Set([mon!.secretEnc, ctl!.secretEnc, ...cons.map((c) => c.secretEnc)]).size).toBe(4);
    for (const enc of [mon!.secretEnc, ctl!.secretEnc, ...cons.map((c) => c.secretEnc!)]) expect(enc).not.toContain('calvin');
    expect(cons.map((c) => c.kind).sort()).toEqual(['sol', 'vnc']);
    expect((await ctx.db.select().from(powerMonitoring).where(eq(powerMonitoring.deviceId, id)))[0]).toMatchObject({ enabled: true, credentialKind: 'redfish' });
    // The worker reads health with the stored monitoring login.
    await ctx.db
      .update(deviceCredentials)
      .set({ params: { ...mon!.params, scheme: 'http' } })
      .where(eq(deviceCredentials.id, mon!.id));
    expect(await pollDueServerHealth({ db: ctx.db, secrets: ctx.app.get(SecretBox), logger: silent })).toBe(1);
    const [sh] = await ctx.db.select().from(serverHealth).where(eq(serverHealth.deviceId, id));
    expect(sh).toMatchObject({ lastError: null });
    expect(sh!.data!.rollup.psu).toBe('Critical');
  });

  it('a separate read-only account for monitoring; uses not ticked are left alone', async () => {
    const r = await ok(admin.put(`${D}/devices/${id}/bmc`, { type: 'idrac', host: '127.0.0.1', port: bmc.port, username: 'admin2', password: 'other-Secret-2', power: false, readOnly: { username: 'monitor', password: 'ro-Secret-3' } }));
    expect(r.results.map((x: { use: string }) => x.use)).toEqual(['monitoring', 'power']);
    expect(r.status).toMatchObject({ monitoring: { username: 'monitor' }, power: { enabled: false }, control: { username: 'root', sameLogin: false } });
  });

  it('IPMI limits are checked, and staff without monitoring.configure cannot set it', async () => {
    const r = await admin.put(`${D}/devices/${id}/bmc`, { type: 'ipmi', host: '10.0.0.5', username: 'root', password: 'a-password-longer-than-twenty' });
    expect(r.status).toBe(400);
    expect((await noc.put(`${D}/devices/${id}/bmc`, { type: 'idrac', host: '10.0.0.5', username: 'root', password: 'x' })).status).toBe(403);
    expect((await noc.get(`${D}/devices/${id}/bmc`)).status).toBe(200);
  });
});
