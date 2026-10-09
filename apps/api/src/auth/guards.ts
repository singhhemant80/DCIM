import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@crapplet/shared';
import { AuditService } from '../audit/audit.service';
import { ALLOW_DURING_MFA_ENROLLMENT, IS_PUBLIC, REQUIRED_PERMISSIONS, STAFF_ONLY } from './decorators';
import { CSRF_HEADER, SESSION_COOKIE } from './cookies';
import { requestMeta, type AppRequest } from './principal';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: every route requires a valid session unless marked @Public.
 * Also enforces CSRF on unsafe methods and the MFA-enrollment gate.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    const resolved = token ? await this.sessions.resolve(token) : null;
    if (!resolved) throw new UnauthorizedException({ error: 'unauthenticated', message: 'Sign in required' });

    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers[CSRF_HEADER];
      if (!this.sessions.verifyCsrf(resolved.session, typeof header === 'string' ? header : undefined)) {
        throw new ForbiddenException({ error: 'csrf_failed', message: 'Missing or invalid CSRF token' });
      }
    }

    if (resolved.principal.mfaEnrollmentRequired && !this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_MFA_ENROLLMENT, targets)) {
      throw new ForbiddenException({ error: 'mfa_enrollment_required', message: 'Set up multi-factor authentication to continue' });
    }

    req.principal = resolved.principal;
    return true;
  }
}

/** Global guard: checks @RequirePermissions and @StaffOnly. Denials are audited. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    const staffOnly = this.reflector.getAllAndOverride<boolean>(STAFF_ONLY, targets) ?? false;
    const req = ctx.switchToHttp().getRequest<AppRequest>();
    const p = req.principal;
    if (!p) return true; // public route; AuthGuard already decided

    const missing = required.filter((perm) => !p.permissions.has(perm));
    const staffViolation = staffOnly && p.userType !== 'staff';
    if (missing.length === 0 && !staffViolation) return true;

    await this.audit.record({
      orgId: p.orgId,
      actor: { type: 'user', id: p.userId, label: p.email },
      customerId: p.customerId,
      action: 'access.denied',
      target: { type: 'route', id: `${req.method} ${req.route?.path ?? req.path}` },
      outcome: 'denied',
      meta: requestMeta(req),
      metadata: { missing, staffOnly: staffViolation },
    });
    throw new ForbiddenException({ error: 'forbidden', message: 'You do not have permission to perform this action' });
  }
}
