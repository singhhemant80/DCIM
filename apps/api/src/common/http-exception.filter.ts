import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';

/**
 * Converts every error into a consistent JSON shape:
 *   { error: string, message: string, requestId: string, issues?: [...] }
 *
 * Unexpected errors are logged in full (with request id) but the client only
 * receives a generic message — internal details, SQL and stack traces never
 * leave the server.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const requestId = (req as Request & { id?: string }).id ?? '';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === 'string'
          ? { error: codeFor(status), message: body }
          : { error: codeFor(status), ...(body as Record<string, unknown>) };
      // Nest's default bodies include statusCode; keep the shape uniform.
      delete (payload as Record<string, unknown>).statusCode;
      const msg = (payload as { message?: unknown }).message;
      if (Array.isArray(msg)) (payload as { message?: unknown }).message = msg.join('; ');
      if (status >= 500) this.logger.error({ err: exception, requestId }, 'HTTP exception');
      res.status(status).json({ ...payload, requestId });
      return;
    }

    // body-parser errors (malformed JSON, payload too large) carry a status.
    const maybeStatus = (exception as { status?: number; type?: string })?.status;
    if (typeof maybeStatus === 'number' && maybeStatus >= 400 && maybeStatus < 500) {
      res.status(maybeStatus).json({ error: codeFor(maybeStatus), message: 'Malformed request', requestId });
      return;
    }

    this.logger.error({ err: exception, requestId, method: req.method, url: req.url }, 'Unhandled error');
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'internal_error', message: 'An unexpected error occurred', requestId });
  }
}

function codeFor(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 423:
      return 'locked';
    case 429:
      return 'rate_limited';
    default:
      return status >= 500 ? 'internal_error' : 'error';
  }
}
