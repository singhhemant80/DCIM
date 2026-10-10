import { CHANNEL_SECRET_FIELDS, type ChannelInput, type ChannelKind } from '@crapplet/shared';

/**
 * Notification channel secrets (SMTP password, webhook signing secret, Slack
 * webhook URL, Telegram bot token) are stored SecretBox-encrypted, bound to
 * the organization, channel id and kind, and only decrypted by the worker
 * when it delivers. The API never returns them.
 */
export function channelContext(orgId: string, channelId: string, kind: ChannelKind): string {
  return `notification_channel:${orgId}:${channelId}:${kind}`;
}

/** Splits a validated channel into its public config and its secret part. */
export function splitChannel(input: ChannelInput): { config: Record<string, unknown>; secret: Record<string, unknown> } {
  const secretFields = new Set(CHANNEL_SECRET_FIELDS[input.kind]);
  const config: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'kind' || k === 'name' || k === 'enabled') continue;
    (secretFields.has(k) ? secret : config)[k] = v;
  }
  return { config, secret };
}
