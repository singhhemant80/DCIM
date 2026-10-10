import { createHash, randomBytes } from 'node:crypto';

/**
 * SHA-512 crypt ("$6$", Ulrich Drepper's specification), the password hash
 * format Linux installers accept (kickstart `rootpw --iscrypted`, preseed
 * `passwd/root-password-crypted`, cloud-init). Used so unattended configs
 * never carry a plain-text password.
 */
const B64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function b64from24(b2: number, b1: number, b0: number, n: number): string {
  let w = (b2 << 16) | (b1 << 8) | b0;
  let out = '';
  for (let i = 0; i < n; i++) {
    out += B64[w & 0x3f];
    w >>= 6;
  }
  return out;
}

const sha512 = (...parts: Buffer[]) => {
  const h = createHash('sha512');
  for (const p of parts) h.update(p);
  return h.digest();
};

export function sha512Crypt(password: string, salt?: string, rounds?: number): string {
  const key = Buffer.from(password, 'utf8');
  const s = Buffer.from((salt ?? randomSalt()).slice(0, 16), 'utf8');
  const customRounds = rounds !== undefined;
  const r = Math.min(999_999_999, Math.max(1000, rounds ?? 5000));

  // Digest B
  const b = sha512(key, s, key);
  // Digest A
  const ha = createHash('sha512');
  ha.update(key);
  ha.update(s);
  let n = key.length;
  for (; n > 64; n -= 64) ha.update(b);
  ha.update(b.subarray(0, n));
  for (let i = key.length; i > 0; i >>= 1) ha.update(i & 1 ? b : key);
  let a = ha.digest();

  // P and S sequences
  const hp = createHash('sha512');
  for (let i = 0; i < key.length; i++) hp.update(key);
  const dp = hp.digest();
  const p = Buffer.alloc(key.length);
  for (let i = 0; i < key.length; i += 64) dp.copy(p, i, 0, Math.min(64, key.length - i));
  const hs = createHash('sha512');
  for (let i = 0; i < 16 + a[0]!; i++) hs.update(s);
  const ds = hs.digest();
  const sBytes = Buffer.alloc(s.length);
  for (let i = 0; i < s.length; i += 64) ds.copy(sBytes, i, 0, Math.min(64, s.length - i));

  for (let i = 0; i < r; i++) {
    const hc = createHash('sha512');
    hc.update(i & 1 ? p : a);
    if (i % 3) hc.update(sBytes);
    if (i % 7) hc.update(p);
    hc.update(i & 1 ? a : p);
    a = hc.digest();
  }

  const order = [
    [0, 21, 42],
    [22, 43, 1],
    [44, 2, 23],
    [3, 24, 45],
    [25, 46, 4],
    [47, 5, 26],
    [6, 27, 48],
    [28, 49, 7],
    [50, 8, 29],
    [9, 30, 51],
    [31, 52, 10],
    [53, 11, 32],
    [12, 33, 54],
    [34, 55, 13],
    [56, 14, 35],
    [15, 36, 57],
    [37, 58, 16],
    [59, 17, 38],
    [18, 39, 60],
    [40, 61, 19],
    [62, 20, 41],
  ];
  let out = '';
  for (const [x, y, z] of order) out += b64from24(a[x!]!, a[y!]!, a[z!]!, 4);
  out += b64from24(0, 0, a[63]!, 2);
  return `$6$${customRounds ? `rounds=${r}$` : ''}${s.toString('utf8')}$${out}`;
}

export function randomSalt(): string {
  const bytes = randomBytes(16);
  let s = '';
  for (const b of bytes) s += B64[b & 0x3f];
  return s;
}
