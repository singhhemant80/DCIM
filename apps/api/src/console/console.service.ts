import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ConsoleCredentialInput, ConsoleKind } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { consoleCredentials, consoleSessions, controlCredentials, deviceCredentials, devices, type Device } from '../db/schema';
import { SecretBox } from '../common/secret-box';
import { AuditService, actorFrom } from '../audit/audit.service';
import type { Principal, RequestMeta } from '../auth/principal';

/** SecretBox AAD: a console secret only decrypts for the row it was written for. */
export const consoleContext = (orgId: string, deviceId: string, kind: string, host: string | null, port: number | null) => `console_credential:${orgId}:${deviceId}:${kind}:${(host ?? '').toLowerCase()}:${port ?? ''}`;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A browser has this long to open the console after asking for it. */
export const TICKET_SECONDS = 60;

/**
 * Remote consoles. The API only issues one-time tickets and records who
 * opened what; the worker makes the connection to the BMC. Console secrets
 * are write-only.
 */
@Injectable()
export class ConsoleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
  ) {}

  /** Staff: any device of the organization. Customers: only their own servers. */
  private async device(p: Principal, id: string): Promise<Device> {
    const [d] = await this.db.select().from(devices).where(and(eq(devices.id, id), eq(devices.orgId, p.orgId)));
    if (!d || (p.userType !== 'staff' && (!p.customerId || d.customerId !== p.customerId))) throw new NotFoundException({ error: 'not_found', message: 'Device not found' });
    return d;
  }

  /** The BMC's web address: the configured one, else from the BMC credentials or the management address. */
  private async webUrl(d: Device): Promise<string | null> {
    const [web] = await this.db.select().from(consoleCredentials).where(and(eq(consoleCredentials.deviceId, d.id), eq(consoleCredentials.kind, 'web')));
    if (web?.params?.url) return String(web.params.url);
    const [ctl] = await this.db.select({ host: controlCredentials.host, kind: controlCredentials.kind, port: controlCredentials.port, params: controlCredentials.params }).from(controlCredentials).where(eq(controlCredentials.deviceId, d.id));
    if (ctl?.kind === 'redfish') return `${ctl.params.scheme ?? 'https'}://${ctl.host}${ctl.port && ctl.port !== 443 ? `:${ctl.port}` : ''}/`;
    const [rf] = await this.db.select({ host: deviceCredentials.host, port: deviceCredentials.port, params: deviceCredentials.params }).from(deviceCredentials).where(and(eq(deviceCredentials.deviceId, d.id), eq(deviceCredentials.kind, 'redfish')));
    if (rf?.host) return `${rf.params.scheme ?? 'https'}://${rf.host}${rf.port && rf.port !== 443 ? `:${rf.port}` : ''}/`;
    if (ctl?.host) return `https://${ctl.host}/`;
    if (d.mgmtAddress?.trim()) return /^https?:\/\//i.test(d.mgmtAddress) ? d.mgmtAddress.trim() : `https://${d.mgmtAddress.trim()}/`;
    return null;
  }

  async status(p: Principal, id: string) {
    const d = await this.device(p, id);
    const staff = p.userType === 'staff';
    const creds = await this.db.select().from(consoleCredentials).where(eq(consoleCredentials.deviceId, d.id));
    const by = (k: string) => creds.find((c) => c.kind === k);
    const host = (k: string) => by(k)?.host ?? d.mgmtAddress ?? null;
    const sessions = await this.db
      .select()
      .from(consoleSessions)
      .where(and(eq(consoleSessions.deviceId, d.id), staff ? sql`true` : eq(consoleSessions.userId, p.userId)))
      .orderBy(desc(consoleSessions.createdAt))
      .limit(15);
    const live = sessions.filter((x) => ['connecting', 'active'].includes(x.status));
    return {
      deviceId: d.id,
      // The BMC web interface is for staff: it has its own login and full BMC control.
      web: staff ? { url: await this.webUrl(d), configured: !!by('web') } : null,
      vnc: { configured: !!by('vnc'), ...(staff && by('vnc') ? { host: host('vnc'), port: by('vnc')!.port, rotatedAt: by('vnc')!.rotatedAt } : {}) },
      sol: { configured: !!by('sol'), ...(staff && by('sol') ? { host: host('sol'), port: by('sol')!.port, username: by('sol')!.username, privilege: by('sol')!.params.privilege ?? null, rotatedAt: by('sol')!.rotatedAt } : {}) },
      live: live.map((x) => ({ id: x.id, kind: x.kind, user: staff || x.userId === p.userId ? x.userLabel : 'someone', since: x.connectedAt ?? x.createdAt, mine: x.userId === p.userId })),
      recent: sessions.map((x) => ({ id: x.id, kind: x.kind, user: x.userLabel, status: x.status, createdAt: x.createdAt, connectedAt: x.connectedAt, endedAt: x.endedAt, endReason: x.endReason, bytesIn: x.bytesIn, bytesOut: x.bytesOut })),
    };
  }

  async putCredential(p: Principal, id: string, input: ConsoleCredentialInput, meta: RequestMeta) {
    const d = await this.device(p, id);
    let values: Partial<typeof consoleCredentials.$inferInsert>;
    if (input.kind === 'web') {
      values = { host: null, port: null, username: null, params: { url: input.url }, secretEnc: null };
    } else {
      const h = input.host?.trim() || null;
      if (!h && !d.mgmtAddress?.trim()) throw new BadRequestException({ error: 'host_required', message: 'Enter the BMC address (the device has no management address)' });
      const secret = { password: input.password };
      values = {
        host: h,
        port: input.port,
        username: input.kind === 'sol' ? input.username : null,
        params: input.kind === 'sol' ? { privilege: input.privilege } : {},
        secretEnc: this.secrets.encrypt(JSON.stringify(secret), consoleContext(p.orgId, d.id, input.kind, h, input.port)),
      };
    }
    await this.db.transaction(async (tx) => {
      await tx
        .insert(consoleCredentials)
        .values({ deviceId: d.id, kind: input.kind, orgId: p.orgId, ...values })
        .onConflictDoUpdate({ target: [consoleCredentials.deviceId, consoleCredentials.kind], set: { ...values, rotatedAt: new Date(), updatedAt: new Date() } });
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'console.credential', target: { type: 'device', id: d.id }, outcome: 'success', meta, metadata: { kind: input.kind, host: values.host ?? null, port: values.port ?? null } }, tx);
    });
    return { kind: input.kind, configured: true };
  }

  async deleteCredential(p: Principal, id: string, kind: string, meta: RequestMeta) {
    const d = await this.device(p, id);
    const rows = await this.db.delete(consoleCredentials).where(and(eq(consoleCredentials.deviceId, d.id), eq(consoleCredentials.kind, kind))).returning();
    if (!rows.length) throw new NotFoundException({ error: 'not_found', message: 'Not configured' });
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'console.credential_delete', target: { type: 'device', id: d.id }, outcome: 'success', meta, metadata: { kind } });
  }

  /** Staff only: the BMC's web console address, recorded in the audit log when opened. */
  async openWeb(p: Principal, id: string, meta: RequestMeta) {
    if (p.userType !== 'staff') throw new ForbiddenException({ error: 'forbidden', message: 'The BMC web interface is for datacenter staff' });
    const d = await this.device(p, id);
    const url = await this.webUrl(d);
    if (!url) throw new BadRequestException({ error: 'no_bmc_address', message: 'Set the BMC web address, a BMC credential or a management address for this device' });
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'console.web_open', target: { type: 'device', id: d.id }, outcome: 'success', meta, metadata: { url } });
    return { url };
  }

  /**
   * Starts a console: checks access, makes sure nobody else holds this
   * console, and issues a one-time ticket for the browser's WebSocket
   * (valid for a minute, stored only as a hash).
   */
  async start(p: Principal, id: string, kind: ConsoleKind, meta: RequestMeta) {
    const d = await this.device(p, id);
    if (d.lifecycleState === 'retired') throw new BadRequestException({ error: 'retired', message: 'This device is retired' });
    const [cred] = await this.db.select({ kind: consoleCredentials.kind }).from(consoleCredentials).where(and(eq(consoleCredentials.deviceId, d.id), eq(consoleCredentials.kind, kind)));
    if (!cred) throw new BadRequestException({ error: 'not_configured', message: kind === 'vnc' ? 'The graphical console is not set up for this server' : 'The serial console is not set up for this server' });
    // Tickets never used, and connections that never came up, free their slot.
    await this.db
      .update(consoleSessions)
      .set({ status: 'failed', endReason: 'Not opened in time', endedAt: new Date(), ticketHash: null, relayHash: null })
      .where(and(eq(consoleSessions.deviceId, d.id), sql`(${consoleSessions.status} = 'pending' and ${consoleSessions.ticketExpiresAt} < now()) or (${consoleSessions.status} = 'connecting' and ${consoleSessions.createdAt} < now() - interval '2 minutes')`));
    const ticket = randomBytes(32).toString('base64url');
    try {
      const [row] = await this.db
        .insert(consoleSessions)
        .values({
          orgId: p.orgId,
          deviceId: d.id,
          kind,
          userId: p.userId,
          userLabel: p.email,
          userType: p.userType,
          clientIp: meta.ip ?? null,
          ticketHash: sha256(ticket),
          ticketExpiresAt: new Date(Date.now() + TICKET_SECONDS * 1000),
        })
        .returning();
      await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'console.start', target: { type: 'device', id: d.id }, outcome: 'success', meta, metadata: { kind, sessionId: row!.id } });
      return { sessionId: row!.id, ticket, path: '/api/v1/console/ws' };
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code !== '23505') throw e;
      const [cur] = await this.db.select({ user: consoleSessions.userLabel, userId: consoleSessions.userId }).from(consoleSessions).where(and(eq(consoleSessions.deviceId, d.id), eq(consoleSessions.kind, kind), sql`${consoleSessions.status} in ('pending','connecting','active')`));
      const who = cur && (p.userType === 'staff' || cur.userId === p.userId) ? cur.user : 'another user';
      throw new ConflictException({ error: 'console_in_use', message: `This console is already open by ${who}. Close it there, or ${p.userType === 'staff' ? 'end that session' : 'ask the datacenter team'}.` });
    }
  }

  /** Ends a session: its owner, or staff with console access. The worker sees the status and disconnects. */
  async end(p: Principal, sessionId: string, meta: RequestMeta) {
    const [s] = await this.db.select().from(consoleSessions).where(and(eq(consoleSessions.id, sessionId), eq(consoleSessions.orgId, p.orgId)));
    if (!s || (p.userType !== 'staff' && s.userId !== p.userId)) throw new NotFoundException({ error: 'not_found', message: 'Session not found' });
    if (!['pending', 'connecting', 'active'].includes(s.status)) return { ended: false };
    const by = s.userId === p.userId ? 'Closed by the user' : `Ended by ${p.email}`;
    await this.db.update(consoleSessions).set({ status: 'ended', endedAt: new Date(), endReason: by, ticketHash: null }).where(and(eq(consoleSessions.id, sessionId), sql`${consoleSessions.status} in ('pending','connecting','active')`));
    await this.audit.record({ orgId: p.orgId, actor: actorFrom(p), action: 'console.end', target: { type: 'device', id: s.deviceId }, outcome: 'success', meta, metadata: { sessionId } });
    return { ended: true };
  }
}
