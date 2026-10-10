import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { ChannelKind } from '@crapplet/shared';
import type { Db } from '../../db/db';
import { notificationChannels, notifications } from '../../db/schema';
import type { SecretBox } from '../../common/secret-box';
import { channelContext } from '../../monitoring/channels';
import { redact } from '../processor';

/**
 * Delivers the notification outbox. Rows are claimed with SKIP LOCKED (a
 * claimed row is leased for 2 minutes), retried with exponential backoff and
 * marked failed after MAX_ATTEMPTS. Channel secrets are decrypted here only.
 */
export const MAX_ATTEMPTS = 6;

export interface NotifyDeps {
  db: Db;
  secrets: SecretBox;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Overridable for tests. */
  telegramApiUrl?: string;
  timeoutMs?: number;
  /**
   * Allow webhook / SMTP destinations on private, loopback or link-local
   * addresses (CDCIM_NOTIFY_ALLOW_PRIVATE=true). Off by default so a channel
   * can't be used to probe the internal network from the worker.
   */
  allowPrivate?: boolean;
}

/** True for loopback, RFC 1918, CGNAT, link-local (incl. cloud metadata), ULA and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return isPrivateAddress(x.slice(7));
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff');
  }
  return true;
}

async function checkDestination(host: string, allowPrivate: boolean | undefined): Promise<void> {
  if (allowPrivate) return;
  const h = host.replace(/^\[|\]$/g, '');
  const addrs = isIP(h) ? [h] : (await lookup(h, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) {
    throw new Error(`Destination ${host} resolves to a private or local address; set CDCIM_NOTIFY_ALLOW_PRIVATE=true on the worker to allow internal receivers`);
  }
}

export interface NotificationPayload {
  event: 'firing' | 'resolved' | 'test';
  title: string;
  text: string;
  alert: null | {
    id: string;
    rule: string;
    metric: string;
    severity: string;
    status: string;
    message: string;
    device: string | null;
    interface: string | null;
    startedAt: string;
    resolvedAt: string | null;
    value: number | null;
    peak: number | null;
  };
}

type Claimed = {
  id: string;
  org_id: string;
  channel_id: string;
  alert_id: string | null;
  event: 'firing' | 'resolved' | 'test';
  attempts: number;
};

async function payloadFor(db: Db, n: Claimed): Promise<NotificationPayload> {
  if (n.event === 'test' || !n.alert_id) {
    return { event: 'test', title: 'Crapplet DCIM test notification', text: 'This is a test notification from Crapplet DCIM. If you can read it, the channel works.', alert: null };
  }
  const r = await db.execute<Record<string, unknown>>(sql`
    select a.*, coalesce(d.hostname, d.asset_tag) as device_name, i.name as interface_name
      from alerts a left join devices d on d.id = a.device_id left join interfaces i on i.id = a.interface_id
     where a.id = ${n.alert_id}`);
  const a = r.rows[0];
  if (!a) throw new Error('The alert no longer exists');
  const sev = String(a.severity).toUpperCase();
  const title = n.event === 'resolved' ? `[RESOLVED] ${a.rule_name}` : `[${sev}] ${a.rule_name}`;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    event: n.event,
    title,
    text: `${title}\n${a.message as string}\nStarted ${iso(a.started_at)}${n.event === 'resolved' && a.resolved_at ? `, resolved ${iso(a.resolved_at)}` : ''}`,
    alert: {
      id: a.id as string,
      rule: a.rule_name as string,
      metric: a.metric as string,
      severity: a.severity as string,
      status: a.status as string,
      message: a.message as string,
      device: (a.device_name as string | null) ?? null,
      interface: (a.interface_name as string | null) ?? null,
      startedAt: iso(a.started_at)!,
      resolvedAt: iso(a.resolved_at),
      value: (a.last_value as number | null) ?? null,
      peak: (a.peak_value as number | null) ?? null,
    },
  };
}

async function post(url: string, body: string, headers: Record<string, string>, timeoutMs: number, allowPrivate?: boolean): Promise<void> {
  await checkDestination(new URL(url).hostname, allowPrivate);
  const res = await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  // The response body is not kept: only the status code is recorded.
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status} from the receiver`);
}

export async function send(kind: ChannelKind, config: Record<string, unknown>, secret: Record<string, unknown>, p: NotificationPayload, deps: Pick<NotifyDeps, 'telegramApiUrl' | 'timeoutMs' | 'allowPrivate'>): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const ap = deps.allowPrivate;
  switch (kind) {
    case 'webhook': {
      const body = JSON.stringify({ ...p, sentAt: new Date().toISOString() });
      const ts = Math.floor(Date.now() / 1000).toString();
      // Receivers verify HMAC-SHA256(secret, "<timestamp>.<body>") and reject old timestamps.
      const sig = createHmac('sha256', String(secret.signingSecret)).update(`${ts}.${body}`).digest('hex');
      return post(String(config.url), body, { 'x-cdcim-event': p.event, 'x-cdcim-timestamp': ts, 'x-cdcim-signature': `sha256=${sig}` }, timeoutMs, ap);
    }
    case 'slack':
      return post(String(secret.webhookUrl), JSON.stringify({ text: p.text }), {}, timeoutMs, ap);
    case 'telegram': {
      const base = (deps.telegramApiUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
      return post(`${base}/bot${String(secret.botToken)}/sendMessage`, JSON.stringify({ chat_id: config.chatId, text: p.text, disable_web_page_preview: true }), {}, timeoutMs, ap || !!deps.telegramApiUrl);
    }
    case 'email': {
      const security = String(config.smtpSecurity ?? 'starttls');
      await checkDestination(String(config.smtpHost), ap);
      const transport = nodemailer.createTransport({
        host: String(config.smtpHost),
        port: Number(config.smtpPort ?? 587),
        secure: security === 'tls',
        requireTLS: security === 'starttls',
        ignoreTLS: security === 'none',
        auth: config.smtpUser ? { user: String(config.smtpUser), pass: String(secret.smtpPassword ?? '') } : undefined,
        connectionTimeout: timeoutMs,
        greetingTimeout: timeoutMs,
        socketTimeout: timeoutMs,
      });
      try {
        await transport.sendMail({ from: String(config.from), to: (config.to as string[]).join(', '), subject: p.title, text: p.text });
      } finally {
        transport.close();
      }
      return;
    }
  }
}

/**
 * Delivers due notifications; returns how many were sent. Rows are claimed one
 * at a time (each leased for 2 minutes, longer than one delivery can take), so
 * a slow channel never lets a second worker re-claim rows still in progress.
 */
export async function deliverDue(deps: NotifyDeps, limit = 20): Promise<{ sent: number; failed: number }> {
  const { db } = deps;
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < limit; i++) {
    const claimed = await db.execute<Claimed>(sql`
      update notifications set attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
       where id = (select id from notifications where status = 'pending' and next_attempt_at <= now()
                    order by next_attempt_at limit 1 for update skip locked)
      returning id, org_id, channel_id, alert_id, event, attempts`);
    const n = claimed.rows[0];
    if (!n) break;
    let secret: Record<string, unknown> = {};
    try {
      const [ch] = await db.select().from(notificationChannels).where(eq(notificationChannels.id, n.channel_id));
      if (!ch || ch.orgId !== n.org_id) throw new Error('The channel was removed');
      try {
        secret = JSON.parse(deps.secrets.decrypt(ch.secretEnc, channelContext(ch.orgId, ch.id, ch.kind))) as Record<string, unknown>;
      } catch {
        throw new Error('The channel secret could not be decrypted; save the channel again');
      }
      const payload = await payloadFor(db, n);
      await send(ch.kind, ch.config, secret, payload, deps);
      await db.update(notifications).set({ status: 'sent', sentAt: new Date(), lastError: null }).where(eq(notifications.id, n.id));
      await db.update(notificationChannels).set({ lastSentAt: new Date(), lastError: null }).where(eq(notificationChannels.id, n.channel_id));
      sent++;
    } catch (e) {
      const msg = redact((e as Error)?.message || 'Unknown error', secret);
      const final = n.attempts >= MAX_ATTEMPTS;
      await db
        .update(notifications)
        .set(final ? { status: 'failed', lastError: msg } : { lastError: msg, nextAttemptAt: new Date(Date.now() + 30_000 * 2 ** (n.attempts - 1)) })
        .where(eq(notifications.id, n.id));
      await db.update(notificationChannels).set({ lastError: msg }).where(eq(notificationChannels.id, n.channel_id));
      deps.logger.warn({ notificationId: n.id, channelId: n.channel_id, attempt: n.attempts, err: msg }, 'notification delivery failed');
      if (final) failed++;
    } finally {
      secret = {};
    }
  }
  return { sent, failed };
}
