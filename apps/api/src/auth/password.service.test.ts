import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const svc = new PasswordService();
  it('hashes with argon2id and verifies', async () => {
    const h = await svc.hash('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await svc.verify(h, 'correct horse battery staple')).toBe(true);
    expect(await svc.verify(h, 'wrong')).toBe(false);
    expect(svc.needsRehash(h)).toBe(false);
  });
  it('treats missing or malformed hashes as failure, never success', async () => {
    expect(await svc.verify(null, 'anything')).toBe(false);
    expect(await svc.verify('not-a-hash', 'anything')).toBe(false);
  });
  it('rejects common and self-referencing passwords', () => {
    expect(svc.weakness('Password1234')).toMatch(/common/);
    expect(svc.weakness('aaaaaaaaaaaa')).toMatch(/repeated/);
    expect(svc.weakness('my-hemant-pass-99', { email: 'hemant@x.com' })).toMatch(/email/);
    expect(svc.weakness('unrelated-strong-phrase')).toBeNull();
  });
});
