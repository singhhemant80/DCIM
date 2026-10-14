/**
 * Poller load test: the worker's interface poll loop against N simulated SNMP
 * devices with P ports each, through the real code path (claim with SKIP
 * LOCKED, SNMP read, rate engine, raw storage, alert evaluation), with the
 * API answering port-list requests at the same time.
 *
 *   LOAD_DEVICES=100 LOAD_PORTS=48 LOAD_INTERVAL=60 LOAD_DURATION=180 [LOAD_CONCURRENCY=16] [LOAD_JSON=out.json] \
 *     npx vitest run -c vitest.load.config.ts
 *
 * Uses the test database (reset first). Measures: polls done vs due,
 * schedule lag, poll duration, failures, rows written, rollup time, API
 * latency, CPU and memory of this process (poller + API; the SNMP agents run
 * in a child process).
 */
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { SecretBox } from '../../src/common/secret-box';
import { createPollLoop, type PollOutcome } from '../../src/worker/monitoring/poller';
import { evaluateAlerts } from '../../src/worker/monitoring/alerts';
import { rollup } from '../../src/worker/monitoring/rollup';
import { it } from 'vitest';
import { Client, setupTestApp } from '../helpers';

const arg = (n: string, d: number) => Number(process.env[`LOAD_${n.toUpperCase()}`] ?? d);
const N = arg('devices', 100);
const P = arg('ports', 48);
const INTERVAL = arg('interval', 60);
const DURATION = arg('duration', 180);
const CONC = arg('concurrency', 16);
const BASE = 21000;
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : 0);

async function main() {
  const t0 = Date.now();
  const farm = fork(join(__dirname, 'snmp-farm.ts'), [String(BASE), String(N), String(P)], { execArgv: ['--import', 'tsx'], stdio: 'inherit' });
  await new Promise<void>((res, rej) => {
    farm.once('message', () => res());
    farm.once('exit', (code) => rej(new Error(`SNMP farm exited (${code})`)));
  });
  process.stdout.write(`SNMP farm ready: ${N} agents in ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
  const ctx = await setupTestApp({ LOGIN_RATE_LIMIT_PER_MINUTE: '1000' });
  const admin = await Client.login(ctx.server, ctx.emails.superAdmin);
  const ok = async (r: PromiseLike<{ status: number; body: { id?: string } }>) => {
    const x = await r;
    if (x.status >= 300) throw new Error(`HTTP ${x.status} ${JSON.stringify(x.body)}`);
    return x.body;
  };
  const mf = (await ok(admin.post('/api/v1/dcim/manufacturers', { name: 'Load' }))).id;
  const model = (await ok(admin.post('/api/v1/dcim/models', { manufacturerId: mf, name: 'Load switch', category: 'switch', uHeight: 1, fullDepth: false }))).id;
  for (let d = 0; d < N; d++) {
    const id = (await ok(admin.post('/api/v1/dcim/devices', { modelId: model, assetTag: `LOAD-${d}`, hostname: `load-${d}`, mgmtAddress: '127.0.0.1', initialState: 'inventory' }))).id;
    await ok(admin.post('/api/v1/network/interfaces/bulk', { deviceId: id, pattern: `ether[1-${P}]`, speedBps: 10e9 }));
    await ok(admin.put(`/api/v1/network/devices/${id}/credentials`, { kind: 'snmp_v2c', community: 'load-community', host: '127.0.0.1', port: BASE + d, timeoutMs: 3000, retries: 1 }));
    await ok(admin.put(`/api/v1/monitoring/devices/${id}`, { enabled: true, credentialKind: 'snmp_v2c', intervalSeconds: INTERVAL }));
    if ((d + 1) % 25 === 0) process.stdout.write(`  ${d + 1} devices set up\n`);
  }
  // Spread the first polls over one interval, as a running system would be.
  await ctx.db.execute(sql`update device_monitoring set next_poll_at = now() + (random() * ${INTERVAL}) * interval '1 second'`);
  const setupS = (Date.now() - t0) / 1000;
  process.stdout.write(`Set up ${N} devices × ${P} ports (${N * P} ports) in ${setupS.toFixed(0)} s; polling every ${INTERVAL} s for ${DURATION} s, concurrency ${CONC}\n`);

  const secrets = ctx.app.get(SecretBox);
  const logger = pino({ level: 'silent' });
  const outcomes: { at: number; ok: boolean; ms: number; ports: number }[] = [];
  const loop = createPollLoop(
    {
      db: ctx.db,
      secrets,
      logger,
      onPolled: async (o: PollOutcome) => {
        await evaluateAlerts(ctx.db, o);
        outcomes.push({ at: Date.now(), ok: o.ok, ms: 0, ports: o.ports.length });
      },
    },
    CONC,
  );
  // CPU seconds of the simulator process (to tell a saturated simulator from a saturated poller).
  const farmCpu = () => {
    const f = readFileSync(`/proc/${farm.pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  };
  const farm0 = farmCpu();
  const lagSamples: number[] = [];
  const apiMs: number[] = [];
  const cpu0 = process.cpuUsage();
  let rssMax = 0;
  const start = Date.now();
  const tick = setInterval(() => void loop().catch(() => undefined), 2000);
  const sampler = setInterval(async () => {
    rssMax = Math.max(rssMax, process.memoryUsage().rss);
    const [r] = (await ctx.db.execute(sql`select coalesce(max(extract(epoch from now() - next_poll_at)), 0)::float as lag from device_monitoring where enabled`)).rows as { lag: number }[];
    lagSamples.push(Math.max(0, r!.lag));
    const t = Date.now();
    await admin.get('/api/v1/monitoring/ports?pageSize=50&sort=traffic');
    apiMs.push(Date.now() - t);
  }, 5000);
  await new Promise((r) => setTimeout(r, DURATION * 1000));
  clearInterval(tick);
  clearInterval(sampler);
  await new Promise((r) => setTimeout(r, 4000)); // let in-flight polls finish
  const cpu = process.cpuUsage(cpu0);
  const farmCpuS = farmCpu() - farm0;
  const wall = (Date.now() - start) / 1000;

  const [durs] = [(await ctx.db.execute(sql`select last_duration_ms as ms from device_monitoring where last_duration_ms is not null`)).rows.map((r) => Number((r as { ms: number }).ms))];
  const [rows] = (await ctx.db.execute(sql`select (select count(*) from interface_rates)::int as rates, (select count(*) from device_monitoring where consecutive_failures > 0)::int as failing`)).rows as { rates: number; failing: number }[];
  const tr = Date.now();
  const ru = await rollup(ctx.db);
  const rollupMs = Date.now() - tr;
  const done = outcomes.length;
  const okN = outcomes.filter((o) => o.ok).length;
  const expected = Math.floor((N * DURATION) / INTERVAL);
  const report = {
    devices: N,
    portsPerDevice: P,
    ports: N * P,
    intervalSeconds: INTERVAL,
    durationSeconds: DURATION,
    concurrency: CONC,
    pollsDone: done,
    pollsOk: okN,
    pollsExpected: expected,
    completion: +(done / expected).toFixed(3),
    pollsPerSecond: +(done / DURATION).toFixed(2),
    portSamplesPerSecond: +(outcomes.reduce((a, o) => a + o.ports, 0) / DURATION).toFixed(0),
    pollDurationMs: { p50: pct(durs, 50), p95: pct(durs, 95), max: Math.max(0, ...durs) },
    scheduleLagSeconds: { p50: +pct(lagSamples, 50).toFixed(1), max: +Math.max(0, ...lagSamples).toFixed(1) },
    devicesFailingAtEnd: rows!.failing,
    rateRowsWritten: rows!.rates,
    rollup: { ms: rollupMs, ...ru },
    apiPortListMs: { p50: pct(apiMs, 50), p95: pct(apiMs, 95), max: Math.max(0, ...apiMs) },
    processCpuPercent: +(((cpu.user + cpu.system) / 1000 / (wall * 1000)) * 100).toFixed(1),
    simulatorCpuPercent: +((farmCpuS / wall) * 100).toFixed(1),
    rssMaxMb: Math.round(rssMax / 1048576),
    node: process.version,
    cpus: (await import('node:os')).cpus().length,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (process.env.LOAD_JSON) writeFileSync(process.env.LOAD_JSON, JSON.stringify(report, null, 2));
  farm.kill();
  await ctx.close();
}
it(`poller under load: ${N} devices × ${P} ports every ${INTERVAL} s`, main);
