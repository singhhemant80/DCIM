#!/usr/bin/env node
// NexoraDC acceptance run against an installed system (Node 22, no dependencies).
//
//   node scripts/acceptance.mjs --url http://127.0.0.1:8080 [--write] [--json report.json]
//   credentials: CDCIM_ACCEPT_EMAIL + CDCIM_ACCEPT_PASSWORD (a staff account without MFA),
//                or CDCIM_ACCEPT_KEY (an API key, ndc_…)
//
// Default: read-only checks (health, sign-in, every section's main view, the
// audit log chain, security behaviour). --write also creates a small set of
// records named ACCEPT-<time> (datacenter, rack, model, server placed in the
// rack, an IP prefix with an allocation, a customer with a rack allocation)
// and reads them back; use it on a new install or a staging copy. Devices
// cannot be deleted (only retired), so these records stay; they are clearly
// named. Nothing is sent to any device.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const BASE = (opt('url') ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const WRITE = args.includes('--write');
const API = `${BASE}/api/v1`;
const results = [];
let cookies = {};
let csrf = '';
const key = process.env.CDCIM_ACCEPT_KEY;

function storeCookies(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    cookies[pair.slice(0, i)] = pair.slice(i + 1);
    if (pair.startsWith('cdcim_csrf=')) csrf = decodeURIComponent(pair.slice(i + 1));
  }
}
async function call(method, path, body, { auth = true, csrfHeader = true, raw = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && key) headers.Authorization = `Bearer ${key}`;
  else if (auth && Object.keys(cookies).length) headers.Cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (auth && !key && csrfHeader && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const t = Date.now();
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, text: raw ? text : undefined, headers: res.headers, ms: Date.now() - t };
}

async function check(area, name, fn) {
  const t = Date.now();
  try {
    const detail = (await fn()) ?? '';
    const warn = typeof detail === 'string' && detail.startsWith('WARN ');
    results.push({ area, name, status: warn ? 'WARN' : 'PASS', detail: warn ? detail.slice(5) : detail, ms: Date.now() - t });
  } catch (e) {
    results.push({ area, name, status: 'FAIL', detail: e.message, ms: Date.now() - t });
  }
  const r = results.at(-1);
  console.log(`${r.status.padEnd(5)}${area.padEnd(15)}${name}${r.detail ? `: ${r.detail}` : ''} (${r.ms} ms)`);
}
const expectStatus = (r, ...ok) => { if (!ok.includes(r.status)) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.json)?.slice(0, 200) ?? ''}`); return r.json; };
const ensure = (cond, msg) => { if (!cond) throw new Error(msg); };

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const ids = {};

console.log(`NexoraDC acceptance — ${BASE} — ${new Date().toISOString()} — ${WRITE ? 'read and write' : 'read-only'}\n`);

await check('platform', 'Liveness', async () => expectStatus(await call('GET', '/health/live', undefined, { auth: false }), 200).status);
await check('platform', 'Readiness (database, Redis, worker)', async () => {
  const b = expectStatus(await call('GET', '/health/ready', undefined, { auth: false }), 200);
  ensure(b.status === 'ok', `status ${b.status}`);
  return b.worker === 'running' ? 'database, Redis and worker up' : `WARN worker ${b.worker}`;
});
await check('platform', 'Web app served', async () => {
  const r = await call('GET', `${BASE}/`, undefined, { auth: false, raw: true });
  ensure(r.status === 200 && /<div id="root"|<!doctype html/i.test(r.text ?? ''), `HTTP ${r.status}`);
  const missing = ['x-content-type-options', 'content-security-policy', 'referrer-policy'].filter((h) => !r.headers.get(h));
  return missing.length ? `WARN security headers missing: ${missing.join(', ')}` : 'with security headers';
});

await check('security', 'Requests without sign-in are refused', async () => {
  const saved = cookies; cookies = {};
  const r = await call('GET', '/auth/me', undefined, { auth: false });
  cookies = saved;
  ensure(r.status === 401, `expected 401, got ${r.status}`);
});
await check('security', 'Wrong password is refused', async () => {
  const r = await call('POST', '/auth/login', { email: 'nobody@acceptance.invalid', password: 'Not-the-password-1' }, { auth: false });
  ensure(r.status === 401 || r.status === 429, `expected 401, got ${r.status}`);
});

if (!key) {
  await check('auth', 'Sign in', async () => {
    const email = process.env.CDCIM_ACCEPT_EMAIL; const password = process.env.CDCIM_ACCEPT_PASSWORD;
    ensure(email && password, 'set CDCIM_ACCEPT_EMAIL and CDCIM_ACCEPT_PASSWORD (or CDCIM_ACCEPT_KEY)');
    const b = expectStatus(await call('POST', '/auth/login', { email, password }, { auth: false }), 200);
    ensure(!b.mfaRequired, 'this account has MFA: use an API key (CDCIM_ACCEPT_KEY) instead');
    ensure(csrf, 'no CSRF cookie set');
    const flags = (cookies && Object.keys(cookies).length) ? 'session cookie set' : '';
    return flags;
  });
  await check('security', 'Changes without the CSRF token are refused', async () => {
    const r = await call('POST', '/customers', { name: 'csrf-probe', code: `CSRF${stamp}` }, { csrfHeader: false });
    ensure(r.status === 403, `expected 403, got ${r.status}`);
  });
}
await check('auth', 'Profile and permissions', async () => {
  const b = expectStatus(await call('GET', '/auth/me'), 200);
  ensure(b.user?.userType === 'staff' || b.userType === 'staff' || b.user, 'no profile');
  const perms = b.permissions ?? b.user?.permissions ?? [];
  return `${b.user?.email ?? b.email ?? ''} with ${perms.length} permission(s)${b.user?.mfaEnabled === false ? ' (MFA off)' : ''}`;
});

const views = [
  ['overview', '/overview'],
  ['dcim', '/dcim/summary'], ['dcim', '/dcim/tree'], ['dcim', '/dcim/racks'], ['dcim', '/dcim/devices?pageSize=5'], ['dcim', '/dcim/spare-parts'],
  ['network', '/network/summary'], ['network', '/network/devices'], ['network', '/network/topology'],
  ['ipam', '/ipam/summary'], ['ipam', '/ipam/prefixes'],
  ['monitoring', '/monitoring/ports?pageSize=5'], ['monitoring', '/monitoring/totals'], ['monitoring', '/alerts?status=firing'], ['monitoring', '/alerts/rules'],
  ['power', '/power/summary'], ['power', '/power/devices'],
  ['colocation', '/colocation/overview'], ['colocation', '/colocation/allocations'], ['colocation', '/tickets'],
  ['services', '/services'], ['provisioning', '/provisioning/jobs'], ['provisioning', '/provisioning/images'], ['virtualization', '/virtualization/integrations'],
  ['automation', '/workflows'], ['automation', '/api-keys'], ['billing', '/billing/integrations'],
  ['admin', '/customers'], ['admin', '/users'], ['admin', '/roles'], ['admin', '/settings'], ['admin', '/audit?pageSize=5'],
];
for (const [area, path] of views) {
  await check(area, `GET ${path.split('?')[0]}`, async () => {
    const r = await call('GET', path);
    expectStatus(r, 200);
    if (r.ms > 1500) return `WARN slow: ${r.ms} ms`;
  });
}
await check('reports', 'CSV report', async () => {
  const r = await call('GET', '/reports?type=services&format=csv', undefined, { raw: true });
  ensure(r.status === 200, `HTTP ${r.status}`);
});
await check('audit', 'Audit log hash chain intact', async () => {
  const b = expectStatus(await call('GET', '/audit/verify'), 200);
  ensure(b.ok === true, `chain broken at ${b.brokenAtId}`);
  return `${b.checked} event(s) verified`;
});

if (WRITE) {
  const D = '/dcim';
  await check('write', 'Datacenter → building → room → rack', async () => {
    ids.dc = expectStatus(await call('POST', `${D}/datacenters`, { code: `A${stamp.slice(-6)}`, name: `ACCEPT-${stamp} DC` }), 201).id;
    const b = expectStatus(await call('POST', `${D}/buildings`, { datacenterId: ids.dc, name: 'ACCEPT building' }), 201).id;
    const room = expectStatus(await call('POST', `${D}/rooms`, { buildingId: b, name: 'ACCEPT hall' }), 201).id;
    ids.rack = expectStatus(await call('POST', `${D}/racks`, { roomId: room, name: `ACCEPT-${stamp}`, uHeight: 42 }), 201).id;
  });
  await check('write', 'Model and server placed in the rack', async () => {
    const m = expectStatus(await call('POST', `${D}/manufacturers`, { name: `ACCEPT-${stamp} Vendor` }), 201).id;
    const model = expectStatus(await call('POST', `${D}/models`, { manufacturerId: m, name: `ACCEPT-${stamp} 1U`, category: 'server', uHeight: 1, depthMm: 700, fullDepth: true, typicalPowerW: 250 }), 201).id;
    ids.dev = expectStatus(await call('POST', `${D}/devices`, { modelId: model, assetTag: `ACCEPT-${stamp}`, initialState: 'inventory' }), 201).id;
    expectStatus(await call('POST', `${D}/devices/${ids.dev}/placement`, { rackId: ids.rack, positionU: 10, face: 'front' }), 200, 201);
    const el = expectStatus(await call('GET', `${D}/racks/${ids.rack}/elevation`), 200);
    ensure(JSON.stringify(el).includes(ids.dev), 'device not in the elevation');
    const clash = await call('POST', `${D}/devices/${ids.dev}/placement`, { rackId: ids.rack, positionU: 43, face: 'front' });
    ensure(clash.status >= 400 && clash.status < 500, `placing above the rack top was accepted (${clash.status})`);
  });
  await check('write', 'IP prefix and atomic allocation', async () => {
    const third = Number.parseInt(stamp.slice(-4), 10) % 250;
    const p = await call('POST', '/ipam/prefixes', { prefix: `10.254.${third}.0/29`, description: `ACCEPT-${stamp}` });
    const pid = p.status === 409 ? null : expectStatus(p, 201).id;
    ensure(pid, 'prefix already exists (re-run in a minute)');
    const got = expectStatus(await call('POST', '/ipam/allocate-next', { prefixId: pid, count: 2, description: `ACCEPT-${stamp}` }), 200, 201);
    ensure(Array.isArray(got) && got.length === 2 && got[0].address !== got[1].address, 'two distinct addresses expected');
    return got.map((a) => a.address).join(', ');
  });
  await check('write', 'Customer and rack allocation', async () => {
    ids.customer = expectStatus(await call('POST', '/customers', { name: `ACCEPT-${stamp} Customer`, code: `AC${stamp.slice(-8)}` }), 201).id;
    const a = expectStatus(await call('POST', '/colocation/allocations', { customerId: ids.customer, rackId: ids.rack, kind: 'half', part: 2, contractedPowerW: 1500, feeds: 'a_b', breakerAmps: 16, voltage: 230, startDate: new Date().toISOString().slice(0, 10) }), 201);
    return `U${a.startU}–U${a.endU}`;
  });
  await check('write', 'Changes are in the audit log and the chain is intact', async () => {
    const b = expectStatus(await call('GET', '/audit/verify'), 200);
    ensure(b.ok === true, `chain broken at ${b.brokenAtId}`);
    const list = expectStatus(await call('GET', '/audit?pageSize=50'), 200);
    ensure((list.items ?? []).some((e) => e.targetId === ids.dev || e.targetId === ids.customer), 'created records not in the audit log');
  });
}

if (!key) await check('auth', 'Sign out', async () => { expectStatus(await call('POST', '/auth/logout'), 200, 201, 204); ensure((await call('GET', '/auth/me')).status === 401, 'session still valid after sign-out'); });

const sum = (s) => results.filter((r) => r.status === s).length;
console.log(`\n${sum('PASS')} passed, ${sum('WARN')} warning(s), ${sum('FAIL')} failed — ${results.length} checks`);
const out = opt('json');
if (out) writeFileSync(out, JSON.stringify({ url: BASE, at: new Date().toISOString(), write: WRITE, created: ids, results }, null, 2));
process.exitCode = sum('FAIL') ? 1 : 0;
