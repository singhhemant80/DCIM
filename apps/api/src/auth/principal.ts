import type { Permission } from '@crapplet/shared';
import type { Request } from 'express';

/** The authenticated identity attached to every request after AuthGuard. */
export interface Principal {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  userType: 'staff' | 'customer';
  /** Set for customer users only; every tenant-owned query is filtered by it. */
  customerId: string | null;
  permissions: ReadonlySet<Permission>;
  sessionId: string;
  /** Staff must enroll in MFA before doing anything else when the org requires it. */
  mfaEnrollmentRequired: boolean;
  /** Set when the request authenticated with an API key instead of a session. */
  apiKey?: { id: string; name: string } | null;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export type AppRequest = Request & { principal?: Principal; id?: string };

export function requestMeta(req: AppRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    ip: normalizeIp(req.ip),
    userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null,
    requestId: req.id ?? null,
  };
}

/** Strip the IPv4-mapped IPv6 prefix so Postgres `inet` stores a clean address. */
export function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  // Lower-case so the stored value matches Postgres' canonical inet output (audit hashes depend on it).
  return (ip.startsWith('::ffff:') ? ip.slice(7) : ip).toLowerCase();
}

export function hasPermission(p: Principal, perm: Permission): boolean {
  return p.permissions.has(perm);
}
