import { z } from 'zod';

/**
 * Native billing: prepaid wallets, VPS orders from Virtualizor plans, client
 * prices, monthly renewals and GST tax invoices. Money is kept in paise
 * (integers); prices exclude GST.
 */

/* ------------------------------------------------------------------ money */

export const paise = z.number().int().min(0).max(10_000_000_000_00);
/** "₹1,23,456.78" (Indian grouping). */
export function formatInr(p: number): string {
  const neg = p < 0;
  const abs = Math.abs(Math.round(p));
  const rupees = Math.floor(abs / 100);
  const ps = String(abs % 100).padStart(2, '0');
  return `${neg ? '−' : ''}₹${rupees.toLocaleString('en-IN')}.${ps}`;
}
/** Rupees (as typed, e.g. "499" or "499.50") to paise; null when not a valid amount. */
export function rupeesToPaise(v: string | number): number | null {
  const s = String(v)
    .trim()
    .replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [r, f = ''] = s.split('.');
  return Number(r) * 100 + Number(f.padEnd(2, '0'));
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const t = r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', t].filter(Boolean).join(' ');
}
/** "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only" (Indian numbering). */
export function amountInWords(p: number): string {
  const abs = Math.abs(Math.round(p));
  let r = Math.floor(abs / 100);
  const ps = abs % 100;
  const parts: string[] = [];
  const crore = Math.floor(r / 1_00_00_000);
  r %= 1_00_00_000;
  const lakh = Math.floor(r / 1_00_000);
  r %= 1_00_000;
  const thousand = Math.floor(r / 1000);
  r %= 1000;
  if (crore) parts.push(`${crore >= 1000 ? amountInWords(crore * 100).replace(/^Rupees | Only$/g, '') : below1000(crore)} Crore`);
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (r) parts.push(below1000(r));
  const rupees = parts.join(' ') || 'Zero';
  return `Rupees ${rupees}${ps ? ` and ${below1000(ps)} Paise` : ''} Only`;
}

/* ------------------------------------------------------------------ GST */

/** GST state codes (first two digits of a GSTIN), for place of supply. */
export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
  '97': 'Other Territory',
};
const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** A GSTIN: 15 characters, valid state code and check digit. */
export function validGstin(g: string): boolean {
  const v = g.trim().toUpperCase();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v) || !GST_STATES[v.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const prod = GSTIN_CHARS.indexOf(v[i]!) * (i % 2 ? 2 : 1);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === v[14];
}

export interface GstBreakup {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  /** intra: CGST + SGST (same state); inter: IGST. */
  kind: 'intra' | 'inter';
}
/** GST on a taxable amount: CGST + SGST when the place of supply is the supplier's state, else IGST. Each tax is rounded to the paisa. */
export function gst(taxablePaise: number, rateBp: number, supplierState: string, placeOfSupply: string): GstBreakup {
  const intra = supplierState === placeOfSupply;
  if (intra) {
    const half = Math.round((taxablePaise * rateBp) / 2 / 10_000);
    return { taxablePaise, cgstPaise: half, sgstPaise: half, igstPaise: 0, totalPaise: taxablePaise + 2 * half, kind: 'intra' };
  }
  const igst = Math.round((taxablePaise * rateBp) / 10_000);
  return { taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: igst, totalPaise: taxablePaise + igst, kind: 'inter' };
}
/** Place of supply for a service: the client's state when known (GSTIN or address), else the supplier's. */
export function placeOfSupply(client: { gstin?: string | null; stateCode?: string | null }, supplierState: string): string {
  if (client.gstin && validGstin(client.gstin)) return client.gstin.slice(0, 2);
  return client.stateCode && GST_STATES[client.stateCode] ? client.stateCode : supplierState;
}

/** Indian financial year of a date, e.g. "26-27" for 1 Apr 2026 – 31 Mar 2027 (IST). */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear() - (ist.getUTCMonth() < 3 ? 1 : 0);
  return `${String(y % 100).padStart(2, '0')}-${String((y + 1) % 100).padStart(2, '0')}`;
}
/** Invoice number, e.g. "INV/26-27/0001": consecutive per series and financial year, at most 16 characters (GST rule). */
export function documentNumber(prefix: string, fy: string, seq: number): string {
  return `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;
}

/** One month later on the same day (31 Jan → 28/29 Feb), in UTC. */
export function addMonth(d: Date): Date {
  const n = new Date(d.getTime());
  const day = n.getUTCDate();
  n.setUTCDate(1);
  n.setUTCMonth(n.getUTCMonth() + 1);
  const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate();
  n.setUTCDate(Math.min(day, last));
  return n;
}

/* ------------------------------------------------------------------ schemas */

const prefix = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,6}$/, 'Up to 6 letters, digits or dashes');
export const billingSettingsSchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(1000),
  stateCode: z.string().refine((v) => !!GST_STATES[v], 'Choose a state'),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => validGstin(v), 'Not a valid GSTIN')
    .nullable()
    .optional(),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Not a valid PAN')
    .nullable()
    .optional(),
  sacCode: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/)
    .default('998315'),
  gstRateBp: z.number().int().min(0).max(2800).default(1800),
  invoicePrefix: prefix.default('INV'),
  receiptPrefix: prefix.default('RCPT'),
  graceDays: z.number().int().min(0).max(60).default(3),
  email: z.string().trim().email().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  bankDetails: z.string().trim().max(1000).nullable().optional(),
  invoiceNotes: z.string().trim().max(2000).nullable().optional(),
});
export type BillingSettingsInput = z.infer<typeof billingSettingsSchema>;

export const customerBillingSchema = z.object({
  legalName: z.string().trim().max(200).nullable().optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => validGstin(v), 'Not a valid GSTIN')
    .nullable()
    .optional(),
  address: z.string().trim().max(1000).nullable().optional(),
  stateCode: z
    .string()
    .refine((v) => !!GST_STATES[v], 'Choose a state')
    .nullable()
    .optional(),
  billingEmail: z.string().trim().email().nullable().optional(),
});

export const WALLET_METHODS = ['upi', 'bank_transfer', 'cash', 'cheque', 'card', 'other'] as const;
export const WALLET_METHOD_LABELS: Record<(typeof WALLET_METHODS)[number], string> = { upi: 'UPI', bank_transfer: 'Bank transfer (NEFT/RTGS/IMPS)', cash: 'Cash', cheque: 'Cheque', card: 'Card', other: 'Other' };
export const addFundsSchema = z.object({ amountPaise: paise.min(100), method: z.enum(WALLET_METHODS), reference: z.string().trim().max(120).nullable().optional(), note: z.string().trim().max(500).nullable().optional() });
/** A correction by staff (positive or negative), with a reason; not a payment. */
export const walletAdjustSchema = z.object({
  amountPaise: z
    .number()
    .int()
    .min(-10_000_000_00)
    .max(10_000_000_00)
    .refine((v) => v !== 0),
  reason: z.string().trim().min(3).max(500),
});

export const vpsPlanSchema = z.object({
  integrationId: z.string().uuid(),
  externalPlanId: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullable().optional(),
  pricePaise: paise.min(100),
  /** Which Virtualizor server to create on: null = let Virtualizor choose. */
  serverId: z.string().trim().max(40).nullable().optional(),
  active: z.boolean().default(true),
  visibleToCustomers: z.boolean().default(true),
  /** OS templates clients may choose (Virtualizor osid); empty = all of the plan's type. */
  osIds: z.array(z.string().max(20)).max(200).default([]),
});
export const clientPriceSchema = z.object({ planId: z.string().uuid(), pricePaise: paise.min(100).nullable() });

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(63 * 4)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, 'Use a hostname such as vps1.example.com');
export const vpsOrderSchema = z.object({
  /** Staff ordering for a client; ignored for client users (always their own account). */
  customerId: z.string().uuid().optional(),
  planId: z.string().uuid(),
  hostname,
  osId: z.string().trim().min(1).max(20),
  password: z.string().min(10, 'At least 10 characters').max(64).regex(/[a-z]/, 'Needs a lower-case letter').regex(/[A-Z]/, 'Needs a capital letter').regex(/\d/, 'Needs a digit'),
});
export type VpsOrderInput = z.infer<typeof vpsOrderSchema>;

export const SUBSCRIPTION_STATUSES = ['active', 'overdue', 'suspended', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const subscriptionUpdateSchema = z.object({
  pricePaise: paise.min(100).optional(),
  /** Stop renewing (the VPS is not deleted). */
  cancel: z.boolean().optional(),
  nextDueAt: z.string().datetime().optional(),
});
