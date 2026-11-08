import { and, eq, sql } from 'drizzle-orm';
import { addMonth, formatInr } from '@crapplet/shared';
import { customers, provisioningJobs, services, subscriptions, virtGuests, virtHosts, virtIntegrations, vpsOrders, type Subscription } from '../../db/schema';
import { AuditService } from '../../audit/audit.service';
import { InsufficientFunds, issueInvoice, loadSettings, moveWallet, taxFor } from '../../commerce/ledger';
import { deliverOrder, refundOrder } from '../../commerce/delivery';
import { virtClientFor, type ProvisioningDeps } from '../provisioning/kinds';

/**
 * Billing cycle (worker, every minute):
 *
 * 1. Settle orders whose VPS job has finished. Created → tax invoice,
 *    monthly subscription and service record. Not created (Virtualizor
 *    refused, or the job stopped before the request) → refund to the wallet.
 *    Unclear (the request went out but no answer came back) → "review" for
 *    staff: nothing is refunded or invoiced automatically.
 * 2. Renew subscriptions that are due: paid from the wallet when the balance
 *    covers price + GST (invoice issued, next due date one month on);
 *    otherwise overdue, and after the grace days the VPS is suspended in
 *    Virtualizor (administrative suspension, nothing deleted). A wallet
 *    top-up is picked up on the next run: the renewal is charged and a
 *    suspended VPS is unsuspended, its new period starting that day.
 */

const SYSTEM = { type: 'system' as const, label: 'billing' };
const META = { ip: null, userAgent: null, requestId: null };
/** A failed suspend/unsuspend is retried after this long. */
const RETRY_MS = 10 * 60_000;

export async function runBillingCycle(deps: ProvisioningDeps, now: Date = deps.now?.() ?? new Date()): Promise<{ settled: number; renewed: number; overdue: number; suspended: number; unsuspended: number }> {
  const out = { settled: 0, renewed: 0, overdue: 0, suspended: 0, unsuspended: 0 };
  out.settled = await settleOrders(deps, now);
  await endCancelled(deps, now);
  Object.assign(out, await renewDue(deps, now));
  await runPendingActions(deps, now);
  out.unsuspended += await retryUnsuspend(deps, now);
  return out;
}

/* ------------------------------------------------------------------ orders */

async function settleOrders(deps: ProvisioningDeps, now: Date): Promise<number> {
  const audit = new AuditService(deps.db);
  const due = await deps.db.execute<{ id: string }>(sql`
    select o.id from vps_orders o join provisioning_jobs j on j.id = o.job_id
     where o.status = 'provisioning' and j.status in ('completed', 'failed', 'cancelled') order by o.created_at limit 50`);
  let n = 0;
  for (const { id } of due.rows) {
    try {
      await deps.db.transaction(async (tx) => {
        const locked = await tx.execute(sql`select id from vps_orders where id = ${id} and status = 'provisioning' for update skip locked`);
        if (!locked.rows.length) return;
        const [o] = await tx.select().from(vpsOrders).where(eq(vpsOrders.id, id));
        const [job] = await tx.select().from(provisioningJobs).where(eq(provisioningJobs.id, o!.jobId!));
        const order = o!;
        const state = (job?.state ?? {}) as Record<string, unknown>;
        if (job?.status === 'completed') {
          const r = await deliverOrder(tx, audit, order, { guestId: job.guestId ?? (state.guestId as string | undefined) ?? null, vpsid: (state.vpsid as string | undefined) ?? null, now, actor: SYSTEM, meta: META });
          if (r && r.totalPaise !== order.totalPaise) deps.logger.warn({ orderId: id, charged: order.totalPaise, invoiced: r.totalPaise }, 'order total differs from its invoice');
        } else {
          // Refund only when it is certain nothing was created.
          const refundable = !state.createSent || state.refused === true;
          const reason = (job?.error ?? (job?.status === 'cancelled' ? 'Cancelled' : 'Creation failed')).slice(0, 400);
          if (refundable) await refundOrder(tx, audit, order, { reason, now, actor: SYSTEM, meta: META });
          else {
            await tx.update(vpsOrders).set({ status: 'review', error: reason, settledAt: now }).where(eq(vpsOrders.id, id));
            await audit.record(
              {
                orgId: order.orgId,
                actor: SYSTEM,
                customerId: order.customerId,
                action: 'billing.order_review',
                target: { type: 'vps_order', id },
                outcome: 'failure',
                meta: META,
                metadata: { hostname: order.hostname, reason, amount: order.totalPaise },
              },
              tx,
            );
          }
        }
        n++;
      });
    } catch (e) {
      deps.logger.error({ orderId: id, err: (e as { cause?: Error }).cause?.message ?? (e as Error).message }, 'settling a VPS order failed');
    }
  }
  return n;
}

/* ------------------------------------------------------------------ renewals */

async function suspendGuest(deps: ProvisioningDeps, guestId: string | null, suspend: boolean): Promise<void> {
  if (!guestId) return;
  const [g] = await deps.db.select().from(virtGuests).where(eq(virtGuests.id, guestId));
  if (!g) return;
  const [i] = await deps.db.select().from(virtIntegrations).where(eq(virtIntegrations.id, g.integrationId));
  if (!i || !i.enabled) throw new Error('The hypervisor integration is disabled or deleted');
  const client = virtClientFor(deps, i);
  if (!client.billingSuspend) throw new Error('This hypervisor does not offer suspension from NexoraDC');
  const [h] = g.hostId ? await deps.db.select().from(virtHosts).where(eq(virtHosts.id, g.hostId)) : [];
  await client.billingSuspend({ externalId: g.externalId, hostExternalId: h?.externalId ?? null, virtType: g.virtType }, suspend);
}

async function deleteGuest(deps: ProvisioningDeps, guestId: string | null): Promise<void> {
  if (!guestId) return;
  const [g] = await deps.db.select().from(virtGuests).where(eq(virtGuests.id, guestId));
  if (!g || g.missingSince) return;
  const [i] = await deps.db.select().from(virtIntegrations).where(eq(virtIntegrations.id, g.integrationId));
  if (!i || !i.enabled) throw new Error('The hypervisor integration is disabled or deleted');
  const client = virtClientFor(deps, i);
  if (!client.deleteVps) throw new Error('This hypervisor does not offer VPS deletion from NexoraDC');
  const [h] = g.hostId ? await deps.db.select().from(virtHosts).where(eq(virtHosts.id, g.hostId)) : [];
  await client.deleteVps({ externalId: g.externalId, hostExternalId: h?.externalId ?? null, virtType: g.virtType });
}

/** Subscriptions set to cancel at the end of their paid period whose day has come: ended, VPS suspended or deleted. */
async function endCancelled(deps: ProvisioningDeps, now: Date) {
  const audit = new AuditService(deps.db);
  const rows = await deps.db
    .select()
    .from(subscriptions)
    .where(sql`${subscriptions.status} <> 'cancelled' and ${subscriptions.cancelAt} is not null and ${subscriptions.cancelAt} <= ${now.toISOString()}::timestamptz`)
    .limit(100);
  for (const s of rows) {
    await deps.db.transaction(async (tx) => {
      await tx
        .update(subscriptions)
        .set({ status: 'cancelled', cancelledAt: now, pendingAction: s.guestId ? (s.deleteVps ? 'delete' : 'suspend') : null, pendingBy: 'billing (end of period)' })
        .where(and(eq(subscriptions.id, s.id), sql`${subscriptions.status} <> 'cancelled'`));
      if (s.serviceId)
        await tx
          .update(services)
          .set({ status: 'cancelled', endDate: now.toISOString().slice(0, 10) })
          .where(eq(services.id, s.serviceId));
      await audit.record(
        {
          orgId: s.orgId,
          actor: SYSTEM,
          customerId: s.customerId,
          action: 'billing.subscription_ended',
          target: { type: 'subscription', id: s.id },
          outcome: 'success',
          meta: META,
          metadata: { name: s.name, reason: s.cancelReason, deleteVps: s.deleteVps },
        },
        tx,
      );
    });
  }
}

/** Hypervisor actions asked for by staff or by a cancellation: suspend, unsuspend, delete. Retried every 10 minutes on failure. */
async function runPendingActions(deps: ProvisioningDeps, now: Date) {
  const audit = new AuditService(deps.db);
  const rows = await deps.db
    .select()
    .from(subscriptions)
    .where(sql`${subscriptions.pendingAction} is not null and (${subscriptions.lastError} is null or ${subscriptions.updatedAt} < ${new Date(now.getTime() - RETRY_MS).toISOString()}::timestamptz)`)
    .limit(50);
  for (const s of rows) {
    const action = s.pendingAction as 'suspend' | 'unsuspend' | 'delete';
    try {
      if (action === 'delete') await deleteGuest(deps, s.guestId);
      else await suspendGuest(deps, s.guestId, action === 'suspend');
      const cancelled = s.status === 'cancelled';
      await deps.db
        .update(subscriptions)
        .set({
          pendingAction: null,
          lastError: null,
          ...(action === 'suspend' ? { suspendedAt: now } : action === 'unsuspend' ? { suspendedAt: null } : {}),
          // A paid subscription suspended by hand stays active (it renews as usual); unsuspending one suspended for non-payment needs payment, not this.
        })
        .where(eq(subscriptions.id, s.id));
      if (s.serviceId && !cancelled && action !== 'delete')
        await deps.db
          .update(services)
          .set({ status: action === 'suspend' ? 'suspended' : 'active' })
          .where(eq(services.id, s.serviceId));
      await audit.record({
        orgId: s.orgId,
        actor: SYSTEM,
        customerId: s.customerId,
        action: `billing.vps_${action}`,
        target: { type: 'subscription', id: s.id },
        outcome: 'success',
        meta: META,
        metadata: { name: s.name, by: s.pendingBy, guestId: s.guestId },
      });
    } catch (e) {
      const msg = `Could not ${action} the VPS: ${(e as Error).message}`.slice(0, 500);
      await deps.db.update(subscriptions).set({ lastError: msg }).where(eq(subscriptions.id, s.id));
      deps.logger.warn({ subscriptionId: s.id, err: (e as Error).message }, `billing ${action} failed`);
    }
  }
}

async function setServiceStatus(deps: ProvisioningDeps, sub: Subscription, status: 'active' | 'suspended') {
  if (sub.serviceId) await deps.db.update(services).set({ status }).where(eq(services.id, sub.serviceId));
}

async function renewDue(deps: ProvisioningDeps, now: Date) {
  const audit = new AuditService(deps.db);
  const out = { renewed: 0, overdue: 0, suspended: 0, unsuspended: 0 };
  const due = await deps.db.execute<{ id: string }>(sql`
    select id from subscriptions where status in ('active', 'overdue', 'suspended') and next_due_at <= ${now.toISOString()}::timestamptz and (cancel_at is null or cancel_at > ${now.toISOString()}::timestamptz) order by next_due_at limit 200`);
  for (const { id } of due.rows) {
    let after: { action: 'suspend' | 'unsuspend'; sub: Subscription } | null = null;
    try {
      await deps.db.transaction(async (tx) => {
        const locked = await tx.execute(sql`select id from subscriptions where id = ${id} and status in ('active', 'overdue', 'suspended') and next_due_at <= ${now.toISOString()}::timestamptz for update skip locked`);
        if (!locked.rows.length) return;
        const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
        const s = sub!;
        const settings = await loadSettings(tx, s.orgId);
        if (!settings) {
          await tx.update(subscriptions).set({ lastError: 'Billing settings are missing; renewals are paused' }).where(eq(subscriptions.id, id));
          return;
        }
        const [c] = await tx.select().from(customers).where(eq(customers.id, s.customerId));
        const t = taxFor(settings, c!, s.pricePaise);
        if (c!.walletBalancePaise >= t.totalPaise) {
          // A suspended VPS starts a fresh month on the day it is paid; an overdue one continues from its due date.
          const from = s.status === 'suspended' ? now : s.nextDueAt;
          const to = addMonth(from);
          const inv = await issueInvoice(tx, {
            orgId: s.orgId,
            customerId: s.customerId,
            settings,
            at: now,
            rateBp: t.rateBp,
            placeOfSupply: t.placeOfSupply,
            subscriptionId: s.id,
            lines: [{ description: `${s.name} — renewal`, quantity: 1, unitPaise: s.pricePaise, periodFrom: from.toISOString(), periodTo: to.toISOString(), subscriptionId: s.id }],
          });
          await moveWallet(tx, {
            orgId: s.orgId,
            customerId: s.customerId,
            kind: 'debit',
            amountPaise: -inv.totalPaise,
            description: `Renewal ${s.name} (invoice ${inv.number})`,
            invoiceId: inv.id,
            subscriptionId: s.id,
            actorLabel: 'billing',
          });
          await tx.update(subscriptions).set({ status: 'active', periodStart: from, nextDueAt: to, overdueSince: null, lastError: null }).where(eq(subscriptions.id, id));
          await audit.record(
            {
              orgId: s.orgId,
              actor: SYSTEM,
              customerId: s.customerId,
              action: 'billing.renewed',
              target: { type: 'subscription', id },
              outcome: 'success',
              meta: META,
              metadata: { invoice: inv.number, total: inv.totalPaise, wasSuspended: s.status === 'suspended' },
            },
            tx,
          );
          out.renewed++;
          if (s.status === 'suspended') after = { action: 'unsuspend', sub: s };
          return;
        }
        if (s.status === 'active') {
          await tx.update(subscriptions).set({ status: 'overdue', overdueSince: s.nextDueAt }).where(eq(subscriptions.id, id));
          await audit.record(
            {
              orgId: s.orgId,
              actor: SYSTEM,
              customerId: s.customerId,
              action: 'billing.overdue',
              target: { type: 'subscription', id },
              outcome: 'failure',
              meta: META,
              metadata: { needed: t.totalPaise, balance: c!.walletBalancePaise, note: `Needs ${formatInr(t.totalPaise)}; suspends after ${settings.graceDays} day(s)` },
            },
            tx,
          );
          out.overdue++;
          return;
        }
        if (s.status === 'overdue') {
          const since = (s.overdueSince ?? s.nextDueAt).getTime();
          const graceOver = now.getTime() >= since + settings.graceDays * 86_400_000;
          const retryOk = !s.lastError || now.getTime() - s.updatedAt.getTime() >= RETRY_MS;
          if (graceOver && retryOk) after = { action: 'suspend', sub: s };
        }
      });
    } catch (e) {
      if (!(e instanceof InsufficientFunds)) deps.logger.error({ subscriptionId: id, err: (e as Error).message }, 'renewing a subscription failed');
      continue;
    }
    // The hypervisor call happens after the money transaction committed (never inside it).
    const a = after as { action: 'suspend' | 'unsuspend'; sub: Subscription } | null;
    if (!a) continue;
    try {
      await suspendGuest(deps, a.sub.guestId, a.action === 'suspend');
      if (a.action === 'suspend') {
        await deps.db
          .update(subscriptions)
          .set({ status: 'suspended', suspendedAt: now, lastError: null })
          .where(and(eq(subscriptions.id, id), eq(subscriptions.status, 'overdue')));
        await setServiceStatus(deps, a.sub, 'suspended');
        out.suspended++;
      } else {
        await deps.db.update(subscriptions).set({ suspendedAt: null, lastError: null }).where(eq(subscriptions.id, id));
        await setServiceStatus(deps, a.sub, 'active');
        out.unsuspended++;
      }
      await audit.record({
        orgId: a.sub.orgId,
        actor: SYSTEM,
        customerId: a.sub.customerId,
        action: a.action === 'suspend' ? 'billing.suspended' : 'billing.unsuspended',
        target: { type: 'subscription', id },
        outcome: 'success',
        meta: META,
        metadata: { guestId: a.sub.guestId },
      });
    } catch (e) {
      const msg = `${a.action === 'suspend' ? 'Overdue past the grace days, but the VPS could not be suspended' : 'Paid, but the VPS could not be unsuspended'}: ${(e as Error).message}`.slice(0, 500);
      await deps.db.update(subscriptions).set({ lastError: msg }).where(eq(subscriptions.id, id));
      deps.logger.warn({ subscriptionId: id, err: (e as Error).message }, `billing ${a.action} failed`);
    }
  }
  return out;
}

/** Paid subscriptions whose VPS is still suspended (an unsuspend that failed earlier). */
async function retryUnsuspend(deps: ProvisioningDeps, now: Date): Promise<number> {
  const rows = await deps.db
    .select()
    .from(subscriptions)
    .where(
      sql`${subscriptions.status} = 'active' and ${subscriptions.suspendedAt} is not null and ${subscriptions.pendingAction} is null and ${subscriptions.lastError} is not null and ${subscriptions.updatedAt} < ${new Date(now.getTime() - RETRY_MS).toISOString()}::timestamptz`,
    )
    .limit(50);
  let n = 0;
  for (const s of rows) {
    try {
      await suspendGuest(deps, s.guestId, false);
      await deps.db.update(subscriptions).set({ suspendedAt: null, lastError: null }).where(eq(subscriptions.id, s.id));
      await setServiceStatus(deps, s, 'active');
      n++;
    } catch (e) {
      await deps.db
        .update(subscriptions)
        .set({ lastError: `Paid, but the VPS could not be unsuspended: ${(e as Error).message}`.slice(0, 500) })
        .where(eq(subscriptions.id, s.id));
    }
  }
  return n;
}
