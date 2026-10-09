import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';

/**
 * Structured JSON logging. Anything that could carry a secret is redacted by
 * path so it never reaches log storage, even if a developer logs a whole
 * request or DTO by mistake.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.challengeToken',
  '*.secret',
  '*.mfaSecretEnc',
  '*.community',
  '*.authKey',
  '*.privKey',
  '*.secretEnc',
  '*.apiKey',
  '*.privateKey',
];

export function createLogger(level: string, pretty = false, service = 'crapplet-dcim-api'): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
  });
}

/** Adapts pino to Nest's LoggerService so framework logs are structured too. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}
  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string) {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}

export const LOGGER = Symbol('LOGGER');
