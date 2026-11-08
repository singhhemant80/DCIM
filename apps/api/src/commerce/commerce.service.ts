import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import {
  formatInr,
  GST_STATES,
  type addFundsSchema,
  type billingSettingsSchema,
  type clientPriceSchema,
  type customerBillingSchema,
  type subscriptionActionSchema,
  type subscriptionCancelSchema,
  type subscriptionUpdateSchema,
  type VirtPlan,
  type VirtTemplate,
  type vpsOrderSchema,
  type vpsPlanSchema,
  type walletAdjustSchema,
} from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import {
  billingSettings,
  creditNotes,
  customerPlanPrices,
  customers,
  invoices,
  provisioningEvents,
  provisioningJobs,
  services,
  subscriptions,
  virtGuests,
  virtIntegrations,
  vpsOrders,
  vpsPlans,
  walletTransactions,
  type Customer,
  type VpsPlan,
} from '../db/schema';
import { AuditService, actorFrom } from '../audit/audit.service';
import { SecretBox } from '../common/secret-box';
import { jobContext } from '../provisioning/contexts';
import type { Principal, RequestMeta } from '../auth/principal';
import { InsufficientFunds, issueCreditNote, loadSettings, moveWallet, nextReceipt, taxFor } from './ledger';
import { deliverOrder, refundOrder } from './delivery';
import { chargeRenewal, unpaidTerms } from './renewal';

type I<T extends z.ZodTypeAny> = z.infer<T>;
const NF = (what: string) => new NotFoundException({ error: 'not_found', message: `${what} not found` });
const forbidden = () => new ForbiddenException({ error: 'forbidden', message: 'You do not have permission to perform this action' });

/**
 * Native billing: VPS plans from Virtualizor sold at a monthly price (a
 * client may have their own price), prepaid wallets that staff top up, VPS
 * orders paid from the wallet, monthly renewals and GST tax invoices.
 *
 * Client users see and act on their own account only (their customer id
 * comes from the session, never from the request). Staff need billing.read
 * to see, billing.write to change money or prices.
 *
 * Money moves only through ./ledger (row-locked wallet, append-only ledger).
 * The VPS itself is created by the worker's guest_create job; the worker's
 * billing cycle settles the order (invoice, or refund) and renews.
 */
@Injectable()
export class CommerceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
  ) {}

  /* ---------------------------------------------------------------- access */

  private staffRead(p: Principal) {
    if (p.userType !== 'staff' || !p.permissions.has('billing.read')) throw forbidden();
  }
  private staffWrite(p: Principal) {
    if (p.userType !== 'staff' || !p.permissions.has('billing.write')) throw forbidden();
  }
  /** The customer whose account is read: their own for client users; any (or none = all) for staff with billing.read. */
  private scope(p: Principal, customerId?: string | null): string | null {
    if (p.userType === 'customer') {
      if (!p.permissions.has('services.read')) throw forbidden();
      return p.customerId!;
    }
    this.staffRead(p);
    return customerId ?? null;
  }
  private async customer(p: Principal, id: string): Promise<Customer> {
    const [c] = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.orgId, p.orgId)));
    if (!c || (p.userType === 'customer' && c.id !== p.customerId)) throw NF('Customer');
    return c;
  }
  private rec(p: Principal, meta: RequestMeta, action: string, target: { type: string; id: string | null }, metadata: Record<string, unknown>, customerId: string | null, tx?: Parameters<AuditService['record']>[1]) {
    return this.audit.record({ orgId: p.orgId, actor: actorFrom(p), customerId, action, target, outcome: 'success', meta, metadata }, tx);
  }

  /* ---------------------------------------------------------------- settings */

  async getSettings(p: Principal) {
    this.staffRead(p);
    const s = await loadSettings(this.db, p.orgId);
    return { settings: s, states: GST_STATES };
  }

  async putSettings(p: Principal, input: I<typeof billingSettingsSchema>, meta: RequestMeta) {
    this.staffWrite(p);
    const v = { ...input, gstin: input.gstin || null, pan: input.pan || null, email: input.email || null, phone: input.phone || null, bankDetails: input.bankDetails || null, invoiceNotes: input.invoiceNotes || null };
    if (v.gstin && v.gstin.slice(0, 2) !== v.stateCode) throw new BadRequestException({ error: 'invalid_state', message: `The GSTIN is registered in state ${v.gstin.slice(0, 2)}; choose that state` });
    if (v.terminateDays > 0 && v.terminateDays <= v.graceDays) throw new BadRequestException({ error: 'invalid_terms', message: 'Termination must come after suspension (more days than the grace days), or 0 for never' });
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(billingSettings)
        .values({ orgId: p.orgId, ...v })
        .onConflictDoUpdate({ target: billingSettings.orgId, set: v })
        .returning();
      await this.rec(p, meta, 'billing.settings_update', { type: 'billing_settings', id: p.orgId }, { legalName: v.legalName, gstin: v.gstin, stateCode: v.stateCode, gstRateBp: v.gstRateBp, graceDays: v.graceDays }, null, tx);
      return row;
    });
  }

  /* ---------------------------------------------------------------- plans */

  /** Plans read from Virtualizor by the last sync, per integration, with the ones already offered marked. */
  async hypervisorPlans(p: Principal) {
    this.staffRead(p);
    const ints = await this.db
      .select({
        id: virtIntegrations.id,
        name: virtIntegrations.name,
        enabled: virtIntegrations.enabled,
        actionsEnabled: virtIntegrations.actionsEnabled,
        plans: virtIntegrations.plans,
        templates: virtIntegrations.templates,
        lastSyncAt: virtIntegrations.lastSyncAt,
      })
      .from(virtIntegrations)
      .where(and(eq(virtIntegrations.orgId, p.orgId), eq(virtIntegrations.kind, 'virtualizor')));
    const offered = await this.db.select({ integrationId: vpsPlans.integrationId, ext: vpsPlans.externalPlanId, id: vpsPlans.id }).from(vpsPlans).where(eq(vpsPlans.orgId, p.orgId));
    // The servers (nodes) of each panel, to choose where a plan's VPSs are created.
    const hosts = await this.db.execute<{ integration_id: string; external_id: string; name: string; status: string | null; cpus: number | null; mem_used: number | null; mem_total: number | null; missing: boolean; vms: number }>(sql`
      select h.integration_id, h.external_id, h.name, h.status, h.cpus, h.mem_used, h.mem_total, h.missing_since is not null as missing,
             (select count(*) from virt_guests g where g.host_id = h.id and g.missing_since is null)::int as vms
        from virt_hosts h where h.org_id = ${p.orgId} order by h.name`);
    return ints.map((i) => ({
      id: i.id,
      name: i.name,
      enabled: i.enabled,
      actionsEnabled: i.actionsEnabled,
      lastSyncAt: i.lastSyncAt,
      synced: i.plans !== null,
      servers: hosts.rows
        .filter((h) => h.integration_id === i.id)
        .map((h) => ({
          id: h.external_id,
          name: h.name,
          status: h.status,
          cpus: h.cpus,
          memUsedBytes: h.mem_used === null ? null : Number(h.mem_used),
          memTotalBytes: h.mem_total === null ? null : Number(h.mem_total),
          vms: h.vms,
          missing: h.missing,
        })),
      templates: (i.templates ?? []).map((t) => ({ osid: String(t.osid), name: t.name, type: t.type })),
      plans: (i.plans ?? []).map((x) => ({ ...x, offeredAs: offered.find((o) => o.integrationId === i.id && o.ext === x.id)?.id ?? null })),
    }));
  }

  private static liveSpecs(plan: VpsPlan, live: VirtPlan[] | null): Record<string, unknown> {
    const l = live?.find((x) => x.id === plan.externalPlanId);
    return l ? { ...l } : plan.specs;
  }

  /** Staff: every plan with its default price. Client users: the plans on sale to them, at their price. */
  async plans(p: Principal) {
    const cid = this.scope(p);
    const rows = await this.db
      .select({ plan: vpsPlans, live: virtIntegrations.plans, integration: virtIntegrations.name, intEnabled: virtIntegrations.enabled, actionsEnabled: virtIntegrations.actionsEnabled })
      .from(vpsPlans)
      .innerJoin(virtIntegrations, eq(virtIntegrations.id, vpsPlans.integrationId))
      .where(and(eq(vpsPlans.orgId, p.orgId), ...(p.userType === 'customer' ? [eq(vpsPlans.active, true), eq(vpsPlans.visibleToCustomers, true)] : [])))
      .orderBy(vpsPlans.pricePaise);
    const own = cid && p.userType === 'customer' ? await this.db.select().from(customerPlanPrices).where(eq(customerPlanPrices.customerId, cid)) : [];
    const settings = await loadSettings(this.db, p.orgId);
    const c = p.userType === 'customer' ? await this.customer(p, p.customerId!) : null;
    return rows.map((r) => {
      const price = own.find((x) => x.planId === r.plan.id)?.pricePaise ?? r.plan.pricePaise;
      const t = settings && c ? taxFor(settings, c, price) : null;
      const base = {
        id: r.plan.id,
        name: r.plan.name,
        description: r.plan.description,
        specs: CommerceService.liveSpecs(r.plan, r.live),
        pricePaise: price,
        gstPaise: t ? t.totalPaise - price : null,
        totalPaise: t?.totalPaise ?? null,
        orderable: r.intEnabled && r.actionsEnabled && r.plan.active,
      };
      if (p.userType === 'customer') return base;
      return {
        ...base,
        integrationId: r.plan.integrationId,
        integration: r.integration,
        externalPlanId: r.plan.externalPlanId,
        serverId: r.plan.serverId,
        osIds: r.plan.osIds,
        active: r.plan.active,
        visibleToCustomers: r.plan.visibleToCustomers,
        defaultPricePaise: r.plan.pricePaise,
      };
    });
  }

  private async planIntegration(p: Principal, integrationId: string) {
    const [i] = await this.db
      .select()
      .from(virtIntegrations)
      .where(and(eq(virtIntegrations.id, integrationId), eq(virtIntegrations.orgId, p.orgId)));
    if (!i) throw NF('Hypervisor integration');
    if (i.kind !== 'virtualizor') throw new BadRequestException({ error: 'unsupported', message: 'VPS plans are sold from Virtualizor integrations' });
    return i;
  }

  async createPlan(p: Principal, input: I<typeof vpsPlanSchema>, meta: RequestMeta) {
    this.staffWrite(p);
    const i = await this.planIntegration(p, input.integrationId);
    const live = (i.plans ?? []).find((x) => x.id === input.externalPlanId);
    if (i.plans && !live) throw new BadRequestException({ error: 'unknown_plan', message: 'Virtualizor did not list that plan in the last sync' });
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(vpsPlans)
          .values({ orgId: p.orgId, ...input, description: input.description || null, serverId: input.serverId || null, specs: live ? { ...live } : {} })
          .returning();
        await this.rec(p, meta, 'billing.plan_create', { type: 'vps_plan', id: row!.id }, { name: row!.name, price: row!.pricePaise, plan: input.externalPlanId }, null, tx);
        return row;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') throw new ConflictException({ error: 'duplicate', message: 'That Virtualizor plan is already on sale' });
      throw e;
    }
  }

  async updatePlan(p: Principal, id: string, input: I<typeof vpsPlanSchema>, meta: RequestMeta) {
    this.staffWrite(p);
    const [cur] = await this.db
      .select()
      .from(vpsPlans)
      .where(and(eq(vpsPlans.id, id), eq(vpsPlans.orgId, p.orgId)));
    if (!cur) throw NF('Plan');
    if (input.integrationId !== cur.integrationId || input.externalPlanId !== cur.externalPlanId) throw new BadRequestException({ error: 'immutable', message: 'The Virtualizor plan of an offer cannot change; add a new offer instead' });
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(vpsPlans)
        .set({ name: input.name, description: input.description || null, pricePaise: input.pricePaise, serverId: input.serverId || null, active: input.active, visibleToCustomers: input.visibleToCustomers, osIds: input.osIds })
        .where(eq(vpsPlans.id, id))
        .returning();
      await this.rec(p, meta, 'billing.plan_update', { type: 'vps_plan', id }, { name: row!.name, price: row!.pricePaise, priceBefore: cur.pricePaise, active: row!.active }, null, tx);
      return row;
    });
  }

  /** OS templates a plan may be ordered with: the plan's list, or the hypervisor's templates of the plan's virtualization type. */
  async planTemplates(p: Principal, id: string) {
    this.scope(p);
    const [r] = await this.db
      .select({ plan: vpsPlans, templates: virtIntegrations.templates, live: virtIntegrations.plans })
      .from(vpsPlans)
      .innerJoin(virtIntegrations, eq(virtIntegrations.id, vpsPlans.integrationId))
      .where(and(eq(vpsPlans.id, id), eq(vpsPlans.orgId, p.orgId)));
    if (!r || (p.userType === 'customer' && (!r.plan.active || !r.plan.visibleToCustomers))) throw NF('Plan');
    return CommerceService.templatesFor(r.plan, r.templates ?? [], r.live);
  }

  private static templatesFor(plan: VpsPlan, all: VirtTemplate[], live: VirtPlan[] | null) {
    const virt = String(CommerceService.liveSpecs(plan, live).virt ?? '').toLowerCase();
    let list = all.map((t) => ({ osid: String(t.osid), name: t.name, distro: t.distro, type: t.type }));
    if (plan.osIds.length) list = list.filter((t) => plan.osIds.includes(t.osid));
    else if (virt) {
      const same = list.filter((t) => (t.type ?? '').toLowerCase() === virt);
      if (same.length) list = same;
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  /* ---------------------------------------------------------------- client prices */

  async clientPrices(p: Principal, customerId: string) {
    this.staffRead(p);
    await this.customer(p, customerId);
    const plans = await this.db.select().from(vpsPlans).where(eq(vpsPlans.orgId, p.orgId)).orderBy(vpsPlans.pricePaise);
    const own = await this.db.select().from(customerPlanPrices).where(eq(customerPlanPrices.customerId, customerId));
    return plans.map((x) => ({ planId: x.id, name: x.name, active: x.active, defaultPricePaise: x.pricePaise, clientPricePaise: own.find((o) => o.planId === x.id)?.pricePaise ?? null }));
  }

  async setClientPrice(p: Principal, customerId: string, input: I<typeof clientPriceSchema>, meta: RequestMeta) {
    this.staffWrite(p);
    const c = await this.customer(p, customerId);
    const [plan] = await this.db
      .select()
      .from(vpsPlans)
      .where(and(eq(vpsPlans.id, input.planId), eq(vpsPlans.orgId, p.orgId)));
    if (!plan) throw NF('Plan');
    await this.db.transaction(async (tx) => {
      if (input.pricePaise === null) await tx.delete(customerPlanPrices).where(and(eq(customerPlanPrices.customerId, c.id), eq(customerPlanPrices.planId, plan.id)));
      else
        await tx
          .insert(customerPlanPrices)
          .values({ customerId: c.id, planId: plan.id, orgId: p.orgId, pricePaise: input.pricePaise })
          .onConflictDoUpdate({ target: [customerPlanPrices.customerId, customerPlanPrices.planId], set: { pricePaise: input.pricePaise } });
      await this.rec(p, meta, 'billing.client_price', { type: 'customer', id: c.id }, { plan: plan.name, price: input.pricePaise, defaultPrice: plan.pricePaise }, c.id, tx);
    });
    return this.clientPrices(p, customerId);
  }

  /* ---------------------------------------------------------------- accounts */

  /** Balances of every client, with what their active VPSs cost per month. */
  async wallets(p: Principal) {
    this.staffRead(p);
    const r = await this.db.execute<{
      id: string;
      code: string;
      name: string;
      status: string;
      balance: number;
      gstin: string | null;
      state_code: string | null;
      subs: number;
      monthly: number;
      overdue: number;
      suspended: number;
      last_tx: string | null;
    }>(sql`
      select c.id, c.code, c.name, c.status::text as status, c.wallet_balance_paise::bigint as balance, c.gstin, c.state_code,
             count(s.id) filter (where s.status <> 'cancelled')::int as subs,
             coalesce(sum(s.price_paise) filter (where s.status <> 'cancelled'), 0)::bigint as monthly,
             count(s.id) filter (where s.status = 'overdue')::int as overdue,
             count(s.id) filter (where s.status = 'suspended')::int as suspended,
             (select max(created_at) from wallet_transactions w where w.customer_id = c.id) as last_tx
        from customers c left join subscriptions s on s.customer_id = c.id
       where c.org_id = ${p.orgId}
       group by c.id order by c.name`);
    return r.rows.map((x) => ({
      id: x.id,
      code: x.code,
      name: x.name,
      status: x.status,
      balancePaise: Number(x.balance),
      gstin: x.gstin,
      stateCode: x.state_code,
      subscriptions: x.subs,
      monthlyPaise: Number(x.monthly),
      overdue: x.overdue,
      suspended: x.suspended,
      lastTransactionAt: x.last_tx,
    }));
  }

  /** One client's account: billing profile, balance, VPS subscriptions, ledger, invoices and orders. */
  async account(p: Principal, customerId?: string) {
    const cid = this.scope(p, customerId);
    if (!cid) throw new BadRequestException({ error: 'customer_required', message: 'Choose a customer' });
    const c = await this.customer(p, cid);
    const [subs, txs, invs, orders, settings] = await Promise.all([
      this.subscriptionRows(p, cid),
      this.db.select().from(walletTransactions).where(eq(walletTransactions.customerId, cid)).orderBy(desc(walletTransactions.id)).limit(100),
      this.db
        .select({ id: invoices.id, number: invoices.number, issuedAt: invoices.issuedAt, totalPaise: invoices.totalPaise, taxablePaise: invoices.taxablePaise, status: invoices.status, lines: invoices.lines })
        .from(invoices)
        .where(eq(invoices.customerId, cid))
        .orderBy(desc(invoices.issuedAt))
        .limit(100),
      this.orderRows(p, cid, 30),
      loadSettings(this.db, p.orgId),
    ]);
    const staff = p.userType === 'staff';
    return {
      customer: { id: c.id, code: c.code, name: c.name, status: c.status, legalName: c.legalName, gstin: c.gstin, billingAddress: c.billingAddress, stateCode: c.stateCode, billingEmail: c.billingEmail, contactEmail: c.contactEmail },
      balancePaise: c.walletBalancePaise,
      monthlyPaise: subs.filter((s) => s.status !== 'cancelled').reduce((a, s) => a + s.pricePaise, 0),
      graceDays: settings?.graceDays ?? null,
      terminateDays: settings?.terminateDays ?? null,
      billingReady: !!settings,
      subscriptions: subs,
      transactions: txs.map((t) => ({
        id: t.id,
        at: t.at,
        kind: t.kind,
        amountPaise: t.amountPaise,
        balanceAfterPaise: t.balanceAfterPaise,
        method: t.method,
        reference: t.reference,
        description: t.description,
        receiptNumber: t.receiptNumber,
        invoiceId: t.invoiceId,
        ...(staff ? { actor: t.actorLabel } : {}),
      })),
      invoices: invs.map((i) => ({ id: i.id, number: i.number, issuedAt: i.issuedAt, totalPaise: i.totalPaise, taxablePaise: i.taxablePaise, status: i.status, description: i.lines[0]?.description ?? '' })),
      orders,
      creditNotes: await this.creditNoteRows(p, cid),
    };
  }

  async updateProfile(p: Principal, customerId: string, input: I<typeof customerBillingSchema>, meta: RequestMeta) {
    if (p.userType === 'staff') this.staffWrite(p);
    else if (!p.permissions.has('orders.place')) throw forbidden();
    const c = await this.customer(p, customerId);
    const v = { legalName: input.legalName || null, gstin: input.gstin || null, billingAddress: input.address || null, stateCode: input.stateCode || null, billingEmail: input.billingEmail || null };
    if (v.gstin && v.stateCode && v.gstin.slice(0, 2) !== v.stateCode)
      throw new BadRequestException({ error: 'invalid_state', message: `The GSTIN is registered in state ${v.gstin.slice(0, 2)} (${GST_STATES[v.gstin.slice(0, 2)] ?? '?'}); choose that state` });
    if (v.gstin && !v.stateCode) v.stateCode = v.gstin.slice(0, 2);
    await this.db.transaction(async (tx) => {
      await tx.update(customers).set(v).where(eq(customers.id, c.id));
      await this.rec(p, meta, 'billing.profile_update', { type: 'customer', id: c.id }, { gstin: v.gstin, stateCode: v.stateCode, legalName: v.legalName }, c.id, tx);
    });
    return this.account(p, c.id);
  }

  /* ---------------------------------------------------------------- wallet */

  async addFunds(p: Principal, customerId: string, input: I<typeof addFundsSchema>, idem: string | undefined, meta: RequestMeta) {
    this.staffWrite(p);
    const c = await this.customer(p, customerId);
    const key = CommerceService.idemKey(idem);
    if (key) {
      const [prev] = await this.db
        .select()
        .from(walletTransactions)
        .where(and(eq(walletTransactions.customerId, c.id), eq(walletTransactions.idempotencyKey, key)));
      if (prev) {
        if (prev.amountPaise !== input.amountPaise || prev.method !== input.method) throw new ConflictException({ error: 'idempotency_conflict', message: 'This Idempotency-Key was already used for a different payment' });
        return { transactionId: prev.id, receiptNumber: prev.receiptNumber, balancePaise: prev.balanceAfterPaise, replayed: true };
      }
    }
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const settings = await loadSettings(tx, p.orgId);
      const receipt = await nextReceipt(tx, p.orgId, settings, now);
      const m = await moveWallet(tx, {
        orgId: p.orgId,
        customerId: c.id,
        kind: 'credit',
        amountPaise: input.amountPaise,
        description: input.note?.trim() || 'Payment received',
        method: input.method,
        reference: input.reference || null,
        receiptNumber: receipt,
        actorLabel: p.email,
        idempotencyKey: key,
      });
      await this.rec(p, meta, 'billing.funds_added', { type: 'customer', id: c.id }, { amount: input.amountPaise, method: input.method, reference: input.reference ?? null, receipt, balance: m.balanceAfterPaise }, c.id, tx);
      return { transactionId: m.id, receiptNumber: receipt, balancePaise: m.balanceAfterPaise, replayed: false };
    });
  }

  async adjust(p: Principal, customerId: string, input: I<typeof walletAdjustSchema>, meta: RequestMeta) {
    this.staffWrite(p);
    const c = await this.customer(p, customerId);
    return this.db.transaction(async (tx) => {
      const m = await moveWallet(tx, { orgId: p.orgId, customerId: c.id, kind: 'adjustment', amountPaise: input.amountPaise, description: `Correction: ${input.reason}`, actorLabel: p.email, allowNegative: true });
      await this.rec(p, meta, 'billing.wallet_adjust', { type: 'customer', id: c.id }, { amount: input.amountPaise, reason: input.reason, balance: m.balanceAfterPaise }, c.id, tx);
      return { transactionId: m.id, balancePaise: m.balanceAfterPaise };
    });
  }

  /** A payment receipt (receipt voucher) for funds added. */
  async receipt(p: Principal, txId: number) {
    const [t] = await this.db
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.id, txId), eq(walletTransactions.orgId, p.orgId)));
    const cid = this.scope(p, t?.customerId);
    if (!t || t.kind !== 'credit' || !t.receiptNumber || (cid && t.customerId !== cid)) throw NF('Receipt');
    const [c] = await this.db.select().from(customers).where(eq(customers.id, t.customerId));
    const settings = await loadSettings(this.db, p.orgId);
    return {
      number: t.receiptNumber,
      at: t.at,
      amountPaise: t.amountPaise,
      method: t.method,
      reference: t.reference,
      note: t.description,
      balanceAfterPaise: t.balanceAfterPaise,
      supplier: settings ? { legalName: settings.legalName, address: settings.address, gstin: settings.gstin, stateCode: settings.stateCode, email: settings.email, phone: settings.phone } : null,
      customer: { name: c!.legalName || c!.name, code: c!.code, address: c!.billingAddress, gstin: c!.gstin },
    };
  }

  /* ---------------------------------------------------------------- invoices */

  async invoices(p: Principal, customerId?: string) {
    const cid = this.scope(p, customerId);
    const rows = await this.db
      .select({ i: invoices, customer: customers.name, code: customers.code })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(and(eq(invoices.orgId, p.orgId), ...(cid ? [eq(invoices.customerId, cid)] : [])))
      .orderBy(desc(invoices.issuedAt))
      .limit(500);
    return rows.map((r) => ({
      id: r.i.id,
      number: r.i.number,
      issuedAt: r.i.issuedAt,
      customerId: r.i.customerId,
      customer: r.customer,
      code: r.code,
      taxablePaise: r.i.taxablePaise,
      cgstPaise: r.i.cgstPaise,
      sgstPaise: r.i.sgstPaise,
      igstPaise: r.i.igstPaise,
      totalPaise: r.i.totalPaise,
      status: r.i.status,
      placeOfSupply: r.i.placeOfSupply,
      description: r.i.lines[0]?.description ?? '',
    }));
  }

  async invoice(p: Principal, id: string) {
    const [i] = await this.db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.orgId, p.orgId)));
    const cid = this.scope(p, i?.customerId);
    if (!i || (cid && i.customerId !== cid)) throw NF('Invoice');
    return { ...i, placeOfSupplyName: GST_STATES[i.placeOfSupply] ?? i.placeOfSupply };
  }

  /* ---------------------------------------------------------------- orders */

  private static idemKey(k: string | undefined): string | null {
    const key = k?.trim() || null;
    if (key && (key.length > 200 || !/^[\x21-\x7e]+$/.test(key))) throw new BadRequestException({ error: 'invalid_idempotency_key', message: 'Idempotency-Key must be up to 200 printable characters' });
    return key;
  }

  private async orderRows(p: Principal, customerId: string | null, limit = 200) {
    const rows = await this.db
      .select({
        o: vpsOrders,
        plan: vpsPlans.name,
        customer: customers.name,
        jobStatus: provisioningJobs.status,
        jobError: provisioningJobs.error,
        guestName: virtGuests.name,
        nextDueAt: subscriptions.nextDueAt,
        subStatus: subscriptions.status,
        cancelAt: subscriptions.cancelAt,
      })
      .from(vpsOrders)
      .innerJoin(customers, eq(customers.id, vpsOrders.customerId))
      .leftJoin(vpsPlans, eq(vpsPlans.id, vpsOrders.planId))
      .leftJoin(provisioningJobs, eq(provisioningJobs.id, vpsOrders.jobId))
      .leftJoin(virtGuests, eq(virtGuests.id, vpsOrders.guestId))
      .leftJoin(subscriptions, eq(subscriptions.id, vpsOrders.subscriptionId))
      .where(and(eq(vpsOrders.orgId, p.orgId), ...(customerId ? [eq(vpsOrders.customerId, customerId)] : [])))
      .orderBy(desc(vpsOrders.createdAt))
      .limit(limit);
    const staff = p.userType === 'staff';
    return rows.map((r) => ({
      id: r.o.id,
      createdAt: r.o.createdAt,
      customerId: r.o.customerId,
      customer: r.customer,
      plan: r.plan,
      hostname: r.o.hostname,
      osName: r.o.osName,
      pricePaise: r.o.pricePaise,
      taxPaise: r.o.taxPaise,
      totalPaise: r.o.totalPaise,
      status: r.o.status,
      jobStatus: r.jobStatus,
      error: r.o.error ?? (r.jobStatus === 'recovery' ? 'Interrupted while creating; staff will check the panel' : null),
      guestId: r.o.guestId,
      guestName: r.guestName,
      invoiceId: r.o.invoiceId,
      subscriptionId: r.o.subscriptionId,
      nextDueAt: r.nextDueAt,
      subscriptionStatus: r.subStatus,
      cancelAt: r.cancelAt,
      byCustomer: r.o.byCustomer,
      ...(staff ? { jobId: r.o.jobId, placedBy: r.o.placedBy, jobError: r.jobError } : {}),
    }));
  }

  async orders(p: Principal, customerId?: string) {
    return this.orderRows(p, this.scope(p, customerId));
  }

  /**
   * Places a VPS order: takes price + GST from the wallet and queues the
   * Virtualizor "Create VPS" job, in one transaction. Idempotent per client
   * and Idempotency-Key. The invoice is issued once the VPS exists; if it
   * is not created the amount goes back to the wallet.
   */
  async placeOrder(p: Principal, input: I<typeof vpsOrderSchema>, idem: string | undefined, meta: RequestMeta): Promise<{ order: Awaited<ReturnType<CommerceService['orderRows']>>[number] | undefined; replayed: boolean }> {
    let customerId: string;
    if (p.userType === 'customer') {
      if (!p.permissions.has('orders.place')) throw forbidden();
      customerId = p.customerId!;
    } else {
      this.staffWrite(p);
      if (!input.customerId) throw new BadRequestException({ error: 'customer_required', message: 'Choose the client to order for' });
      customerId = input.customerId;
    }
    const key = CommerceService.idemKey(idem);
    const hash = `${input.planId}|${input.hostname}|${input.osId}`;
    if (key) {
      const [prev] = await this.db
        .select()
        .from(vpsOrders)
        .where(and(eq(vpsOrders.orgId, p.orgId), eq(vpsOrders.customerId, customerId), eq(vpsOrders.idempotencyKey, key)));
      if (prev) {
        if (`${prev.planId}|${prev.hostname}|${prev.osId}` !== hash) throw new ConflictException({ error: 'idempotency_conflict', message: 'This Idempotency-Key was already used for a different order' });
        return { order: (await this.orderRows(p, customerId)).find((o) => o.id === prev.id), replayed: true };
      }
    }
    const c = await this.customer(p, customerId);
    if (c.status !== 'active') throw new ConflictException({ error: 'customer_inactive', message: 'The client account is not active' });
    const [r] = await this.db
      .select({ plan: vpsPlans, i: virtIntegrations })
      .from(vpsPlans)
      .innerJoin(virtIntegrations, eq(virtIntegrations.id, vpsPlans.integrationId))
      .where(and(eq(vpsPlans.id, input.planId), eq(vpsPlans.orgId, p.orgId)));
    if (!r || (p.userType === 'customer' && !r.plan.visibleToCustomers)) throw NF('Plan');
    if (!r.plan.active) throw new ConflictException({ error: 'plan_inactive', message: 'This plan is not on sale' });
    if (!r.i.enabled || !r.i.actionsEnabled) throw new ConflictException({ error: 'actions_disabled', message: 'VPS creation is not enabled for this hypervisor (turn on VM actions for the integration)' });
    // Where to create it: chosen by staff for this order, else the plan's server, else Virtualizor decides.
    if (input.serverId && p.userType !== 'staff') throw forbidden();
    const serverId = input.serverId || r.plan.serverId || null;
    if (input.serverId) {
      const h = await this.db.execute(sql`select 1 from virt_hosts where integration_id = ${r.i.id} and external_id = ${input.serverId} and missing_since is null`);
      if (!h.rows.length) throw new BadRequestException({ error: 'unknown_server', message: 'That server is not in the last Virtualizor sync' });
    }
    const os = CommerceService.templatesFor(r.plan, r.i.templates ?? [], r.i.plans).find((t) => t.osid === input.osId);
    if (!os) throw new BadRequestException({ error: 'invalid_template', message: 'That OS is not offered with this plan' });
    const settings = await loadSettings(this.db, p.orgId);
    if (!settings) throw new ConflictException({ error: 'billing_not_set_up', message: 'Billing is not set up yet (legal name, address, state and GSTIN in Billing → Settings)' });
    const userEmail = c.billingEmail || c.contactEmail;
    if (!userEmail) throw new BadRequestException({ error: 'email_required', message: 'The client needs a contact or billing e-mail (it becomes the VPS owner in Virtualizor)' });
    const [own] = await this.db
      .select()
      .from(customerPlanPrices)
      .where(and(eq(customerPlanPrices.customerId, c.id), eq(customerPlanPrices.planId, r.plan.id)));
    const price = own?.pricePaise ?? r.plan.pricePaise;
    const t = taxFor(settings, c, price);
    const specs = CommerceService.liveSpecs(r.plan, r.i.plans) as Partial<VirtPlan>;
    const orderId = randomUUID();
    const jobId = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(vpsOrders)
          .values({
            id: orderId,
            orgId: p.orgId,
            customerId: c.id,
            planId: r.plan.id,
            hostname: input.hostname,
            osId: input.osId,
            osName: os.name,
            pricePaise: price,
            taxPaise: t.totalPaise - price,
            totalPaise: t.totalPaise,
            gstRateBp: t.rateBp,
            placeOfSupply: t.placeOfSupply,
            status: 'provisioning',
            placedBy: p.email,
            byCustomer: p.userType === 'customer',
            idempotencyKey: key,
          });
        await moveWallet(tx, { orgId: p.orgId, customerId: c.id, kind: 'debit', amountPaise: -t.totalPaise, description: `VPS order ${input.hostname} (${r.plan.name}, first month incl. GST)`, orderId, actorLabel: p.email });
        await tx.insert(provisioningJobs).values({
          id: jobId,
          orgId: p.orgId,
          kind: 'guest_create',
          params: {
            orderId,
            customerId: c.id,
            customer: c.name,
            integrationId: r.i.id,
            integration: r.i.name,
            planId: r.plan.externalPlanId,
            planName: r.plan.name,
            plan: { virt: specs.virt ?? null, ramMb: specs.ramMb ?? null, diskGb: specs.diskGb ?? null, cores: specs.cores ?? null, bandwidthGb: specs.bandwidthGb ?? null, ips: specs.ips ?? null, ips6: specs.ips6 ?? null },
            serverId,
            osid: input.osId,
            osName: os.name,
            hostname: input.hostname,
            userEmail,
          },
          // The root password and a random password for the panel user (if Virtualizor has to create one); deleted once sent.
          secretEnc: this.secrets.encrypt(JSON.stringify({ password: input.password, userPass: `${randomBytes(12).toString('base64url')}Aa1` }), jobContext(p.orgId, jobId)),
          createdBy: p.email,
          createdByUserId: p.userId,
          customerRequest: p.userType !== 'staff',
          deadlineAt: new Date(Date.now() + 60 * 60_000),
        });
        await tx.insert(provisioningEvents).values({ jobId, message: `VPS order by ${p.email}: ${input.hostname}, ${r.plan.name}, ${os.name}; ${formatInr(t.totalPaise)} taken from the wallet` });
        await tx.update(vpsOrders).set({ jobId }).where(eq(vpsOrders.id, orderId));
        await this.rec(p, meta, 'billing.order_placed', { type: 'vps_order', id: orderId }, { hostname: input.hostname, plan: r.plan.name, os: os.name, total: t.totalPaise, jobId }, c.id, tx);
      });
    } catch (e) {
      if (e instanceof InsufficientFunds)
        throw new HttpException(
          { error: 'insufficient_funds', message: `The wallet has ${formatInr(e.balancePaise)}; this order needs ${formatInr(e.neededPaise)} (incl. GST). Add funds first.`, balancePaise: e.balancePaise, neededPaise: e.neededPaise },
          HttpStatus.PAYMENT_REQUIRED,
        );
      const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
      if (code === '23505' && key) return this.placeOrder(p, input, idem, meta);
      throw e;
    }
    return { order: (await this.orderRows(p, c.id)).find((o) => o.id === orderId), replayed: false };
  }

  /** Staff decision on an order in review (the request went out but the outcome was unclear). */
  async resolveOrder(p: Principal, id: string, input: { action: 'refund' | 'delivered'; guestId?: string; reason?: string }, meta: RequestMeta) {
    this.staffWrite(p);
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select id from vps_orders where id = ${id} and org_id = ${p.orgId} for update`);
      if (!locked.rows.length) throw NF('Order');
      const [o] = await tx.select().from(vpsOrders).where(eq(vpsOrders.id, id));
      if (o!.status !== 'review') throw new ConflictException({ error: 'not_in_review', message: `The order is ${o!.status}; only orders in review can be resolved by hand` });
      const w = { now: new Date(), actor: actorFrom(p), meta };
      if (input.action === 'refund') {
        await refundOrder(tx, this.audit, o!, { ...w, reason: input.reason?.trim() || o!.error || 'Not created (checked by staff)' });
      } else {
        if (!input.guestId) throw new BadRequestException({ error: 'guest_required', message: 'Choose the VPS that was created' });
        const [g] = await tx
          .select()
          .from(virtGuests)
          .where(and(eq(virtGuests.id, input.guestId), eq(virtGuests.orgId, p.orgId)));
        if (!g) throw NF('VPS');
        if (g.customerId && g.customerId !== o!.customerId) throw new ConflictException({ error: 'other_customer', message: 'That VPS belongs to another client' });
        await tx.update(virtGuests).set({ customerId: o!.customerId }).where(eq(virtGuests.id, g.id));
        await tx.execute(sql`update ip_addresses set customer_id = ${o!.customerId}, updated_at = now() where guest_id = ${g.id} and customer_id is null and status <> 'released'`);
        const inv = await deliverOrder(tx, this.audit, o!, { ...w, guestId: g.id, vpsid: g.externalId });
        if (!inv) throw new ConflictException({ error: 'billing_not_set_up', message: 'Set up billing first' });
      }
      return { ok: true };
    });
  }

  /* ---------------------------------------------------------------- subscriptions */

  private async subscriptionRows(p: Principal, customerId: string | null) {
    const rows = await this.db
      .select({ s: subscriptions, customer: customers.name, guestName: virtGuests.name, guestStatus: virtGuests.status, guestMissing: virtGuests.missingSince, guestIps: virtGuests.ipAddresses })
      .from(subscriptions)
      .innerJoin(customers, eq(customers.id, subscriptions.customerId))
      .leftJoin(virtGuests, eq(virtGuests.id, subscriptions.guestId))
      .where(and(eq(subscriptions.orgId, p.orgId), ...(customerId ? [eq(subscriptions.customerId, customerId)] : [])))
      .orderBy(subscriptions.nextDueAt);
    const settings = await loadSettings(this.db, p.orgId);
    const staff = p.userType === 'staff';
    return rows.map((r) => ({
      id: r.s.id,
      customerId: r.s.customerId,
      customer: r.customer,
      name: r.s.name,
      pricePaise: r.s.pricePaise,
      status: r.s.status,
      periodStart: r.s.periodStart,
      nextDueAt: r.s.nextDueAt,
      overdueSince: r.s.overdueSince,
      suspendedAt: r.s.suspendedAt,
      cancelledAt: r.s.cancelledAt,
      cancelAt: r.s.cancelAt,
      deleteVps: r.s.deleteVps,
      autoRenew: r.s.autoRenew,
      terminatesAt: unpaidTerms(r.s, settings).terminatesAt,
      pendingAction: r.s.pendingAction,
      suspendsAt: unpaidTerms(r.s, settings).suspendsAt,
      guestId: r.s.guestId,
      guestName: r.guestName,
      guestStatus: r.guestStatus,
      guestMissing: !!r.guestMissing,
      ipAddresses: (r.guestIps as string[] | null) ?? [],
      ...(staff ? { lastError: r.s.lastError, serviceId: r.s.serviceId, planId: r.s.planId } : {}),
    }));
  }

  async subscriptions(p: Principal, customerId?: string, status?: string) {
    const rows = await this.subscriptionRows(p, this.scope(p, customerId));
    return status ? rows.filter((r) => r.status === status) : rows;
  }

  async updateSubscription(p: Principal, id: string, input: I<typeof subscriptionUpdateSchema>, meta: RequestMeta) {
    this.staffWrite(p);
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select id from subscriptions where id = ${id} and org_id = ${p.orgId} for update`);
      if (!locked.rows.length) throw NF('Subscription');
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
      if (s!.status === 'cancelled') throw new ConflictException({ error: 'cancelled', message: 'This subscription is cancelled' });
      const set: Partial<typeof subscriptions.$inferInsert> = {};
      if (input.pricePaise !== undefined) set.pricePaise = input.pricePaise;
      if (input.nextDueAt) set.nextDueAt = new Date(input.nextDueAt);
      if (input.cancel) {
        set.status = 'cancelled';
        set.cancelledAt = new Date();
        if (s!.serviceId)
          await tx
            .update(services)
            .set({ status: 'cancelled', endDate: new Date().toISOString().slice(0, 10) })
            .where(eq(services.id, s!.serviceId));
      }
      const [row] = await tx.update(subscriptions).set(set).where(eq(subscriptions.id, id)).returning();
      await this.rec(
        p,
        meta,
        input.cancel ? 'billing.subscription_cancel' : 'billing.subscription_update',
        { type: 'subscription', id },
        { name: s!.name, price: input.pricePaise ?? null, priceBefore: s!.pricePaise, nextDueAt: input.nextDueAt ?? null, cancel: !!input.cancel },
        s!.customerId,
        tx,
      );
      return row;
    });
  }

  /**
   * Cancel a VPS subscription.
   * - At the end of the paid period (staff, or the client for their own): no renewal; on the due date
   *   the subscription ends and the VPS is suspended, or deleted when that was asked for.
   * - Now (staff): ends today; optionally a GST credit note for the unused days (or the whole last
   *   invoice) goes back to the wallet; the VPS is suspended or deleted by the worker within a minute.
   * Deleting needs the VPS hostname typed.
   */
  async cancelSubscription(p: Principal, id: string, input: I<typeof subscriptionCancelSchema>, meta: RequestMeta) {
    const staff = p.userType === 'staff';
    if (staff) this.staffWrite(p);
    else if (!p.permissions.has('orders.place')) throw forbidden();
    if (!staff && (input.when !== 'end_of_period' || input.refund !== 'none' || input.deleteVps)) throw forbidden();
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select id from subscriptions where id = ${id} and org_id = ${p.orgId} for update`);
      if (!locked.rows.length) throw NF('Subscription');
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
      const sub = s!;
      if (!staff && sub.customerId !== p.customerId) throw NF('Subscription');
      if (sub.status === 'cancelled') throw new ConflictException({ error: 'cancelled', message: 'This subscription is already cancelled' });
      if (input.deleteVps) {
        const [g] = sub.guestId ? await tx.select().from(virtGuests).where(eq(virtGuests.id, sub.guestId)) : [];
        const host = (g?.name ?? sub.name.split(' — ').pop() ?? '').toLowerCase();
        if (!g) throw new BadRequestException({ error: 'no_vps', message: 'No VPS is linked to this subscription, so there is nothing to delete' });
        if ((input.confirmHostname ?? '').toLowerCase() !== host) throw new BadRequestException({ error: 'confirm_hostname', message: `Type the VPS name (${g.name}) to confirm deleting it` });
      }
      const reason = input.reason?.trim() || (staff ? 'Cancelled by staff' : 'Cancelled by the client');
      let credit: { number: string; totalPaise: number } | null = null;
      if (input.when === 'end_of_period') {
        await tx.update(subscriptions).set({ cancelAt: sub.nextDueAt, cancelReason: reason, deleteVps: input.deleteVps }).where(eq(subscriptions.id, id));
      } else {
        if (input.refund !== 'none') {
          const settings = await loadSettings(tx, p.orgId);
          const [inv] = await tx.select().from(invoices).where(eq(invoices.subscriptionId, id)).orderBy(desc(invoices.issuedAt)).limit(1);
          if (settings && inv) {
            const span = sub.nextDueAt.getTime() - sub.periodStart.getTime();
            const unused = span > 0 ? Math.min(1, Math.max(0, (sub.nextDueAt.getTime() - now.getTime()) / span)) : 0;
            // Only the invoice of the current period is refunded; overdue/suspended periods were never paid.
            const paidCurrent = sub.status === 'active' || sub.status === 'overdue' ? inv : null;
            const share = input.refund === 'full' ? 1 : sub.status === 'active' ? unused : 0;
            if (paidCurrent && share > 0) {
              const cn = await issueCreditNote(tx, {
                orgId: p.orgId,
                invoice: paidCurrent,
                taxablePaise: paidCurrent.taxablePaise * share,
                reason: `${input.refund === 'full' ? 'Full refund' : `Unused ${Math.round(unused * 100)} % of the period`}: ${reason}`,
                at: now,
                settings,
                subscriptionId: id,
                by: p.email,
              });
              if (cn) {
                await moveWallet(tx, {
                  orgId: p.orgId,
                  customerId: sub.customerId,
                  kind: 'refund',
                  amountPaise: cn.totalPaise,
                  description: `Credit note ${cn.number} for ${sub.name} (invoice ${paidCurrent.number})`,
                  invoiceId: paidCurrent.id,
                  subscriptionId: id,
                  actorLabel: p.email,
                });
                credit = { number: cn.number, totalPaise: cn.totalPaise };
              }
            }
          }
        }
        await tx
          .update(subscriptions)
          .set({ status: 'cancelled', cancelledAt: now, cancelAt: now, cancelReason: reason, deleteVps: input.deleteVps, pendingAction: sub.guestId ? (input.deleteVps ? 'delete' : 'suspend') : null, pendingBy: p.email, lastError: null })
          .where(eq(subscriptions.id, id));
        if (sub.serviceId)
          await tx
            .update(services)
            .set({ status: 'cancelled', endDate: now.toISOString().slice(0, 10) })
            .where(eq(services.id, sub.serviceId));
      }
      await this.rec(
        p,
        meta,
        'billing.subscription_cancel',
        { type: 'subscription', id },
        { name: sub.name, when: input.when, refund: input.refund, deleteVps: input.deleteVps, creditNote: credit?.number ?? null, credited: credit?.totalPaise ?? 0, reason },
        sub.customerId,
        tx,
      );
      return { ok: true, creditNote: credit };
    });
  }

  /** Suspend or unsuspend a subscription's VPS by hand (staff), or withdraw a cancellation set for the end of the period. */
  async subscriptionAction(p: Principal, id: string, input: I<typeof subscriptionActionSchema>, meta: RequestMeta) {
    const staff = p.userType === 'staff';
    const clientActions = ['keep', 'renew', 'auto_renew_on', 'auto_renew_off'];
    if (staff) this.staffWrite(p);
    else if (!p.permissions.has('orders.place') || !clientActions.includes(input.action)) throw forbidden();
    if (input.action === 'renew') return this.renewNow(p, id, meta);
    return this.db.transaction(async (tx) => {
      const locked = await tx.execute(sql`select id from subscriptions where id = ${id} and org_id = ${p.orgId} for update`);
      if (!locked.rows.length) throw NF('Subscription');
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
      const sub = s!;
      if (!staff && sub.customerId !== p.customerId) throw NF('Subscription');
      if (input.action === 'auto_renew_on' || input.action === 'auto_renew_off') {
        if (sub.status === 'cancelled') throw new ConflictException({ error: 'cancelled', message: 'This subscription is cancelled' });
        await tx
          .update(subscriptions)
          .set({ autoRenew: input.action === 'auto_renew_on' })
          .where(eq(subscriptions.id, id));
      } else if (input.action === 'keep') {
        if (sub.status === 'cancelled' || !sub.cancelAt) throw new ConflictException({ error: 'not_cancelling', message: 'There is no cancellation to withdraw' });
        await tx.update(subscriptions).set({ cancelAt: null, cancelReason: null, deleteVps: false }).where(eq(subscriptions.id, id));
      } else {
        if (!sub.guestId) throw new BadRequestException({ error: 'no_vps', message: 'No VPS is linked to this subscription' });
        if (sub.pendingAction === 'delete') throw new ConflictException({ error: 'deleting', message: 'The VPS is being deleted' });
        await tx.update(subscriptions).set({ pendingAction: input.action, pendingBy: p.email, lastError: null }).where(eq(subscriptions.id, id));
      }
      await this.rec(p, meta, `billing.subscription_${input.action}`, { type: 'subscription', id }, { name: sub.name }, sub.customerId, tx);
      return { ok: true };
    });
  }

  /**
   * Renew one VPS now from the wallet (the client for their own, or staff): one month, GST invoice. An
   * overdue one is paid up; a suspended one starts a fresh month today and is unsuspended within a minute;
   * an active one is extended by a month. 402 when the wallet is short.
   */
  private async renewNow(p: Principal, id: string, meta: RequestMeta) {
    const now = new Date();
    try {
      return await this.db.transaction(async (tx) => {
        const locked = await tx.execute(sql`select id from subscriptions where id = ${id} and org_id = ${p.orgId} for update`);
        if (!locked.rows.length) throw NF('Subscription');
        const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id));
        const sub = s!;
        if (p.userType !== 'staff' && sub.customerId !== p.customerId) throw NF('Subscription');
        if (sub.status === 'cancelled') throw new ConflictException({ error: 'cancelled', message: 'This subscription is cancelled; order a new VPS instead' });
        if (sub.cancelAt) throw new ConflictException({ error: 'cancelling', message: 'This VPS is set to end; keep it first, then renew' });
        const settings = await loadSettings(tx, p.orgId);
        if (!settings) throw new ConflictException({ error: 'billing_not_set_up', message: 'Billing is not set up' });
        const r = await chargeRenewal(tx, sub, settings, now, p.email);
        if (r.unsuspend && sub.guestId) await tx.update(subscriptions).set({ pendingAction: 'unsuspend', pendingBy: p.email }).where(eq(subscriptions.id, id));
        if (r.unsuspend && sub.serviceId) await tx.update(services).set({ status: 'active' }).where(eq(services.id, sub.serviceId));
        await this.rec(p, meta, 'billing.renewed', { type: 'subscription', id }, { name: sub.name, invoice: r.invoice.number, total: r.invoice.totalPaise, byHand: true, wasSuspended: r.unsuspend }, sub.customerId, tx);
        return { ok: true, invoice: { id: r.invoice.id, number: r.invoice.number, totalPaise: r.invoice.totalPaise } };
      });
    } catch (e) {
      if (e instanceof InsufficientFunds)
        throw new HttpException(
          { error: 'insufficient_funds', message: `The wallet has ${formatInr(e.balancePaise)}; renewing needs ${formatInr(e.neededPaise)} (incl. GST). Add funds first.`, balancePaise: e.balancePaise, neededPaise: e.neededPaise },
          HttpStatus.PAYMENT_REQUIRED,
        );
      throw e;
    }
  }

  async creditNote(p: Principal, id: string) {
    const [c] = await this.db
      .select()
      .from(creditNotes)
      .where(and(eq(creditNotes.id, id), eq(creditNotes.orgId, p.orgId)));
    const cid = this.scope(p, c?.customerId);
    if (!c || (cid && c.customerId !== cid)) throw NF('Credit note');
    const [inv] = await this.db.select().from(invoices).where(eq(invoices.id, c.invoiceId));
    return {
      ...c,
      invoice: {
        id: inv!.id,
        number: inv!.number,
        issuedAt: inv!.issuedAt,
        gstRateBp: inv!.gstRateBp,
        supplier: inv!.supplier,
        recipient: inv!.recipient,
        placeOfSupply: inv!.placeOfSupply,
        placeOfSupplyName: GST_STATES[inv!.placeOfSupply] ?? inv!.placeOfSupply,
        lines: inv!.lines,
      },
    };
  }

  private async creditNoteRows(p: Principal, customerId: string | null) {
    const rows = await this.db
      .select({ c: creditNotes, invoice: invoices.number, customer: customers.name })
      .from(creditNotes)
      .innerJoin(invoices, eq(invoices.id, creditNotes.invoiceId))
      .innerJoin(customers, eq(customers.id, creditNotes.customerId))
      .where(and(eq(creditNotes.orgId, p.orgId), ...(customerId ? [eq(creditNotes.customerId, customerId)] : [])))
      .orderBy(desc(creditNotes.issuedAt))
      .limit(500);
    return rows.map((r) => ({
      id: r.c.id,
      number: r.c.number,
      issuedAt: r.c.issuedAt,
      invoiceId: r.c.invoiceId,
      invoice: r.invoice,
      customer: r.customer,
      customerId: r.c.customerId,
      reason: r.c.reason,
      taxablePaise: r.c.taxablePaise,
      cgstPaise: r.c.cgstPaise,
      sgstPaise: r.c.sgstPaise,
      igstPaise: r.c.igstPaise,
      totalPaise: r.c.totalPaise,
    }));
  }

  async creditNotes(p: Principal, customerId?: string) {
    return this.creditNoteRows(p, this.scope(p, customerId));
  }

  /** For the Overview/Billing header: money owed and at risk, for staff. */
  async summary(p: Principal) {
    this.staffRead(p);
    const r = await this.db.execute<{ wallets: number; subs: number; mrr: number; overdue: number; suspended: number; review: number; provisioning: number; invoiced30: number }>(sql`
      select (select coalesce(sum(wallet_balance_paise), 0) from customers where org_id = ${p.orgId})::bigint as wallets,
             (select count(*) from subscriptions where org_id = ${p.orgId} and status <> 'cancelled')::int as subs,
             (select coalesce(sum(price_paise), 0) from subscriptions where org_id = ${p.orgId} and status in ('active', 'overdue'))::bigint as mrr,
             (select count(*) from subscriptions where org_id = ${p.orgId} and status = 'overdue')::int as overdue,
             (select count(*) from subscriptions where org_id = ${p.orgId} and status = 'suspended')::int as suspended,
             (select count(*) from vps_orders where org_id = ${p.orgId} and status = 'review')::int as review,
             (select count(*) from vps_orders where org_id = ${p.orgId} and status = 'provisioning')::int as provisioning,
             (select coalesce(sum(total_paise), 0) from invoices where org_id = ${p.orgId} and issued_at > now() - interval '30 days')::bigint as invoiced30`);
    const x = r.rows[0]!;
    const settings = await loadSettings(this.db, p.orgId);
    return {
      billingReady: !!settings,
      walletsPaise: Number(x.wallets),
      subscriptions: x.subs,
      monthlyPaise: Number(x.mrr),
      overdue: x.overdue,
      suspended: x.suspended,
      review: x.review,
      provisioning: x.provisioning,
      invoiced30dPaise: Number(x.invoiced30),
    };
  }

  /** VPSs a client could be linked to when resolving an order by hand (staff). */
  async guestsFor(p: Principal, orderId: string) {
    this.staffRead(p);
    const [o] = await this.db
      .select()
      .from(vpsOrders)
      .where(and(eq(vpsOrders.id, orderId), eq(vpsOrders.orgId, p.orgId)));
    if (!o) throw NF('Order');
    const [plan] = await this.db.select().from(vpsPlans).where(eq(vpsPlans.id, o.planId));
    const rows = await this.db
      .select({ id: virtGuests.id, name: virtGuests.name, externalId: virtGuests.externalId, customerId: virtGuests.customerId })
      .from(virtGuests)
      .where(
        and(eq(virtGuests.orgId, p.orgId), ...(plan ? [eq(virtGuests.integrationId, plan.integrationId)] : []), sql`(${virtGuests.customerId} is null or ${virtGuests.customerId} = ${o.customerId})`, sql`${virtGuests.missingSince} is null`),
      )
      .orderBy(desc(virtGuests.lastSeenAt))
      .limit(200);
    const taken = rows.length
      ? await this.db
          .select({ g: subscriptions.guestId })
          .from(subscriptions)
          .where(
            inArray(
              subscriptions.guestId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    return rows.filter((r) => !taken.some((t) => t.g === r.id)).map((r) => ({ ...r, likely: r.name.toLowerCase() === o.hostname.toLowerCase() }));
  }
}
