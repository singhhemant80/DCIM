import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secret-box';

const key = (id: string) => ({ id, key: randomBytes(32) });

describe('SecretBox', () => {
  it('round-trips and never stores plaintext', () => {
    const box = new SecretBox([key('a')]);
    const ct = box.encrypt('snmp-community-xyz', 'ctx');
    expect(ct).not.toContain('snmp-community-xyz');
    expect(box.decrypt(ct, 'ctx')).toBe('snmp-community-xyz');
  });

  it('uses a fresh IV each time', () => {
    const box = new SecretBox([key('a')]);
    expect(box.encrypt('x')).not.toBe(box.encrypt('x'));
  });

  it('rejects ciphertext replayed under a different context (AAD binding)', () => {
    const box = new SecretBox([key('a')]);
    const ct = box.encrypt('secret', 'users.mfa_secret:1');
    expect(() => box.decrypt(ct, 'users.mfa_secret:2')).toThrow();
  });

  it('detects tampering', () => {
    const box = new SecretBox([key('a')]);
    const parts = box.encrypt('secret').split('.');
    const ct = Buffer.from(parts[4]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[4] = ct.toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
  });

  it('supports key rotation: old ciphertext still decrypts, new writes use the first key', () => {
    const oldKey = key('old');
    const oldBox = new SecretBox([oldKey]);
    const ct = oldBox.encrypt('v');
    const rotated = new SecretBox([key('new'), oldKey]);
    expect(rotated.decrypt(ct)).toBe('v');
    expect(rotated.needsRotation(ct)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('v'))).toBe(false);
  });

  it('fails clearly when the key is unknown', () => {
    const ct = new SecretBox([key('gone')]).encrypt('v');
    expect(() => new SecretBox([key('other')]).decrypt(ct)).toThrow(/not configured/);
  });

  it('validates keys', () => {
    expect(() => new SecretBox([])).toThrow();
    expect(() => new SecretBox([{ id: 'a', key: randomBytes(16) }])).toThrow();
    expect(() => new SecretBox([key('a'), key('a')])).toThrow(/Duplicate/);
  });
});
