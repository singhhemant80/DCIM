import { ConflictException } from '@nestjs/common';

/** Postgres error codes we translate into HTTP errors. */
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

function pgCode(err: unknown): string | undefined {
  // drizzle wraps driver errors; the pg error is on `.cause`.
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === FK_VIOLATION;
}

/** Re-throws unique violations as 409 with a caller-supplied message; everything else propagates unchanged. */
export function rethrowConflict(err: unknown, message: string): never {
  if (isUniqueViolation(err)) throw new ConflictException({ error: 'conflict', message });
  throw err;
}
