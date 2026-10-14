import { keyRing } from '../config/config';
import { SecretBox } from '../common/secret-box';
import { auditSecrets } from '../common/secret-registry';
import { fail, withDb } from './common';

/**
 * Encryption key rotation for stored secrets (device, BMC, console, DNS,
 * hypervisor, billing and webhook credentials, MFA seeds).
 *
 *   node dist/cli/secrets.js check    counts per key, and rows that no longer decrypt
 *   node dist/cli/secrets.js rotate   re-encrypts every secret with the first key
 *
 * Rotation: put a new key first in CDCIM_ENCRYPTION_KEYS (keep the old one after
 * it), restart, run `rotate`, then `check`; when no row uses the old key any
 * more it can be removed from the list. Secrets are never printed.
 */
const mode = process.argv[2];
if (mode !== 'check' && mode !== 'rotate') fail(new Error('Usage: secrets.js check|rotate'));
const ring = keyRing.safeParse(process.env.CDCIM_ENCRYPTION_KEYS ?? '');
if (!ring.success) fail(new Error('CDCIM_ENCRYPTION_KEYS is missing or invalid'));
const box = new SecretBox(ring.data);
const active = ring.data[0]!.id;

withDb(async (db) => {
  const report = await auditSecrets(db, box, { apply: mode === 'rotate' });
  let old = 0;
  let unreadable = 0;
  for (const r of report) {
    if (!r.total) continue;
    const keys = Object.entries(r.byKey)
      .map(([k, n]) => `${k}${k === active ? ' (active)' : ''}: ${n}`)
      .join(', ');
    process.stdout.write(`${r.name.padEnd(24)} ${String(r.total).padStart(5)} secret(s)  ${keys}${r.unreadable ? `  UNREADABLE: ${r.unreadable}` : ''}${r.rotated ? `  re-encrypted: ${r.rotated}` : ''}\n`);
    old += Object.entries(r.byKey).filter(([k]) => k !== active).reduce((a, [, n]) => a + n, 0) - r.rotated;
    unreadable += r.unreadable;
  }
  process.stdout.write(`\nActive key: ${active}. Secrets on older keys: ${old}. Unreadable: ${unreadable}.\n`);
  if (unreadable) process.stdout.write('Unreadable secrets need their key added back to CDCIM_ENCRYPTION_KEYS, or must be entered again in the UI.\n');
  else if (!old && ring.data.length > 1) process.stdout.write(`No secret uses ${ring.data.slice(1).map((k) => k.id).join(', ')} any more: it can be removed from CDCIM_ENCRYPTION_KEYS.\n`);
  process.exitCode = unreadable ? 2 : 0;
}).catch(fail);
