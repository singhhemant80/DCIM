import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Argon2id with OWASP-recommended parameters (19 MiB, t=2, p=1).
 * Hash strings are self-describing, so parameters can be raised later and
 * old hashes upgraded on next login via `needsRehash`.
 */
const PARAMS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Very common passwords rejected regardless of length. Not exhaustive — length is the main defense. */
const BANNED = new Set([
  'password1234',
  'password12345',
  'password123456',
  '123456789012',
  'qwertyuiop12',
  'administrator',
  'administrator1',
  'letmein12345',
  'changeme1234',
  'welcome12345',
]);

@Injectable()
export class PasswordService {
  /** Precomputed so lookups for unknown emails take the same time as real ones. */
  private dummyHash: Promise<string> = hash('timing-equalizer-not-a-real-password', PARAMS);

  hash(password: string): Promise<string> {
    return hash(password, PARAMS);
  }

  async verify(hashStr: string | null, password: string): Promise<boolean> {
    try {
      return await verify(hashStr ?? (await this.dummyHash), password);
    } catch {
      // Malformed hash in DB: treat as failure, never as success.
      return false;
    }
  }

  needsRehash(hashStr: string): boolean {
    return !hashStr.startsWith(`$argon2id$v=19$m=${PARAMS.memoryCost},t=${PARAMS.timeCost},p=${PARAMS.parallelism}$`);
  }

  /** Returns a reason string if the password is unacceptable beyond the schema's length rule. */
  weakness(password: string, context: { email?: string; name?: string } = {}): string | null {
    const lower = password.toLowerCase();
    if (BANNED.has(lower)) return 'This password is too common';
    if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character';
    const local = context.email?.split('@')[0]?.toLowerCase();
    if (local && local.length >= 4 && lower.includes(local)) return 'Password must not contain your email address';
    return null;
  }
}
