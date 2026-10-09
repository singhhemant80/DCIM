import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables and is validated
 * once at startup. The process refuses to start with an invalid or insecure
 * configuration rather than running with surprising defaults.
 */
const keyRing = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    // Format: "keyId:base64key,keyId2:base64key2" — the first key encrypts, all keys decrypt.
    const keys: { id: string; key: Buffer }[] = [];
    for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(':');
      const id = part.slice(0, idx);
      const key = Buffer.from(part.slice(idx + 1), 'base64');
      if (idx < 1 || !/^[a-zA-Z0-9_-]{1,16}$/.test(id) || key.length !== 32) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each key must be "id:<base64 of 32 bytes>"' });
        return z.NEVER;
      }
      keys.push({ id, key });
    }
    if (keys.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one encryption key is required' });
      return z.NEVER;
    }
    return keys;
  });

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  /** Comma-separated AES-256-GCM key ring used for secrets at rest (MFA secrets, device credentials). */
  CDCIM_ENCRYPTION_KEYS: keyRing,
  /** Origin(s) of the web UI, used for CORS. */
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  /** Set to false only for local HTTP development. Defaults to true in production. */
  COOKIE_SECURE: bool.optional(),
  /** Number of reverse proxies in front of the API (for correct client IPs in logs and rate limits). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  ENABLE_SWAGGER: bool.optional(),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, 'COOKIE_SECURE' | 'ENABLE_SWAGGER'> & {
  COOKIE_SECURE: boolean;
  ENABLE_SWAGGER: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  const cookieSecure = c.COOKIE_SECURE ?? isProd;
  if (isProd && !cookieSecure) {
    throw new Error('Invalid configuration: COOKIE_SECURE cannot be false in production');
  }
  return { ...c, COOKIE_SECURE: cookieSecure, ENABLE_SWAGGER: c.ENABLE_SWAGGER ?? !isProd };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
