import { and, eq, sql } from 'drizzle-orm';
import { GST_STATES, documentNumber, financialYear, gst, type GstBreakup } from '@crapplet/shared';
import type { DbOrTx } from '../db/db';
import { billingSettings, customers, invoices, walletTransactions, type BillingSetting, type Customer, type Invoice } from '../db/schema';

/**
 * The money core shared by the API and the worker. Every function takes the
 * caller's transaction, so a wallet change, its ledger row, the invoice and
 * the order or subscription it belongs to commit together or not at all.
 *
 * - Amounts are integers in paise. Prices are before GST.
 * - A wallet balance is changed only here, under a row lock on the customer,
 *   with a wallet_transactions row holding the balance after the change.
 * - Invoice and receipt numbers are consecutive per series and financial
 *   year, taken from a counter row locked by the same transaction (a rolled
 *   back transaction gives its number back, so there are no gaps).
 */

export class InsufficientFunds extends Error {
  constructor(
    readonly balancePaise: number,
    readonly neededPaise: number,
  ) {
    super('Insufficient wallet balance');
  }
}

export async function loadSettings(tx: DbOrTx, orgId: string): Promise<BillingSetting | null> {
  const [s] = await tx.select().from(billingSettings).where(eq(billingSettings.orgId, orgId));
  return s ?? null;
}

/** Next number in a series (INV, RCPT…) for a financial year; consecutive, no gaps. */
export async function nextNumber(tx: DbOrTx, orgId: string, series: string, fy: string): Promise<number> {
  const r = await tx.execute<{ last: number }>(sql`
    insert into billing_counters (org_id, series, fy, last) values (${orgId}, ${series}, ${fy}, 1)
    on conflict (org_id, series, fy) do update set last = billing_counters.last + 1
    returning last`);
  return Number(r.rows[0]!.last);
}

/** Locks the customer row (the wallet) for the rest of the transaction. */
export async function lockWallet(tx: DbOrTx, orgId: string, customerId: string): Promise<Customer> {
  const r = await tx.execute<{ id: string }>(sql`select id from customers where id = ${customerId} and org_id = ${orgId} for update`);
  if (!r.rows.length) throw new Error('Customer not found');
  const [c] = await tx.select().from(customers).where(eq(customers.id, customerId));
  return c!;
}

export interface WalletMove {
  orgId: string;
  customerId: string;
  kind: 'credit' | 'debit' | 'refund' | 'adjustment';
  /** Signed: + into the wallet, − out of it. */
  amountPaise: number;
  description: string;
  method?: string | null;
  reference?: string | null;
  receiptNumber?: string | null;
  invoiceId?: string | null;
  orderId?: string | null;
  subscriptionId?: string | null;
  actorLabel?: string | null;
  idempotencyKey?: string | null;
  /** Corrections by staff may take a wallet below zero; charges never do. */
  allowNegative?: boolean;
}

/** Changes a wallet balance and records it. Throws InsufficientFunds rather than going below zero. */
export async function moveWallet(tx: DbOrTx, m: WalletMove): Promise<{ id: number; balanceAfterPaise: number }> {
  const c = await lockWallet(tx, m.orgId, m.customerId);
  const after = c.walletBalancePaise + m.amountPaise;
  if (after < 0 && !m.allowNegative) throw new InsufficientFunds(c.walletBalancePaise, -m.amountPaise);
  await tx.update(customers).set({ walletBalancePaise: after }).where(eq(customers.id, c.id));
  const [row] = await tx
    .insert(walletTransactions)
    .values({
      orgId: m.orgId,
      customerId: m.customerId,
      kind: m.kind,
      amountPaise: m.amountPaise,
      balanceAfterPaise: after,
      method: m.method ?? null,
      reference: m.reference ?? null,
      description: m.description.slice(0, 500),
      receiptNumber: m.receiptNumber ?? null,
      invoiceId: m.invoiceId ?? null,
      orderId: m.orderId ?? null,
      subscriptionId: m.subscriptionId ?? null,
      actorLabel: m.actorLabel ?? null,
      idempotencyKey: m.idempotencyKey ?? null,
    })
    .returning({ id: walletTransactions.id });
  return { id: row!.id, balanceAfterPaise: after };
}

/** The client's place of supply and GST on an amount, with the organization's settings. */
export function taxFor(settings: BillingSetting, client: Pick<Customer, 'gstin' | 'stateCode'>, taxablePaise: number, rateBp = settings.gstRateBp): GstBreakup & { placeOfSupply: string; rateBp: number } {
  const pos = client.gstin && /^\d{2}/.test(client.gstin) && GST_STATES[client.gstin.slice(0, 2)] ? client.gstin.slice(0, 2) : client.stateCode && GST_STATES[client.stateCode] ? client.stateCode : settings.stateCode;
  return { ...gst(taxablePaise, rateBp, settings.stateCode, pos), placeOfSupply: pos, rateBp };
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPaise: number;
  periodFrom?: string;
  periodTo?: string;
  subscriptionId?: string;
}

/**
 * Issues a tax invoice (paid from the wallet). Supplier and recipient are
 * copied as they are now, so later edits never change an issued invoice.
 */
export async function issueInvoice(
  tx: DbOrTx,
  input: { orgId: string; customerId: string; settings: BillingSetting; lines: InvoiceLine[]; at: Date; rateBp?: number; placeOfSupply?: string; subscriptionId?: string | null; orderId?: string | null },
): Promise<Invoice> {
  const st = input.settings;
  const [c] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.orgId, input.orgId)));
  if (!c) throw new Error('Customer not found');
  const taxable = input.lines.reduce((a, l) => a + l.quantity * l.unitPaise, 0);
  const rate = input.rateBp ?? st.gstRateBp;
  const pos = input.placeOfSupply ?? taxFor(st, c, 0).placeOfSupply;
  const t = gst(taxable, rate, st.stateCode, pos);
  const fy = financialYear(input.at);
  const seq = await nextNumber(tx, input.orgId, st.invoicePrefix, fy);
  const [inv] = await tx
    .insert(invoices)
    .values({
      orgId: input.orgId,
      customerId: c.id,
      number: documentNumber(st.invoicePrefix, fy, seq),
      fy,
      issuedAt: input.at,
      supplier: { legalName: st.legalName, address: st.address, stateCode: st.stateCode, gstin: st.gstin, pan: st.pan, email: st.email, phone: st.phone, bankDetails: st.bankDetails, notes: st.invoiceNotes },
      recipient: { name: c.legalName || c.name, code: c.code, address: c.billingAddress, stateCode: c.stateCode, gstin: c.gstin, email: c.billingEmail ?? c.contactEmail },
      placeOfSupply: pos,
      lines: input.lines.map((l) => ({ ...l, sac: st.sacCode, amountPaise: l.quantity * l.unitPaise })),
      taxablePaise: t.taxablePaise,
      gstRateBp: rate,
      cgstPaise: t.cgstPaise,
      sgstPaise: t.sgstPaise,
      igstPaise: t.igstPaise,
      totalPaise: t.totalPaise,
      status: 'paid',
      subscriptionId: input.subscriptionId ?? null,
      orderId: input.orderId ?? null,
    })
    .returning();
  return inv!;
}

/** Receipt voucher number for a payment received into a wallet. */
export async function nextReceipt(tx: DbOrTx, orgId: string, settings: BillingSetting | null, at: Date): Promise<string> {
  const prefix = settings?.receiptPrefix ?? 'RCPT';
  const fy = financialYear(at);
  return documentNumber(prefix, fy, await nextNumber(tx, orgId, prefix, fy));
}
