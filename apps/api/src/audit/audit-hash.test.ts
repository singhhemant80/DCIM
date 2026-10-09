import { describe, expect, it } from 'vitest';
import { canonicalJson, computeAuditHash, sanitizeMetadata, type HashableAuditEvent } from './audit-hash';

const base: HashableAuditEvent = {
  orgId: 'o',
  occurredAt: new Date('2026-01-01T00:00:00.000Z'),
  actorType: 'user',
  actorId: null,
  actorLabel: 'a@b.c',
  customerId: null,
  action: 'x',
  targetType: null,
  targetId: null,
  outcome: 'success',
  ip: null,
  userAgent: null,
  requestId: null,
  metadata: { b: 1, a: { d: 2, c: 3 } },
  prevHash: null,
};

describe('audit hashing', () => {
  it('canonical JSON is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('hash changes when any field changes, including the previous hash', () => {
    const h = computeAuditHash(base);
    expect(computeAuditHash({ ...base })).toBe(h);
    expect(computeAuditHash({ ...base, action: 'y' })).not.toBe(h);
    expect(computeAuditHash({ ...base, prevHash: 'abc' })).not.toBe(h);
    expect(computeAuditHash({ ...base, metadata: { b: 2, a: { d: 2, c: 3 } } })).not.toBe(h);
  });

  it('redacts secret-looking metadata keys at any depth', () => {
    const out = sanitizeMetadata({ password: 'p', nested: { snmpCommunity: 'public', apiKey: 'k', ok: 1 }, token: 't', name: 'n' });
    expect(out).toEqual({ password: '[REDACTED]', nested: { snmpCommunity: '[REDACTED]', apiKey: '[REDACTED]', ok: 1 }, token: '[REDACTED]', name: 'n' });
  });
});
