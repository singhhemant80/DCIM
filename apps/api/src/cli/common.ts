import { z } from 'zod';
import { createDb, createPool, type Db } from '../db/db';

/** CLI tools need only the database, so they validate just DATABASE_URL. */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const url = z.string().url().safeParse(process.env.DATABASE_URL);
  if (!url.success) throw new Error('DATABASE_URL is not set or invalid');
  const pool = createPool(url.data, 2);
  try {
    return await fn(createDb(pool));
  } finally {
    await pool.end();
  }
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function fail(err: unknown): never {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
}
