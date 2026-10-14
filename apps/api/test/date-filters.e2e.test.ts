/**
 * Date-wise filters: custom periods of whole days in the organization's time
 * zone (power energy, reports, history charts) and from / to day filters on
 * dated lists (tickets, audit, jobs, alerts, incidents, colocation).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizations, powerHourly, tickets } from '../src/db/schema';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
const ids: Record<string, string> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response, status = [200, 201]): Promise<T> {
  const r = await res;
  if (!status.includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  // India time (UTC+5:30): 11 March 2026 runs from 2026-03-10T18:30Z to 2026-03-11T18:30Z.
  await ctx.db.update(organizations).set({ settings: sql`jsonb_set(coalesce(settings, '{}'::jsonb), '{timezone}', '"Asia/Kolkata"')` }).where(eq(organizations.id, ctx.org.id));
  const m = (await ok(admin.post('/api/v1/dcim/manufacturers', { name: 'Date Co' }))).id;
  const model = (await ok(admin.post('/api/v1/dcim/models', { manufacturerId: m, name: 'D1', category: 'server', uHeight: 1, depthMm: 700, fullDepth: true }))).id;
  ids.dev = (await ok(admin.post('/api/v1/dcim/devices', { modelId: model, assetTag: 'DATE-1', initialState: 'inventory' }))).id;
  const row = (hour: string, wh: number) => ({ deviceId: ids.dev!, hour: new Date(hour), orgId: ctx.org.id, category: 'server', counted: true, source: 'redfish' as const, measuredWh: wh, measuredSeconds: 3600 });
  await ctx.db.insert(powerHourly).values([row('2026-03-10T16:00:00Z', 100), row('2026-03-10T20:00:00Z', 200), row('2026-03-11T12:00:00Z', 300), row('2026-03-11T19:00:00Z', 400)]);
});
afterAll(async () => ctx?.close());

describe('custom periods (whole days, organization time zone)', () => {
  it('energy for one day counts only that day (boundaries rounded to whole hours)', async () => {
    const r = await ok(admin.get('/api/v1/power/energy?period=custom&from=2026-03-11&to=2026-03-11&groupBy=device'));
    expect(r.period).toMatchObject({ timezone: 'Asia/Kolkata', roundedToHours: true, from: '2026-03-10T18:00:00.000Z', to: '2026-03-11T18:00:00.000Z' });
    expect(r.rows[0]).toMatchObject({ key: ids.dev, measuredKwh: 0.5 });
  });

  it('a range of days includes both end days', async () => {
    const r = await ok(admin.get('/api/v1/power/energy?period=custom&from=2026-03-10&to=2026-03-12&groupBy=device'));
    expect(r.rows[0].measuredKwh).toBe(1);
  });

  it('the device list and reports take the same custom period', async () => {
    const list = await ok(admin.get(`/api/v1/dcim/devices?withStatus=true&period=custom&from=2026-03-11&to=2026-03-11&q=DATE-1`));
    expect(list.items[0].status.power.energyKwh).toBe(0.5);
    const rep = await ok(admin.get('/api/v1/reports?type=energy&period=custom&from=2026-03-11&to=2026-03-11&format=json'));
    expect(rep.period).toMatchObject({ name: 'custom', from: '2026-03-10T18:00:00.000Z' });
  });

  it('the power history of a device follows the chosen days', async () => {
    const h = await ok(admin.get(`/api/v1/power/devices/${ids.dev}/history?range=custom&from=2026-03-11&to=2026-03-11`));
    expect(h.hourly.map((x: { hour: string }) => new Date(x.hour).toISOString())).toEqual(['2026-03-10T20:00:00.000Z', '2026-03-11T12:00:00.000Z']);
  });

  it('refuses missing, reversed or impossible dates', async () => {
    expect((await admin.get('/api/v1/power/energy?period=custom&from=2026-03-11')).body.error).toBe('dates_required');
    expect((await admin.get('/api/v1/power/energy?period=custom&from=2026-03-12&to=2026-03-11')).body.error).toBe('invalid_range');
    expect((await admin.get('/api/v1/power/energy?period=custom&from=2026-02-30&to=2026-03-11')).status).toBe(400);
    expect((await admin.get('/api/v1/power/energy?period=custom&from=11-03-2026&to=2026-03-11')).status).toBe(400);
    expect((await admin.get('/api/v1/monitoring/totals/history?range=custom')).body.error).toBe('dates_required');
  });
});

describe('date filters on lists', () => {
  it('tickets opened on the chosen days', async () => {
    const mk = async (subject: string, at: string) => {
      const t = await ok(admin.post('/api/v1/tickets', { kind: 'support', subject, body: 'x' }));
      await ctx.db.update(tickets).set({ createdAt: new Date(at) }).where(eq(tickets.id, t.id));
    };
    // 23:00 IST on 10 March, 05:30 IST on 11 March, 23:59 IST on 11 March, 00:30 IST on 12 March.
    await mk('A', '2026-03-10T17:30:00Z');
    await mk('B', '2026-03-11T00:00:00Z');
    await mk('C', '2026-03-11T18:29:00Z');
    await mk('D', '2026-03-11T19:00:00Z');
    const day = await ok(admin.get('/api/v1/tickets?status=all&from=2026-03-11&to=2026-03-11'));
    expect(day.items.map((t: { subject: string }) => t.subject).sort()).toEqual(['B', 'C']);
    const since = await ok(admin.get('/api/v1/tickets?status=all&from=2026-03-11'));
    expect(since.items.map((t: { subject: string }) => t.subject).sort()).toEqual(['B', 'C', 'D']);
    expect((await admin.get('/api/v1/tickets?from=2026-03-12&to=2026-03-11')).body.error).toBe('invalid_range');
  });

  it('audit accepts days as well as exact times', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const all = await ok(admin.get(`/api/v1/audit?from=${today}`));
    expect(all.total).toBeGreaterThan(0);
    expect((await ok(admin.get('/api/v1/audit?to=2000-01-01'))).total).toBe(0);
    expect((await ok(admin.get(`/api/v1/audit?from=${new Date(Date.now() - 3_600_000).toISOString()}`))).total).toBeGreaterThan(0);
  });

  it('jobs, alerts, incidents and colocation lists take the same filter', async () => {
    for (const path of ['/api/v1/provisioning/jobs', '/api/v1/alerts?status=all', '/api/v1/status/incidents?status=all', '/api/v1/colocation/cross-connects', '/api/v1/colocation/shipments', '/api/v1/colocation/visits', '/api/v1/colocation/allocations']) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await admin.get(`${path}${sep}from=2026-03-11&to=2026-03-11`);
      expect(r.status, path).toBe(200);
    }
  });
});
