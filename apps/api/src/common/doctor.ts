import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { loadConfig, type AppConfig } from '../config/config';
import { migrationsFolder, type Db } from '../db/db';
import { users } from '../db/schema';
import { SecretBox } from './secret-box';
import { auditSecrets } from './secret-registry';
import { readAnchors, verifyAnchors } from '../cli/audit-anchor';
import { WORKER_HEARTBEAT_KEY } from '../health/worker-heartbeat';
import { parseAllowList } from '../worker/device-allow';

/**
 * Install checks run by `crapplet-dcim doctor` (with scripts/doctor.sh adding
 * the operating-system checks). Each result says what is wrong and how to fix
 * it. Nothing here changes data. Secrets are never printed.
 */
export type CheckStatus = 'PASS' | 'WARN' | 'FAIL';
export interface CheckResult {
  area: string;
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

const isLoopback = (host: string) => /^(127\.|localhost$|::1$|\[::1\]$)/.test(host);

export function configChecks(env: NodeJS.ProcessEnv): { config: AppConfig | null; results: CheckResult[] } {
  const r: CheckResult[] = [];
  let config: AppConfig;
  try {
    config = loadConfig(env);
  } catch (e) {
    r.push({ area: 'config', name: 'Configuration is valid', status: 'FAIL', detail: (e as Error).message.replace(/\n/g, ' '), fix: 'Correct /etc/crapplet-dcim/api.env' });
    return { config: null, results: r };
  }
  r.push({ area: 'config', name: 'Configuration is valid', status: 'PASS', detail: 'api.env parsed' });
  r.push(
    config.NODE_ENV === 'production'
      ? { area: 'config', name: 'Production mode', status: 'PASS', detail: 'NODE_ENV=production' }
      : { area: 'config', name: 'Production mode', status: 'WARN', detail: `NODE_ENV=${config.NODE_ENV}`, fix: 'Set NODE_ENV=production' },
  );
  const exposed = !isLoopback(config.HOST);
  if (!config.COOKIE_SECURE) {
    r.push({ area: 'config', name: 'Sign-in over HTTPS only', status: 'WARN', detail: `Plain HTTP sign-in is allowed (COOKIE_SECURE=false)${exposed ? ` and the service listens on ${config.HOST}` : ''}`, fix: 'Put nginx with TLS in front (deploy/nginx/crapplet-dcim.conf), then remove COOKIE_SECURE and ALLOW_INSECURE_HTTP' });
  } else r.push({ area: 'config', name: 'Sign-in over HTTPS only', status: 'PASS', detail: 'Secure cookies' });
  r.push(
    exposed
      ? { area: 'config', name: 'Listen address', status: 'WARN', detail: `Listening on ${config.HOST}:${config.PORT} (reachable from the network)`, fix: 'Prefer HOST=127.0.0.1 with nginx as the only public listener' }
      : { area: 'config', name: 'Listen address', status: 'PASS', detail: `${config.HOST}:${config.PORT}` },
  );
  r.push(
    config.ENABLE_SWAGGER && config.NODE_ENV === 'production'
      ? { area: 'config', name: 'API explorer disabled', status: 'WARN', detail: 'ENABLE_SWAGGER=true in production', fix: 'Remove ENABLE_SWAGGER' }
      : { area: 'config', name: 'API explorer disabled', status: 'PASS', detail: config.ENABLE_SWAGGER ? 'enabled (not production)' : 'disabled' },
  );
  const redisUrl = new URL(config.REDIS_URL);
  r.push(
    !isLoopback(redisUrl.hostname) && !redisUrl.password
      ? { area: 'config', name: 'Redis access', status: 'WARN', detail: `Redis at ${redisUrl.hostname} without a password`, fix: 'Use redis://:PASSWORD@host:6379 and set requirepass' }
      : { area: 'config', name: 'Redis access', status: 'PASS', detail: isLoopback(redisUrl.hostname) ? 'loopback' : 'password set' },
  );
  const dbUrl = new URL(config.DATABASE_URL);
  r.push(
    !isLoopback(dbUrl.hostname) && !/sslmode=(require|verify-ca|verify-full)/.test(dbUrl.search)
      ? { area: 'config', name: 'Database connection', status: 'WARN', detail: `Database at ${dbUrl.hostname} without TLS`, fix: 'Add ?sslmode=require (or verify-full) to DATABASE_URL' }
      : { area: 'config', name: 'Database connection', status: 'PASS', detail: isLoopback(dbUrl.hostname) ? 'loopback' : 'TLS required' },
  );
  let allow: string | null = null;
  try {
    allow = parseAllowList(env.CDCIM_DEVICE_ALLOW) ? String(env.CDCIM_DEVICE_ALLOW) : null;
  } catch (e) {
    r.push({ area: 'config', name: 'Device networks', status: 'FAIL', detail: (e as Error).message, fix: 'Correct CDCIM_DEVICE_ALLOW (comma-separated CIDRs)' });
  }
  if (allow) r.push({ area: 'config', name: 'Device networks', status: 'PASS', detail: `credentials used only towards ${allow}` });
  else if (!r.some((x) => x.name === 'Device networks')) r.push({ area: 'config', name: 'Device networks', status: 'WARN', detail: 'CDCIM_DEVICE_ALLOW is not set: stored device credentials can be pointed at any address this server reaches', fix: 'Set CDCIM_DEVICE_ALLOW to your management networks, e.g. 10.10.0.0/16,163.5.191.0/24' });
  r.push({ area: 'config', name: 'Encryption keys', status: 'PASS', detail: `${config.CDCIM_ENCRYPTION_KEYS.length} key(s), active: ${config.CDCIM_ENCRYPTION_KEYS[0]!.id}` });
  return { config, results: r };
}

export async function runtimeChecks(
  db: Db,
  redis: Redis,
  config: AppConfig,
  opts: { anchorDir?: string; backupDir?: string; now?: Date } = {},
): Promise<CheckResult[]> {
  const r: CheckResult[] = [];
  const add = (x: CheckResult) => r.push(x);

  // Database and migrations.
  try {
    const [v] = (await db.execute(sql`select current_setting('server_version_num')::int as v, extract(epoch from now()) as t`)).rows as { v: number; t: string }[];
    add(v!.v >= 140000 ? { area: 'database', name: 'PostgreSQL reachable', status: 'PASS', detail: `version ${Math.floor(v!.v / 10000)}` } : { area: 'database', name: 'PostgreSQL reachable', status: 'FAIL', detail: `version ${v!.v} is older than 14`, fix: 'Upgrade PostgreSQL' });
    const skew = Math.abs(Number(v!.t) * 1000 - (opts.now ?? new Date()).getTime()) / 1000;
    add(skew <= 5 ? { area: 'system', name: 'Clock', status: 'PASS', detail: `database and service clocks within ${skew.toFixed(1)} s` } : { area: 'system', name: 'Clock', status: 'WARN', detail: `database and service clocks differ by ${skew.toFixed(0)} s`, fix: 'Enable time sync (timedatectl set-ntp true)' });
    const journal = JSON.parse(readFileSync(join(migrationsFolder(), 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] };
    let applied = 0;
    try {
      applied = Number(((await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0] as { n: number }).n);
    } catch {
      applied = 0;
    }
    add(
      applied >= journal.entries.length
        ? { area: 'database', name: 'Migrations applied', status: 'PASS', detail: `${applied} of ${journal.entries.length}` }
        : { area: 'database', name: 'Migrations applied', status: 'FAIL', detail: `${applied} of ${journal.entries.length} applied`, fix: 'Run the installer again, or: node dist/cli/migrate.js' },
    );
  } catch (e) {
    add({ area: 'database', name: 'PostgreSQL reachable', status: 'FAIL', detail: (e as Error).message, fix: 'Check that PostgreSQL runs and DATABASE_URL is right' });
    return r;
  }

  // Redis and the worker.
  try {
    if (redis.status === 'wait') await redis.connect();
    await redis.ping();
    add({ area: 'redis', name: 'Redis reachable', status: 'PASS', detail: 'PING ok' });
    const beat = await redis.get(WORKER_HEARTBEAT_KEY);
    add(beat ? { area: 'worker', name: 'Worker running', status: 'PASS', detail: `last heartbeat ${(JSON.parse(beat) as { at: string }).at}` } : { area: 'worker', name: 'Worker running', status: 'FAIL', detail: 'no heartbeat in the last 90 seconds: polling, alerts, power, BMC reads and consoles are stopped', fix: 'systemctl status crapplet-dcim-worker; journalctl -u crapplet-dcim-worker' });
  } catch (e) {
    add({ area: 'redis', name: 'Redis reachable', status: 'FAIL', detail: (e as Error).message, fix: 'systemctl start redis-server' });
  }

  // Stored secrets decrypt with the configured keys.
  const report = await auditSecrets(db, new SecretBox(config.CDCIM_ENCRYPTION_KEYS), { apply: false });
  const total = report.reduce((a, x) => a + x.total, 0);
  const unreadable = report.filter((x) => x.unreadable).map((x) => `${x.name}: ${x.unreadable}`);
  const active = config.CDCIM_ENCRYPTION_KEYS[0]!.id;
  const old = report.reduce((a, x) => a + Object.entries(x.byKey).filter(([k]) => k !== active).reduce((s, [, n]) => s + n, 0), 0);
  if (unreadable.length) add({ area: 'secrets', name: 'Stored secrets readable', status: 'FAIL', detail: `${unreadable.join(', ')} cannot be decrypted`, fix: 'Restore the missing key in CDCIM_ENCRYPTION_KEYS, or enter those credentials again' });
  else add({ area: 'secrets', name: 'Stored secrets readable', status: 'PASS', detail: `${total} secret(s) decrypt` });
  if (old) add({ area: 'secrets', name: 'Secrets on the active key', status: 'WARN', detail: `${old} secret(s) still on older keys`, fix: 'node dist/cli/secrets.js rotate' });

  // Audit log chain and external anchors.
  const anchorFile = opts.anchorDir ? join(opts.anchorDir, 'anchors.jsonl') : null;
  let anchors: ReturnType<typeof readAnchors> = [];
  let anchorNote = '';
  if (anchorFile) {
    try {
      anchors = readAnchors(anchorFile);
    } catch (e) {
      anchorNote = ` (anchors not readable: ${(e as Error).message})`;
    }
  }
  const checks = await verifyAnchors(db, anchors);
  const problems = checks.flatMap((c) => c.problems.map((p) => `${c.orgId.slice(0, 8)}: ${p}`));
  const events = checks.reduce((a, c) => a + c.chain.checked, 0);
  if (problems.length) add({ area: 'audit', name: 'Audit log intact', status: 'FAIL', detail: problems.slice(0, 3).join('; '), fix: 'Investigate: the audit log was changed outside the application. Compare with backups.' });
  else add({ area: 'audit', name: 'Audit log intact', status: 'PASS', detail: `${events} event(s) verified, ${anchors.length} anchor(s)${anchorNote}` });
  if (anchorFile && !anchors.length && !anchorNote) add({ area: 'audit', name: 'Audit anchors written', status: 'WARN', detail: `no anchors in ${anchorFile}`, fix: 'systemctl start crapplet-dcim-anchor.service (runs daily)' });
  else if (anchors.length) {
    const last = anchors.reduce((a, b) => (a.at > b.at ? a : b));
    const hours = ((opts.now ?? new Date()).getTime() - Date.parse(last.at)) / 3_600_000;
    add(hours <= 48 ? { area: 'audit', name: 'Audit anchors written', status: 'PASS', detail: `last ${last.at}` } : { area: 'audit', name: 'Audit anchors written', status: 'WARN', detail: `last anchor ${Math.round(hours)} h ago`, fix: 'systemctl status crapplet-dcim-anchor.timer' });
  }

  // Staff sign-in protection.
  const [staff] = await db.select({ n: count() }).from(users).where(and(eq(users.userType, 'staff'), eq(users.status, 'active')));
  const [noMfa] = await db.select({ n: count() }).from(users).where(and(eq(users.userType, 'staff'), eq(users.status, 'active'), isNull(users.mfaEnabledAt)));
  add(noMfa!.n ? { area: 'security', name: 'Staff use two-factor sign-in', status: 'WARN', detail: `${noMfa!.n} of ${staff!.n} active staff account(s) without MFA`, fix: 'Ask them to enable MFA under Account' } : { area: 'security', name: 'Staff use two-factor sign-in', status: 'PASS', detail: `${staff!.n} staff account(s), all with MFA` });

  // Backups.
  if (opts.backupDir) {
    const files = existsSync(opts.backupDir) ? readdirSync(opts.backupDir).filter((f) => f.endsWith('.cdcim-backup')) : [];
    if (!files.length) add({ area: 'backup', name: 'Recent backup', status: 'WARN', detail: `no backups in ${opts.backupDir}`, fix: 'crapplet-dcim backup (a daily timer is installed)' });
    else {
      const newest = Math.max(...files.map((f) => statSync(join(opts.backupDir!, f)).mtimeMs));
      const hours = ((opts.now ?? new Date()).getTime() - newest) / 3_600_000;
      add(hours <= 36 ? { area: 'backup', name: 'Recent backup', status: 'PASS', detail: `${files.length} backup(s), newest ${hours.toFixed(1)} h old` } : { area: 'backup', name: 'Recent backup', status: 'WARN', detail: `newest backup is ${Math.round(hours)} h old`, fix: 'systemctl status crapplet-dcim-backup.timer' });
    }
  }
  return r;
}
