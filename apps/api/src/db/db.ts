import path from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** Either the root db or a transaction handle — services accept both. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

export function createPool(url: string, max = 20): Pool {
  const pool = new Pool({
    connectionString: url,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Guard against runaway queries holding connections.
    statement_timeout: 30_000,
    application_name: 'crapplet-dcim',
  });
  // An idle client erroring (e.g. DB restart) must not crash the process; pg
  // removes it from the pool and the next query reconnects.
  pool.on('error', (err) => {
    process.stderr.write(`[db] idle client error: ${err.message}\n`);
  });
  return pool;
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}

export function migrationsFolder(): string {
  // Works from both src/ (tests, ts) and dist/ (compiled) since both sit one level below apps/api.
  return path.resolve(__dirname, '..', '..', 'drizzle');
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}
