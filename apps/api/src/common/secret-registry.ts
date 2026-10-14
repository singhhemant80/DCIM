import { isNotNull, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../db/db';
import {
  billingIntegrations,
  consoleCredentials,
  controlCredentials,
  deviceCredentials,
  dnsServers,
  notificationChannels,
  provisioningJobs,
  users,
  virtIntegrations,
  webhookSubscriptions,
} from '../db/schema';
import { mfaContext } from '../auth/auth.service';
import { channelContext } from '../monitoring/channels';
import { billingContext, webhookContext } from '../automation/contexts';
import { credentialContext } from '../network/discovery/types';
import { dnsServerContext } from '../network/dns/context';
import { controlContext, jobContext, virtContext } from '../provisioning/contexts';
import { consoleContext } from '../console/console.service';
import type { SecretBox } from './secret-box';

/**
 * Every column holding a SecretBox ciphertext, with the context (AAD) its rows
 * were encrypted with. Used by key rotation and the install check; a test
 * fails if a new encrypted column is added to the schema without an entry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any;
export interface SecretColumn {
  name: string;
  table: PgTable;
  column: PgColumn;
  /** Primary key column(s) to address a row. */
  key: PgColumn[];
  context: (row: AnyRow) => string | null;
}

export const SECRET_COLUMNS: SecretColumn[] = [
  { name: 'users.mfa_secret_enc', table: users, column: users.mfaSecretEnc, key: [users.id], context: (r) => mfaContext(r.id) },
  { name: 'device_credentials', table: deviceCredentials, column: deviceCredentials.secretEnc, key: [deviceCredentials.id], context: (r) => (r.host ? credentialContext(r.orgId, r.deviceId, r.kind, r.host, r.port) : null) },
  { name: 'control_credentials', table: controlCredentials, column: controlCredentials.secretEnc, key: [controlCredentials.deviceId], context: (r) => controlContext(r.orgId, r.deviceId, r.kind, r.host, r.port) },
  { name: 'console_credentials', table: consoleCredentials, column: consoleCredentials.secretEnc, key: [consoleCredentials.deviceId, consoleCredentials.kind], context: (r) => consoleContext(r.orgId, r.deviceId, r.kind, r.host, r.port) },
  { name: 'dns_servers', table: dnsServers, column: dnsServers.secretEnc, key: [dnsServers.id], context: (r) => dnsServerContext(r.orgId, r.id, r.kind, r.url) },
  { name: 'notification_channels', table: notificationChannels, column: notificationChannels.secretEnc, key: [notificationChannels.id], context: (r) => channelContext(r.orgId, r.id, r.kind) },
  { name: 'provisioning_jobs', table: provisioningJobs, column: provisioningJobs.secretEnc, key: [provisioningJobs.id], context: (r) => jobContext(r.orgId, r.id) },
  { name: 'virt_integrations', table: virtIntegrations, column: virtIntegrations.secretEnc, key: [virtIntegrations.id], context: (r) => virtContext(r.orgId, r.id, r.kind, r.url) },
  { name: 'webhook_subscriptions', table: webhookSubscriptions, column: webhookSubscriptions.secretEnc, key: [webhookSubscriptions.id], context: (r) => webhookContext(r.orgId, r.id) },
  { name: 'billing_integrations', table: billingIntegrations, column: billingIntegrations.secretEnc, key: [billingIntegrations.id], context: (r) => billingContext(r.orgId, r.id) },
];

export interface SecretColumnReport {
  name: string;
  total: number;
  /** Rows per key id. */
  byKey: Record<string, number>;
  /** Rows that do not decrypt with the configured keys (wrong key, or the row was changed without re-entering the secret). */
  unreadable: number;
  /** Rows re-encrypted with the active key (apply mode). */
  rotated: number;
}

const keyIdOf = (v: string) => v.split('.')[1] ?? '?';

/**
 * Checks (and with `apply`, re-encrypts with the active key) every stored
 * secret. Secrets are never printed; only counts are returned. Each row is
 * updated only if it still holds the ciphertext that was read, so a secret
 * changed meanwhile is left alone.
 */
export async function auditSecrets(db: Db, box: SecretBox, opts: { apply: boolean }): Promise<SecretColumnReport[]> {
  const out: SecretColumnReport[] = [];
  for (const c of SECRET_COLUMNS) {
    const rep: SecretColumnReport = { name: c.name, total: 0, byKey: {}, unreadable: 0, rotated: 0 };
    const rows: AnyRow[] = await db.select().from(c.table).where(isNotNull(c.column));
    for (const r of rows) {
      const prop = Object.entries(c.table).find(([, v]) => v === c.column)?.[0] as string;
      const enc = r[prop] as string;
      rep.total++;
      rep.byKey[keyIdOf(enc)] = (rep.byKey[keyIdOf(enc)] ?? 0) + 1;
      const ctx = c.context(r);
      let plain: string;
      try {
        if (ctx === null) throw new Error('no context');
        plain = box.decrypt(enc, ctx);
      } catch {
        rep.unreadable++;
        continue;
      }
      if (opts.apply && box.needsRotation(enc)) {
        const next = box.encrypt(plain, ctx!);
        const keyProps = c.key.map((k) => Object.entries(c.table).find(([, v]) => v === k)![0]);
        const where = sql.join([...c.key.map((k, i) => sql`${k} = ${r[keyProps[i]!]}`), sql`${c.column} = ${enc}`], sql` and `);
        const res = await db.update(c.table).set({ [prop]: next }).where(where).returning({ v: c.column });
        if (res.length) rep.rotated++;
      }
    }
    out.push(rep);
  }
  return out;
}

