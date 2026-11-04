/** Devices per type (in service and not yet) and virtual machines, on the overview summary. */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
const D = '/api/v1/dcim';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201, 204].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
});
afterAll(async () => {
  await ctx?.close();
});

describe('devices by type', () => {
  it('counts each type, in service and not yet; retired devices and missing VMs are left out', async () => {
    const m = (await ok(admin.post(`${D}/manufacturers`, { name: 'Mix' }))).id;
    const model = async (name: string, category: string) => (await ok(admin.post(`${D}/models`, { manufacturerId: m, name, category, uHeight: 1, fullDepth: false }))).id as string;
    const srv = await model('S1', 'server');
    const sw = await model('W1', 'switch');
    const rt = await model('R1', 'router');
    const dev = async (tag: string, modelId: string, state: string) => {
      const id = (await ok(admin.post(`${D}/devices`, { modelId, assetTag: tag, initialState: 'inventory' }))).id as string;
      await ctx.db.execute(sql`update devices set lifecycle_state = ${state}::lifecycle_state where id = ${id}`);
      return id;
    };
    for (const [t, mm, st] of [
      ['S-1', srv, 'active'],
      ['S-2', srv, 'active'],
      ['S-3', srv, 'inventory'],
      ['S-4', srv, 'retired'],
      ['W-1', sw, 'active'],
      ['R-1', rt, 'maintenance'],
      ['R-2', rt, 'planned'],
    ] as const)
      await dev(t, mm, st);
    const org = (await ctx.db.execute<{ id: string }>(sql`select org_id as id from devices limit 1`)).rows[0]!.id;
    const integ = (await ctx.db.execute<{ id: string }>(sql`insert into virt_integrations (org_id, kind, name, url, secret_enc) values (${org}, 'proxmox', 'PVE', 'https://pve.example:8006', 'x') returning id`)).rows[0]!.id;
    await ctx.db.execute(sql`insert into virt_hosts (org_id, integration_id, external_id, name) values (${org}, ${integ}, 'n1', 'pve1')`);
    await ctx.db.execute(sql`insert into virt_guests (org_id, integration_id, external_id, name, status, missing_since) values
      (${org}, ${integ}, '100', 'a', 'running', null), (${org}, ${integ}, '101', 'b', 'stopped', null), (${org}, ${integ}, '102', 'gone', 'running', now())`);

    const s = await ok(admin.get(`${D}/summary`));
    expect(s.deviceTypes).toEqual([
      { category: 'server', total: 3, inService: 2, notInService: 1 },
      { category: 'router', total: 2, inService: 1, notInService: 1 },
      { category: 'switch', total: 1, inService: 1, notInService: 0 },
    ]);
    expect(s.virtualMachines).toEqual({ total: 2, running: 1, hosts: 1 });
  });
});
