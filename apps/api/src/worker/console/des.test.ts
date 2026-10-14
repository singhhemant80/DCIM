import { describe, expect, it } from 'vitest';
import { desEncryptBlock, vncAuthResponse } from './des';

describe('DES', () => {
  it('matches the FIPS 46 example', () => {
    const out = desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex'));
    expect(Buffer.from(out).toString('hex')).toBe('85e813540f0ab405');
  });
  it('matches a second known vector', () => {
    expect(Buffer.from(desEncryptBlock(Buffer.from('0E329232EA6D0D73', 'hex'), Buffer.from('8787878787878787', 'hex'))).toString('hex')).toBe('0000000000000000');
  });
  it('VNC response matches OpenSSL DES-ECB with the bit-reversed key', () => {
    // openssl enc -des-ecb -K <reversed "secret"> -nopad -provider legacy
    expect(vncAuthResponse('secret', Buffer.from('0123456789abcdef1122334455667788', 'hex')).toString('hex')).toBe('2d2a0dd383426c2e50ddb1ba4387b282');
  });
  it('VNC response is the challenge encrypted with the bit-reversed password', () => {
    const challenge = Buffer.alloc(16, 0);
    const a = vncAuthResponse('secret', challenge);
    expect(a).toHaveLength(16);
    // Both halves of an all-zero challenge encrypt the same way; a different password gives a different answer.
    expect(a.subarray(0, 8).equals(a.subarray(8))).toBe(true);
    expect(vncAuthResponse('secreT', challenge).equals(a)).toBe(false);
    // Only the first 8 characters count, as in every VNC server.
    expect(vncAuthResponse('password-long', challenge).equals(vncAuthResponse('password', challenge))).toBe(true);
  });
});
