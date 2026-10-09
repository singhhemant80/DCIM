import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { auditQuerySchema, Paginated } from '@crapplet/shared';
import { DB, type Db, type DbOrTx } from '../db/db';
import { auditEvents, type AuditEvent } from '../db/schema';
import type { Principal, RequestMeta } from '../auth/principal';
import { computeAuditHash, sanitizeMetadata } from './audit-hash';

export interface AuditInput {
  orgId: string | null;
  actor: { type: 'user' | 'system' | 'api_key' | 'anonymous'; id?: string | null; label?: string | null };
  customerId?: string | null;
  action: string;
  target?: { type: string; id: string | null };
  outcome: 'success' | 'failure' | 'denied';
  meta?: RequestMeta;
  metadata?: Record<string, unknown>;
}

export function actorFrom(p: Principal): AuditInput['actor'] {
  return { type: 'user', id: p.userId, label: p.email };
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Appends an event to the organization's hash chain.
   *
   * Pass `tx` when auditing a mutation so the audit row and the change commit
   * or roll back together — a privileged change can never succeed without
   * its audit record. A per-organization advisory lock serializes chain
   * appends so concurrent writers cannot fork the chain.
   */
  async record(input: AuditInput, tx?: DbOrTx): Promise<void> {
    if (tx) return this.append(input, tx);
    await this.db.transaction((t) => this.append(input, t));
  }

  private async append(input: AuditInput, tx: DbOrTx): Promise<void> {
    const lockKey = input.orgId ?? 'global';
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'audit:' + lockKey}, 0))`);

    const orgCond = input.orgId ? eq(auditEvents.orgId, input.orgId) : isNull(auditEvents.orgId);
    const [prev] = await tx
      .select({ hash: auditEvents.hash })
      .from(auditEvents)
      .where(orgCond)
      .orderBy(desc(auditEvents.id))
      .limit(1);

    const row = {
      orgId: input.orgId,
      // Millisecond precision so the value round-trips through timestamptz exactly.
      occurredAt: new Date(Date.now()),
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      actorLabel: input.actor.label ?? null,
      customerId: input.customerId ?? null,
      action: input.action,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id ?? null,
      outcome: input.outcome,
      ip: input.meta?.ip ?? null,
      userAgent: input.meta?.userAgent ?? null,
      requestId: input.meta?.requestId ?? null,
      metadata: sanitizeMetadata(input.metadata ?? {}),
      prevHash: prev?.hash ?? null,
    };
    await tx.insert(auditEvents).values({ ...row, hash: computeAuditHash(row) });
  }

  async list(principal: Principal, q: z.infer<typeof auditQuerySchema>): Promise<Paginated<AuditEvent>> {
    const conds: SQL[] = [eq(auditEvents.orgId, principal.orgId)];
    if (q.action) conds.push(eq(auditEvents.action, q.action));
    if (q.actorId) conds.push(eq(auditEvents.actorId, q.actorId));
    if (q.targetType) conds.push(eq(auditEvents.targetType, q.targetType));
    if (q.outcome) conds.push(eq(auditEvents.outcome, q.outcome));
    if (q.from) conds.push(gte(auditEvents.occurredAt, new Date(q.from)));
    if (q.to) conds.push(lte(auditEvents.occurredAt, new Date(q.to)));
    const where = and(...conds);

    const [items, [{ total } = { total: 0 }]] = await Promise.all([
      this.db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      this.db.select({ total: count() }).from(auditEvents).where(where),
    ]);
    return { items, page: q.page, pageSize: q.pageSize, total };
  }

  /**
   * Re-computes the chain for an organization. Returns the id of the first
   * broken link, or null if the chain is intact. Streams in batches so large
   * logs do not load into memory at once.
   */
  async verifyChain(orgId: string): Promise<{ ok: boolean; checked: number; brokenAtId: number | null }> {
    let prevHash: string | null = null;
    let lastId = 0;
    let checked = 0;
    for (;;) {
      const batch = await this.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, orgId), gt(auditEvents.id, lastId)))
        .orderBy(asc(auditEvents.id))
        .limit(1000);
      if (batch.length === 0) break;
      for (const e of batch) {
        const { id, hash, ...rest } = e;
        const expected = computeAuditHash({ ...rest, metadata: rest.metadata ?? {} });
        if (e.prevHash !== prevHash || expected !== hash) {
          return { ok: false, checked, brokenAtId: id };
        }
        prevHash = hash;
        lastId = id;
        checked++;
      }
    }
    return { ok: true, checked, brokenAtId: null };
  }
}
