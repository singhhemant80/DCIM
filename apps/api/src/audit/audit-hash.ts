import { createHash } from 'node:crypto';

export interface HashableAuditEvent {
  orgId: string | null;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  customerId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  prevHash: string | null;
}

/** Deterministic JSON: object keys sorted recursively so the hash is stable across key orderings. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computeAuditHash(e: HashableAuditEvent): string {
  return createHash('sha256').update(canonicalJson(e), 'utf8').digest('hex');
}

const SENSITIVE_KEY = /pass(word)?|secret|token|credential|community|private.?key|api.?key|authorization|cookie/i;

/** Removes anything secret-looking from audit metadata before it is persisted. */
export function sanitizeMetadata(meta: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && depth < 5) {
      out[k] = sanitizeMetadata(v as Record<string, unknown>, depth + 1);
    } else {
      out[k] = v instanceof Date ? v.toISOString() : v;
    }
  }
  return out;
}
