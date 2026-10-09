import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const key = Buffer.alloc(32, 7).toString('base64');
const env = { DATABASE_URL: 'postgres://u:p@localhost/db', CDCIM_ENCRYPTION_KEYS: `k1:${key}` };

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const c = loadConfig(env);
    expect(c.HOST).toBe('127.0.0.1');
    expect(c.PORT).toBe(4000);
    expect(c.COOKIE_SECURE).toBe(false);
    expect(c.ENABLE_SWAGGER).toBe(true);
  });

  it('secures production by default and refuses insecure cookies there', () => {
    const c = loadConfig({ ...env, NODE_ENV: 'production' });
    expect(c.COOKIE_SECURE).toBe(true);
    expect(c.ENABLE_SWAGGER).toBe(false);
    expect(() => loadConfig({ ...env, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });

  it('rejects missing or malformed encryption keys', () => {
    expect(() => loadConfig({ DATABASE_URL: env.DATABASE_URL })).toThrow(/CDCIM_ENCRYPTION_KEYS/);
    expect(() => loadConfig({ ...env, CDCIM_ENCRYPTION_KEYS: 'k1:short' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...env, CDCIM_ENCRYPTION_KEYS: `bad id!:${key}` })).toThrow();
  });

  it('parses a multi-key ring with the first key active', () => {
    const c = loadConfig({ ...env, CDCIM_ENCRYPTION_KEYS: `new:${key},old:${key}` });
    expect(c.CDCIM_ENCRYPTION_KEYS.map((k) => k.id)).toEqual(['new', 'old']);
  });
});
