import { createDb, createPool } from '../db/db';
import { createRedis } from '../redis/redis';
import { configChecks, runtimeChecks, type CheckResult } from '../common/doctor';
import { arg } from './common';

/**
 * Application checks of an installed system (configuration, database,
 * migrations, Redis, worker, stored secrets, audit log, MFA, backups).
 * `crapplet-dcim doctor` runs this and adds the operating-system checks.
 *   node dist/cli/doctor.js [--anchor-dir DIR] [--backup-dir DIR] [--json]
 * Exit code 1 when any check fails.
 */
async function main() {
  const { config, results } = configChecks(process.env);
  let all: CheckResult[] = results;
  if (config) {
    const pool = createPool(config.DATABASE_URL, 2);
    const redis = createRedis(config.REDIS_URL);
    try {
      all = all.concat(await runtimeChecks(createDb(pool), redis, config, { anchorDir: arg('anchor-dir'), backupDir: arg('backup-dir') }));
    } finally {
      redis.disconnect();
      await pool.end();
    }
  }
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(all)}\n`);
  else for (const c of all) process.stdout.write(`${c.status.padEnd(5)}${c.area.padEnd(10)}${c.name}: ${c.detail}${c.fix && c.status !== 'PASS' ? `\n${' '.repeat(15)}fix: ${c.fix}` : ''}\n`);
  process.exitCode = all.some((c) => c.status === 'FAIL') ? 1 : 0;
}
main().catch((e) => {
  process.stdout.write(`FAIL doctor     ${(e as Error).message}\n`);
  process.exit(1);
});
