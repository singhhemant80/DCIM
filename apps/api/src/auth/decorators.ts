import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@crapplet/shared';
import type { AppRequest, Principal } from './principal';
import { requestMeta, type RequestMeta } from './principal';

export const IS_PUBLIC = 'cdcim:public';
export const REQUIRED_PERMISSIONS = 'cdcim:permissions';
export const ALLOW_DURING_MFA_ENROLLMENT = 'cdcim:allow-mfa-enrollment';
export const STAFF_ONLY = 'cdcim:staff-only';

/** Route needs no authentication (login, health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** All listed permissions are required. */
export const RequirePermissions = (...perms: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

/** Route stays reachable for staff who must still enroll in MFA (profile, MFA setup, logout). */
export const AllowDuringMfaEnrollment = () => SetMetadata(ALLOW_DURING_MFA_ENROLLMENT, true);

/** Route needs an interactive session: API keys are refused (account, MFA and key management). */
export const SESSION_ONLY = 'cdcim:session-only';
export const SessionOnly = () => SetMetadata(SESSION_ONLY, true);

/** Route is never available to customer-portal users, regardless of role. */
export const StaffOnly = () => SetMetadata(STAFF_ONLY, true);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.principal) throw new Error('CurrentPrincipal used on an unauthenticated route');
  return req.principal;
});

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  return requestMeta(ctx.switchToHttp().getRequest<AppRequest>());
});
