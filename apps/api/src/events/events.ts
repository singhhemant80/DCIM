import type { EventType } from '@crapplet/shared';
import type { DbOrTx } from '../db/db';
import { domainEvents } from '../db/schema';

export interface EmitInput {
  orgId: string;
  type: EventType;
  customerId?: string | null;
  subject?: { type: string; id: string };
  /** Plain facts about the change. Never credentials, tokens or personal ID data. */
  payload: Record<string, unknown>;
  causedByRunId?: string | null;
}

/**
 * Records a domain event in the caller's transaction, so an event exists if
 * and only if the change was committed. The worker fans events out to webhook
 * subscriptions and workflows.
 */
export async function emitEvent(tx: DbOrTx, e: EmitInput): Promise<void> {
  await tx.insert(domainEvents).values({
    orgId: e.orgId,
    type: e.type,
    customerId: e.customerId ?? null,
    subjectType: e.subject?.type ?? null,
    subjectId: e.subject?.id ?? null,
    payload: e.payload,
    causedByRunId: e.causedByRunId ?? null,
  });
}
