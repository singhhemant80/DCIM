import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { CredentialInput, CredentialKind } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { deviceCredentials, type CredentialParams, type DeviceCredential } from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { SecretBox } from '../common/secret-box';
import { rethrowDbError } from '../common/pg-errors';
import type { Principal, RequestMeta } from '../auth/principal';
import { notFound, ownDevice } from './common';
import { SECRET_FIELDS, credentialContext } from './discovery/types';

/**
 * Device access credentials (SNMP communities and keys, API passwords and
 * tokens). Secrets are write-only: they are encrypted with the platform key
 * ring (AES-256-GCM, bound to org + device + kind) and never returned by any
 * API, written to logs or put in audit metadata. Only the discovery worker
 * decrypts them.
 */
@Injectable()
export class CredentialsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
  ) {}

  /** Public view of a credential row: everything except the ciphertext. */
  static view(c: DeviceCredential) {
    return {
      id: c.id,
      deviceId: c.deviceId,
      kind: c.kind,
      host: c.host,
      port: c.port,
      username: c.username,
      params: c.params,
      secretConfigured: true as const,
      lastTestAt: c.lastTestAt,
      lastTestOk: c.lastTestOk,
      lastTestMessage: c.lastTestMessage,
      rotatedAt: c.rotatedAt,
      updatedAt: c.updatedAt,
      scheduleHours: c.scheduleHours,
      nextRunAt: c.nextRunAt,
    };
  }

  /** Turns automatic (scheduled) discovery on or off for one credential. Runs are still only previews. */
  async setSchedule(p: Principal, deviceId: string, kind: CredentialKind, hours: number | null, meta: RequestMeta) {
    await ownDevice(this.db, p, deviceId);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(deviceCredentials)
        .set({ scheduleHours: hours, nextRunAt: hours ? new Date() : null })
        .where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, kind), eq(deviceCredentials.orgId, p.orgId)))
        .returning();
      if (!row) throw notFound('Credential');
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'credential.schedule', target: { type: 'device', id: deviceId }, outcome: 'success', meta, metadata: { kind, hours } }, tx);
      return CredentialsService.view(row);
    });
  }

  async list(p: Principal, deviceId: string) {
    await ownDevice(this.db, p, deviceId);
    const rows = await this.db.select().from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.orgId, p.orgId)));
    return rows.map(CredentialsService.view);
  }

  /** Creates or replaces the credential of one kind for a device (secrets must be supplied again). */
  async put(p: Principal, deviceId: string, input: CredentialInput, meta: RequestMeta) {
    const device = await ownDevice(this.db, p, deviceId);
    // The destination is fixed when the secret is entered. Later edits to the
    // device's management address (dcim.write) must not redirect the secret.
    const host = (input.host ?? device.mgmtAddress ?? '').trim();
    if (!host) throw new BadRequestException({ error: 'no_address', message: 'Enter a host, or set the management address on the hardware record first' });
    if (input.kind === 'snmp_v3') {
      if (input.securityLevel !== 'noAuthNoPriv' && !input.authKey) throw new BadRequestException({ error: 'invalid_credential', message: 'An authentication key is required for this security level' });
      if (input.securityLevel === 'authPriv' && !input.privKey) throw new BadRequestException({ error: 'invalid_credential', message: 'A privacy key is required for authPriv' });
    }
    const { secret, params, username } = split(input);
    const port = input.port ?? null;
    const secretEnc = this.secrets.encrypt(JSON.stringify(secret), credentialContext(p.orgId, deviceId, input.kind, host, port));
    try {
      return await this.db.transaction(async (tx) => {
        const [existing] = await tx.select({ id: deviceCredentials.id }).from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, input.kind)));
        const cols = { host, port, username, secretEnc, params, rotatedAt: new Date(), lastTestAt: null, lastTestOk: null, lastTestMessage: null };
        const [row] = existing
          ? await tx.update(deviceCredentials).set(cols).where(eq(deviceCredentials.id, existing.id)).returning()
          : await tx.insert(deviceCredentials).values({ ...cols, orgId: p.orgId, deviceId, kind: input.kind, createdBy: p.userId }).returning();
        // Audit records which kind changed — never the secret, and not even its length.
        await this.audit.record(
          { orgId: p.orgId, actor: actorFrom(p), action: existing ? 'credential.rotate' : 'credential.create', target: { type: 'device', id: deviceId }, outcome: 'success', meta, metadata: { kind: input.kind, host, port, username } },
          tx,
        );
        return CredentialsService.view(row!);
      });
    } catch (err) {
      rethrowDbError(err);
    }
  }

  async remove(p: Principal, deviceId: string, kind: CredentialKind, meta: RequestMeta) {
    await ownDevice(this.db, p, deviceId);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.delete(deviceCredentials).where(and(eq(deviceCredentials.deviceId, deviceId), eq(deviceCredentials.kind, kind), eq(deviceCredentials.orgId, p.orgId))).returning({ id: deviceCredentials.id });
      if (!row) throw notFound('Credential');
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'credential.delete', target: { type: 'device', id: deviceId }, outcome: 'success', meta, metadata: { kind } }, tx);
    });
  }
}

/** Splits validated input into the encrypted part and the plain settings. */
export function split(input: CredentialInput): { secret: Record<string, string | null>; params: CredentialParams; username: string | null } {
  const raw = input as unknown as Record<string, unknown>;
  const secret: Record<string, string | null> = {};
  for (const f of SECRET_FIELDS[input.kind]) secret[f] = (raw[f] as string | null | undefined) ?? null;
  const params: CredentialParams = {};
  for (const k of ['timeoutMs', 'retries', 'scheme', 'tls', 'verifyTls', 'vdom', 'securityLevel', 'authProtocol', 'privProtocol'] as const) {
    if (raw[k] !== undefined) (params as Record<string, unknown>)[k] = raw[k];
  }
  return { secret, params, username: (raw.username as string | undefined) ?? null };
}
