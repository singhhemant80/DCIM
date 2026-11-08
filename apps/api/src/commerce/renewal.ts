import { eq } from 'drizzle-orm';
import { addMonth } from '@crapplet/shared';
import type { DbOrTx } from '../db/db';
import { customers, subscriptions, type BillingSetting, type Invoice, type Subscription } from '../db/schema';
import { InsufficientFunds, issueInvoice, moveWallet, taxFor } from './ledger';

/**
 * Charges one month of a subscription from the wallet, in the caller's transaction (the subscription
 * row locked by the caller): GST invoice, wallet debit, next due date one month on. A suspended
 * subscription starts its new month today; otherwise the month follows the current due date (so an
 * early "Renew now" extends it). Throws InsufficientFunds when the wallet is short; nothing changes then.
 * Returns the invoice and whether the VPS needs unsuspending.
 */
export async function chargeRenewal(tx: DbOrTx, s: Subscription, settings: BillingSetting, now: Date, actorLabel: string): Promise<{ invoice: Invoice; unsuspend: boolean }> {
  const [c] = await tx.select().from(customers).where(eq(customers.id, s.customerId));
  const t = taxFor(settings, c!, s.pricePaise);
  const from = s.status === 'suspended' ? now : s.nextDueAt;
  const to = addMonth(from);
  if (c!.walletBalancePaise < t.totalPaise) {
    throw new InsufficientFunds(c!.walletBalancePaise, t.totalPaise);
  }
  const invoice = await issueInvoice(tx, {
    orgId: s.orgId,
    customerId: s.customerId,
    settings,
    at: now,
    rateBp: t.rateBp,
    placeOfSupply: t.placeOfSupply,
    subscriptionId: s.id,
    lines: [{ description: `${s.name} — renewal`, quantity: 1, unitPaise: s.pricePaise, periodFrom: from.toISOString(), periodTo: to.toISOString(), subscriptionId: s.id }],
  });
  await moveWallet(tx, { orgId: s.orgId, customerId: s.customerId, kind: 'debit', amountPaise: -invoice.totalPaise, description: `Renewal ${s.name} (invoice ${invoice.number})`, invoiceId: invoice.id, subscriptionId: s.id, actorLabel });
  await tx.update(subscriptions).set({ status: 'active', periodStart: from, nextDueAt: to, overdueSince: null, lastError: null }).where(eq(subscriptions.id, s.id));
  return { invoice, unsuspend: s.status === 'suspended' };
}

/** When an unpaid subscription is suspended and terminated under the organization's terms (null = never). */
export function unpaidTerms(s: Pick<Subscription, 'status' | 'overdueSince' | 'nextDueAt'>, settings: Pick<BillingSetting, 'graceDays' | 'terminateDays'> | null) {
  if (!settings || (s.status !== 'overdue' && s.status !== 'suspended')) return { suspendsAt: null, terminatesAt: null };
  const since = (s.overdueSince ?? s.nextDueAt).getTime();
  return { suspendsAt: s.status === 'overdue' ? new Date(since + settings.graceDays * 86_400_000) : null, terminatesAt: settings.terminateDays > 0 ? new Date(since + settings.terminateDays * 86_400_000) : null };
}
