/**
 * Fleet health: every device in service with one status from ping, polled
 * health, the BMC's hardware health and firing alerts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client, setupTestApp, type TestContext } from './helpers';

let ctx: TestContext;
let admin: Client;
let acme: Client;
const ids: Record<string, string> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ok<T = any>(res: Promise<import('supertest').Response> | import('supertest').Response): Promise<T> {
  const r = await res;
  if (![200, 201].includes(r.status)) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
}

beforeAll(async () => {
  ctx = await setupTestApp();
  admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  acme = await Client.login(ctx.server, ctx.emails.acmeAdmin);
  const m = (await ok(admin.post('/api/v1/dcim/manufacturers', { name: 'Dell F' }))).id;
  const srvModel = (await ok(admin.post('/api/v1/dcim/models', { modelId: undefined, manufacturerId: m, name: 'R630 F', category: 'server', uHeight: 1, depthMm: 700, fullDepth: true }))).id;
  const swModel = (await ok(admin.post('/api/v1/dcim/models', { manufacturerId: m, name: 'S4048 F', category: 'switch', uHeight: 1, depthMm: 400, fullDepth: false }))).id;
  const dev = async (tag: string, model: string) => (await ok(admin.post('/api/v1/dcim/devices', { modelId: model, assetTag: tag, hostname: tag.toLowerCase(), initialState: 'inventory' }))).id as string;
  ids.good = await dev('SRV-GOOD', srvModel);
  ids.psu = await dev('SRV-PSU', srvModel);
  ids.down = await dev('SRV-DOWN', srvModel);
  ids.hot = await dev('SW-HOT', swModel);
  ids.none = await dev('SRV-NONE', srvModel);
  ids.stock = await dev('SRV-STOCK', srvModel);
  // In service (stock stays in inventory and is left out).
  await ctx.db.execute(sql`update devices set lifecycle_state = 'active' where id in (${ids.good}, ${ids.psu}, ${ids.down}, ${ids.hot}, ${ids.none})`);
  const org = ctx.org.id;
  const now = sql`now()`;
  for (const [id, up] of [
    [ids.good, true],
    [ids.psu, true],
    [ids.down, false],
    [ids.hot, true],
  ] as const)
    await ctx.db.execute(sql`insert into device_reachability (device_id, kind, org_id, target, reachable, rtt_ms, changed_at, checked_at) values (${id}, 'mgmt', ${org}, '10.0.0.1', ${up}, ${up ? 1.2 : null}, ${now}, ${now})`);
  const inv = (psuHealth: string) =>
    JSON.stringify({
      system: { health: psuHealth === 'OK' ? 'OK' : 'Warning', powerState: 'On' },
      psus: [
        { name: 'PSU 1', health: 'OK' },
        { name: 'PSU 2', health: psuHealth },
      ],
      fans: [{ name: 'Fan 1', reading: 5000, units: 'RPM', health: 'OK' }],
      temperatures: [{ name: 'Inlet', celsius: 24, upperCritical: 42, health: 'OK' }],
      drives: [],
      memory: [],
      processors: [],
      controllers: [],
      volumes: [],
      logs: [],
    });
  await ctx.db.execute(
    sql`insert into device_hardware (device_id, org_id, status, fetched_at, inventory, health) values (${ids.good}, ${org}, 'idle', ${now}, ${inv('OK')}::jsonb, 'OK'), (${ids.psu}, ${org}, 'idle', ${now}, ${inv('Critical')}::jsonb, 'Warning')`,
  );
  await ctx.db.execute(sql`insert into device_monitoring (device_id, org_id, enabled, credential_kind, last_ok_at) values (${ids.hot}, ${org}, true, 'snmp_v2c', ${now})`);
  await ctx.db.execute(sql`insert into device_health (device_id, org_id, at, cpu_pct, memory_used_bytes, memory_total_bytes, temperature_c) values (${ids.hot}, ${org}, ${now}, 95, 50, 100, 72)`);
  await ctx.db.execute(sql`insert into alerts (org_id, rule_name, metric, target_key, device_id, severity, status, message, started_at) values (${org}, 'r', 'm', 'k', ${ids.good}, 'warning', 'firing', 'Port Te1/1 errors rising', ${now})`);
});
afterAll(async () => {
  await ctx?.close();
});

describe('fleet health', () => {
  it('one status per device in service, with the reasons; unchecked devices are unknown', async () => {
    const r = await ok(admin.get('/api/v1/monitoring/fleet-health'));
    const by = Object.fromEntries(r.items.map((x: { name: string }) => [x.name, x]));
    expect(by['srv-stock']).toBeUndefined();
    expect(by['srv-down']).toMatchObject({ status: 'critical', ping: { mgmt: { up: false } } });
    expect(by['srv-down'].reasons[0].text).toMatch(/BMC 10\.0\.0\.1 not answering ping/);
    expect(by['srv-psu']).toMatchObject({ status: 'critical', hardware: { health: 'Warning', psuCount: 2, maxTempC: 24 } });
    expect(by['srv-psu'].reasons.map((x: { text: string }) => x.text)).toContain('PSU PSU 2: Critical');
    expect(by['sw-hot']).toMatchObject({ status: 'critical', metrics: { fresh: true, cpuPct: 95, memoryPct: 50 } });
    expect(by['sw-hot'].reasons.map((x: { text: string }) => x.text)).toEqual(['CPU 95%', '72 °C']);
    expect(by['srv-good']).toMatchObject({ status: 'warning', alerts: 1 });
    expect(by['srv-good'].reasons).toEqual([{ level: 'warning', text: 'Port Te1/1 errors rising' }]);
    expect(by['srv-none']).toMatchObject({ status: 'unknown', reasons: [] });
    expect(r.totals).toEqual({ all: 5, critical: 3, warning: 1, ok: 0, unknown: 1 });
    // Worst first.
    expect(r.items.map((x: { status: string }) => x.status)).toEqual(['critical', 'critical', 'critical', 'warning', 'unknown']);
    // Staff only.
    expect((await acme.get('/api/v1/monitoring/fleet-health')).status).toBe(403);
  });
});
