import type { Permission } from '@crapplet/shared';

export interface Me {
  user: {
    id: string;
    email: string;
    name: string;
    userType: 'staff' | 'customer';
    customerId: string | null;
    mfaEnabled: boolean;
    recoveryCodesRemaining: number;
    lastLoginAt: string | null;
  };
  organization: { id: string; name: string; currency: string; timezone: string };
  permissions: Permission[];
  mfaEnrollmentRequired: boolean;
  sessionId: string;
}

export interface Customer {
  id: string;
  code: string;
  name: string;
  contactEmail: string | null;
  phone: string | null;
  status: 'active' | 'suspended' | 'closed';
  billingReference?: string | null;
  notes?: string | null;
  userCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  userType: 'staff' | 'customer';
  customerId: string | null;
  customerName: string | null;
  status: 'active' | 'disabled';
  mfaEnabled: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  roles: { id: string; name: string }[];
}

export interface RoleRow {
  id: string;
  name: string;
  description: string;
  scope: 'staff' | 'customer';
  permissions: string[];
  system: boolean;
  systemKey: string | null;
  members: number;
}

export interface PermissionDef {
  key: string;
  label: string;
  group: string;
  staffOnly: boolean;
  dangerous?: boolean;
}

export interface AuditEvent {
  id: number;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  customerId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'failure' | 'denied';
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

export interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}
