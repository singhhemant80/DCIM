import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for secrets at rest (MFA seeds now; SNMP, BMC and
 * API credentials in later phases).
 *
 * Ciphertext format: `v1.<keyId>.<iv b64url>.<tag b64url>.<ciphertext b64url>`
 *
 * Key rotation: put the new key first in CDCIM_ENCRYPTION_KEYS and keep the
 * old keys after it. New writes use the first key; reads find the key by id.
 * `needsRotation()` reports values that should be re-encrypted.
 *
 * The optional `context` is bound as additional authenticated data so a
 * ciphertext copied from one row/column cannot be replayed into another.
 */
export class SecretBox {
  private readonly byId: Map<string, Buffer>;
  private readonly active: { id: string; key: Buffer };

  constructor(keys: { id: string; key: Buffer }[]) {
    if (keys.length === 0) throw new Error('SecretBox requires at least one key');
    for (const k of keys) if (k.key.length !== 32) throw new Error(`Key ${k.id} must be 32 bytes`);
    this.byId = new Map(keys.map((k) => [k.id, k.key]));
    if (this.byId.size !== keys.length) throw new Error('Duplicate encryption key ids');
    this.active = keys[0]!;
  }

  encrypt(plaintext: string, context = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.active.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', this.active.id, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string, context = ''): string {
    const parts = payload.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Unrecognized ciphertext format');
    const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
    const key = this.byId.get(keyId);
    if (!key) throw new Error(`Encryption key "${keyId}" is not configured`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }

  needsRotation(payload: string): boolean {
    return payload.split('.')[1] !== this.active.id;
  }
}
