import { and, eq } from 'drizzle-orm';
import { addMonth } from '@crapplet/shared';
import type { DbOrTx } from '../db/db';
import { services, subscriptions, vpsOrders, vpsPlans, walletTransactions, type VpsOrder } from '../db/schema';
import type { AuditInput, AuditService } from '../audit/audit.service';
import { issueInvoice, loadSettings, moveWallet } from './ledger';

interface Who {
  now: Date;
  actor: AuditInput['actor'];
  meta: AuditInput['meta'];
}

/**
 * A paid order whose VPS exists: monthly subscription, service record and
 * tax invoice (for the amount already taken from the wallet), in the
 * caller's transaction. Returns null (and marks the order for review) when
 * billing settings are missing.
 */
export async function deliverOrder(tx: DbOrTx, audit: AuditService, order: VpsOrder, w: Who & { guestId: string | null; vpsid: string | null }) {
  const settings = await loadSettings(tx, order.orgId);
  if (!settings) {
    await tx.update(vpsOrders).set({ status: 'review', error: 'The VPS was created, but billing settings are missing, so no invoice could be issued', settledAt: w.now }).where(eq(vpsOrders.id, order.id));
    return null;
  }
  const [plan] = await tx.select().from(vpsPlans).where(eq(vpsPlans.id, order.planId));
  const planName = plan?.name ?? 'VPS';
  const periodTo = addMonth(w.now);
  const [sub] = await tx
    .insert(subscriptions)
    .values({
      orgId: order.orgId,
      customerId: order.customerId,
      planId: order.planId,
      guestId: w.guestId,
      name: `${planName} — ${order.hostname}`,
      pricePaise: order.pricePaise,
      status: 'active',
      periodStart: w.now,
      nextDueAt: periodTo,
      orderId: order.id,
    })
    .returning();
  const [svc] = await tx
    .insert(services)
    .values({
      orgId: order.orgId,
      customerId: order.customerId,
      kind: 'vps',
      name: order.hostname,
      description: `${planName}${w.vpsid ? ` (Virtualizor VPS ${w.vpsid})` : ''}, billed monthly from the wallet`,
      status: 'active',
      startDate: w.now.toISOString().slice(0, 10),
      guestId: w.guestId,
    })
    .returning({ id: services.id });
  await tx.update(subscriptions).set({ serviceId: svc!.id }).where(eq(subscriptions.id, sub!.id));
  const inv = await issueInvoice(tx, {
    orgId: order.orgId,
    customerId: order.customerId,
    settings,
    at: w.now,
    rateBp: order.gstRateBp,
    placeOfSupply: order.placeOfSupply,
    subscriptionId: sub!.id,
    orderId: order.id,
    lines: [
      {
        description: `${/vps/i.test(planName) ? planName : `VPS ${planName}`} — ${order.hostname}${order.osName ? ` (${order.osName})` : ''}`,
        quantity: 1,
        unitPaise: order.pricePaise,
        periodFrom: w.now.toISOString(),
        periodTo: periodTo.toISOString(),
        subscriptionId: sub!.id,
      },
    ],
  });
  await tx
    .update(walletTransactions)
    .set({ invoiceId: inv.id, subscriptionId: sub!.id })
    .where(and(eq(walletTransactions.orderId, order.id), eq(walletTransactions.kind, 'debit')));
  await tx.update(vpsOrders).set({ status: 'active', guestId: w.guestId, invoiceId: inv.id, subscriptionId: sub!.id, error: null, settledAt: w.now }).where(eq(vpsOrders.id, order.id));
  await audit.record(
    {
      orgId: order.orgId,
      actor: w.actor,
      customerId: order.customerId,
      action: 'billing.order_delivered',
      target: { type: 'vps_order', id: order.id },
      outcome: 'success',
      meta: w.meta,
      metadata: { hostname: order.hostname, invoice: inv.number, total: inv.totalPaise },
    },
    tx,
  );
  return inv;
}

/** Gives the whole amount of an order back to the wallet. */
export async function refundOrder(tx: DbOrTx, audit: AuditService, order: VpsOrder, w: Who & { reason: string }) {
  await moveWallet(tx, {
    orgId: order.orgId,
    customerId: order.customerId,
    kind: 'refund',
    amountPaise: order.totalPaise,
    description: `Refund: VPS ${order.hostname} was not created (${w.reason})`,
    orderId: order.id,
    actorLabel: w.actor.label,
  });
  await tx.update(vpsOrders).set({ status: 'refunded', error: w.reason, settledAt: w.now }).where(eq(vpsOrders.id, order.id));
  await audit.record(
    {
      orgId: order.orgId,
      actor: w.actor,
      customerId: order.customerId,
      action: 'billing.order_refunded',
      target: { type: 'vps_order', id: order.id },
      outcome: 'success',
      meta: w.meta,
      metadata: { hostname: order.hostname, reason: w.reason, amount: order.totalPaise },
    },
    tx,
  );
}
