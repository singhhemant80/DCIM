import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { amountInWords, formatInr, GST_STATES, rupeesToPaise, validGstin, WALLET_METHOD_LABELS, WALLET_METHODS } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, formatDateTime } from '../lib/format';
import { useCustomerOptions } from '../lib/colocation';
import { Button, Chip, cx, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Stat, Table, Textarea } from '../components/ui';

/**
 * Billing & Wallet: VPS plans from Virtualizor at a monthly price, client
 * prices, prepaid wallets (staff add funds), VPS orders paid from the
 * wallet, monthly renewals and GST tax invoices. Client users get their own
 * account: balance, VPSs, ordering, invoices and payments.
 */

/* ------------------------------------------------------------------ types */

type SubStatus = 'active' | 'overdue' | 'suspended' | 'cancelled';
interface SubT {
  id: string;
  customerId: string;
  customer: string;
  name: string;
  pricePaise: number;
  status: SubStatus;
  periodStart: string;
  nextDueAt: string;
  overdueSince: string | null;
  suspendedAt: string | null;
  cancelledAt: string | null;
  suspendsAt: string | null;
  guestId: string | null;
  guestName: string | null;
  guestStatus: string | null;
  guestMissing: boolean;
  lastError?: string | null;
}
interface TxT {
  id: number;
  at: string;
  kind: 'credit' | 'debit' | 'refund' | 'adjustment';
  amountPaise: number;
  balanceAfterPaise: number;
  method: string | null;
  reference: string | null;
  description: string;
  receiptNumber: string | null;
  invoiceId: string | null;
  actor?: string | null;
}
interface OrderT {
  id: string;
  createdAt: string;
  customerId: string;
  customer: string;
  plan: string | null;
  hostname: string;
  osName: string | null;
  pricePaise: number;
  taxPaise: number;
  totalPaise: number;
  status: 'provisioning' | 'active' | 'refunded' | 'review';
  jobStatus: string | null;
  error: string | null;
  guestId: string | null;
  guestName: string | null;
  invoiceId: string | null;
  byCustomer: boolean;
  jobId?: string | null;
  placedBy?: string | null;
}
interface InvoiceRowT {
  id: string;
  number: string;
  issuedAt: string;
  totalPaise: number;
  taxablePaise: number;
  status: string;
  description: string;
  customer?: string;
  customerId?: string;
  cgstPaise?: number;
  sgstPaise?: number;
  igstPaise?: number;
  placeOfSupply?: string;
}
interface AccountT {
  customer: { id: string; code: string; name: string; status: string; legalName: string | null; gstin: string | null; billingAddress: string | null; stateCode: string | null; billingEmail: string | null; contactEmail: string | null };
  balancePaise: number;
  monthlyPaise: number;
  graceDays: number | null;
  billingReady: boolean;
  subscriptions: SubT[];
  transactions: TxT[];
  invoices: InvoiceRowT[];
  orders: OrderT[];
}
interface PlanT {
  id: string;
  name: string;
  description: string | null;
  specs: { virt?: string | null; ramMb?: number | null; diskGb?: number | null; cores?: number | null; bandwidthGb?: number | null; ips?: number | null; ips6?: number | null; speedMbps?: number | null };
  pricePaise: number;
  gstPaise: number | null;
  totalPaise: number | null;
  orderable: boolean;
  integrationId?: string;
  integration?: string;
  externalPlanId?: string;
  serverId?: string | null;
  osIds?: string[];
  active?: boolean;
  visibleToCustomers?: boolean;
  defaultPricePaise?: number;
}
interface HvT {
  id: string;
  name: string;
  enabled: boolean;
  actionsEnabled: boolean;
  lastSyncAt: string | null;
  synced: boolean;
  servers: { id: string; name: string; status: string | null; cpus: number | null; memUsedBytes: number | null; memTotalBytes: number | null; vms: number; missing: boolean }[];
  templates: { osid: string; name: string; type: string | null }[];
  plans: {
    id: string;
    name: string;
    virt: string | null;
    ramMb: number | null;
    diskGb: number | null;
    cores: number | null;
    bandwidthGb: number | null;
    ips: number | null;
    ips6: number | null;
    speedMbps: number | null;
    offeredAs: string | null;
  }[];
}
interface SettingsT {
  legalName: string;
  address: string;
  stateCode: string;
  gstin: string | null;
  pan: string | null;
  sacCode: string;
  gstRateBp: number;
  invoicePrefix: string;
  receiptPrefix: string;
  graceDays: number;
  email: string | null;
  phone: string | null;
  bankDetails: string | null;
  invoiceNotes: string | null;
}
interface WalletRowT {
  id: string;
  code: string;
  name: string;
  status: string;
  balancePaise: number;
  gstin: string | null;
  stateCode: string | null;
  subscriptions: number;
  monthlyPaise: number;
  overdue: number;
  suspended: number;
  lastTransactionAt: string | null;
}
interface SummaryT {
  billingReady: boolean;
  walletsPaise: number;
  subscriptions: number;
  monthlyPaise: number;
  overdue: number;
  suspended: number;
  review: number;
  provisioning: number;
  invoiced30dPaise: number;
}

const B = '/invoicing';
const inr = formatInr;
const SUB_TONE: Record<SubStatus, 'ok' | 'warn' | 'crit' | 'neutral'> = { active: 'ok', overdue: 'warn', suspended: 'crit', cancelled: 'neutral' };
const SUB_LABEL: Record<SubStatus, string> = { active: 'Active', overdue: 'Overdue', suspended: 'Suspended', cancelled: 'Cancelled' };
const ORDER_TONE: Record<OrderT['status'], 'ok' | 'warn' | 'crit' | 'neutral' | 'accent'> = { provisioning: 'accent', active: 'ok', refunded: 'neutral', review: 'warn' };
const ORDER_LABEL: Record<OrderT['status'], string> = { provisioning: 'Creating', active: 'Delivered', refunded: 'Refunded', review: 'Needs review' };
const TX_LABEL: Record<TxT['kind'], string> = { credit: 'Payment', debit: 'Charge', refund: 'Refund', adjustment: 'Correction' };
const stateName = (c: string | null | undefined) => (c ? `${GST_STATES[c] ?? c} (${c})` : '—');
const specLine = (s: PlanT['specs']) =>
  [
    s.cores ? `${s.cores} vCPU` : null,
    s.ramMb ? (s.ramMb >= 1024 ? `${+(s.ramMb / 1024).toFixed(1)} GB RAM` : `${s.ramMb} MB RAM`) : null,
    s.diskGb ? `${s.diskGb} GB disk` : null,
    s.bandwidthGb ? `${s.bandwidthGb >= 1000 ? `${+(s.bandwidthGb / 1000).toFixed(1)} TB` : `${s.bandwidthGb} GB`} traffic` : null,
    s.ips ? `${s.ips} IPv4` : null,
    s.ips6 ? `${s.ips6} IPv6` : null,
    s.speedMbps ? `${s.speedMbps} Mbps` : null,
  ]
    .filter(Boolean)
    .join(' · ');
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const gib = (b: number) => `${(b / 1024 ** 3).toFixed(b >= 100 * 1024 ** 3 ? 0 : 1)} GB`;
const paiseToRupees = (p: number) => (p / 100).toFixed(2).replace(/\.00$/, '');

function Money({ p, className }: { p: number; className?: string }) {
  return <span className={cx('tabular-nums', p < 0 && 'text-crit', className)}>{inr(p)}</span>;
}

/* ------------------------------------------------------------------ page */

const TABS = [
  { key: 'wallets', label: 'Clients & wallets' },
  { key: 'orders', label: 'Orders' },
  { key: 'subscriptions', label: 'Renewals' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'plans', label: 'Plans & prices' },
  { key: 'settings', label: 'GST settings' },
] as const;

export function WalletPage() {
  const { me, can } = useAuth();
  const [params, setParams] = useSearchParams();
  if (me?.user.userType === 'customer') return <ClientHome />;
  if (!can('billing.read'))
    return (
      <>
        <PageHeader title="Billing & Wallet" />
        <EmptyState title="No access">Billing needs the “View wallets, invoices, plans and prices” permission.</EmptyState>
      </>
    );
  const tab = (params.get('tab') as (typeof TABS)[number]['key']) ?? 'wallets';
  const customer = params.get('customer');
  return (
    <>
      <PageHeader
        title="Billing & Wallet"
        description="Sell Virtualizor plans at your prices, take payments into prepaid wallets, and let renewals and GST invoices run on their own."
        actions={can('billing.write') ? <NewOrderButton /> : undefined}
      />
      <SummaryStrip />
      <div role="tablist" aria-label="Billing sections" className="mb-4 flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-rule bg-sunken p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key && !customer}
            onClick={() => setParams(t.key === 'wallets' ? {} : { tab: t.key }, { replace: true })}
            className={cx('h-8 rounded-lg px-3.5 text-[13.5px]', tab === t.key && !customer ? 'bg-panel font-semibold text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {customer ? (
        <>
          <button onClick={() => setParams({}, { replace: true })} className="mb-3 text-[13px] text-accent hover:underline">
            ← All clients
          </button>
          <ClientAccount customerId={customer} staff />
        </>
      ) : (
        <>
          {tab === 'wallets' && <WalletsTab onOpen={(id) => setParams({ customer: id })} />}
          {tab === 'orders' && <OrdersTab />}
          {tab === 'subscriptions' && <SubscriptionsTab />}
          {tab === 'invoices' && <InvoicesTab />}
          {tab === 'plans' && <PlansTab />}
          {tab === 'settings' && <SettingsTab />}
        </>
      )}
    </>
  );
}

function SummaryStrip() {
  const q = useQuery({ queryKey: ['billing', 'summary'], queryFn: () => api.get<SummaryT>(`${B}/summary`), refetchInterval: 30_000 });
  if (!q.data) return null;
  const s = q.data;
  return (
    <div className="mb-4 grid gap-3">
      {!s.billingReady && (
        <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-[13.5px]">
          Set up your GST details in <b>GST settings</b> before taking orders: invoices need your legal name, address, state and GSTIN.
        </div>
      )}
      <Panel>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
          <Stat label="Monthly recurring" value={inr(s.monthlyPaise)} note={`${s.subscriptions} VPS subscription${s.subscriptions === 1 ? '' : 's'}, before GST`} />
          <Stat label="In client wallets" value={inr(s.walletsPaise)} note="prepaid, not yet used" />
          <Stat label="Invoiced, 30 days" value={inr(s.invoiced30dPaise)} note="incl. GST" />
          <Stat label="Overdue" value={s.overdue} tone={s.overdue ? 'warn' : undefined} note="in their grace days" />
          <Stat label="Suspended" value={s.suspended} tone={s.suspended ? 'crit' : undefined} note="for non-payment" />
          <Stat label="Orders to review" value={s.review} tone={s.review ? 'warn' : undefined} note={s.provisioning ? `${s.provisioning} being created` : 'none being created'} />
        </dl>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ staff tabs */

function WalletsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['billing', 'wallets'], queryFn: () => api.get<WalletRowT[]>(`${B}/wallets`) });
  const [filter, setFilter] = useState('');
  const rows = (q.data ?? []).filter((r) => !filter || `${r.name} ${r.code} ${r.gstin ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Panel title="Clients" actions={<Input placeholder="Search clients" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 w-56" />} flush>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : (
        <Table label="Client wallets">
          <thead>
            <tr>
              <th>Client</th>
              <th>GSTIN</th>
              <th className="text-right">Wallet</th>
              <th className="text-right">VPSs</th>
              <th className="text-right">Per month</th>
              <th>Status</th>
              <th>Last movement</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => onOpen(r.id)}>
                <td>
                  <span className="font-medium text-accent">{r.name}</span> <span className="text-[12px] text-ink-3">{r.code}</span>
                </td>
                <td className="font-mono text-[12.5px]">{r.gstin ?? <span className="text-ink-3">unregistered</span>}</td>
                <td className="text-right">
                  <Money p={r.balancePaise} className="font-semibold" />
                </td>
                <td className="text-right tabular-nums">{r.subscriptions}</td>
                <td className="text-right">
                  <Money p={r.monthlyPaise} />
                </td>
                <td>{r.suspended ? <Chip tone="crit">{r.suspended} suspended</Chip> : r.overdue ? <Chip tone="warn">{r.overdue} overdue</Chip> : r.subscriptions ? <Chip tone="ok">Paid up</Chip> : <span className="text-ink-3">—</span>}</td>
                <td className="text-[13px] text-ink-2">{r.lastTransactionAt ? formatDate(r.lastTransactionAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function OrdersTab() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['billing', 'orders'], queryFn: () => api.get<OrderT[]>(`${B}/orders`), refetchInterval: 10_000 });
  const [resolving, setResolving] = useState<OrderT | null>(null);
  return (
    <Panel title="VPS orders" flush>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !q.data!.length ? (
        <EmptyState title="No orders yet">Orders placed by you or your clients appear here.</EmptyState>
      ) : (
        <OrdersTable rows={q.data!} staff onResolve={can('billing.write') ? setResolving : undefined} />
      )}
      {resolving && <ResolveModal order={resolving} onClose={() => setResolving(null)} />}
    </Panel>
  );
}

function OrdersTable({ rows, staff, onResolve }: { rows: OrderT[]; staff: boolean; onResolve?: (o: OrderT) => void }) {
  return (
    <Table label="VPS orders">
      <thead>
        <tr>
          <th>Placed</th>
          {staff && <th>Client</th>}
          <th>VPS</th>
          <th>Plan</th>
          <th className="text-right">Charged</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => (
          <tr key={o.id}>
            <td className="text-[13px] whitespace-nowrap">{formatDateTime(o.createdAt)}</td>
            {staff && (
              <td>
                {o.customer}
                {o.byCustomer && <span className="block text-[12px] text-ink-3">ordered by the client</span>}
              </td>
            )}
            <td>
              <span className="font-mono text-[13px]">{o.hostname}</span>
              {o.osName && <span className="block text-[12px] text-ink-3">{o.osName}</span>}
            </td>
            <td>{o.plan ?? '—'}</td>
            <td className="text-right">
              <Money p={o.totalPaise} />
              <span className="block text-[12px] text-ink-3">incl. {inr(o.taxPaise)} GST</span>
            </td>
            <td>
              <Chip tone={ORDER_TONE[o.status]}>{o.status === 'provisioning' && o.jobStatus === 'recovery' ? 'Interrupted' : ORDER_LABEL[o.status]}</Chip>
              {o.error && <span className="mt-0.5 block max-w-[36ch] text-[12px] text-ink-3">{o.error}</span>}
            </td>
            <td className="text-right whitespace-nowrap">
              {o.invoiceId && (
                <Link to={`/wallet/invoices/${o.invoiceId}`} className="text-[13px] text-accent hover:underline">
                  Invoice
                </Link>
              )}
              {staff && o.jobId && (
                <Link to={`/provisioning?job=${o.jobId}`} className="ml-3 text-[13px] text-accent hover:underline">
                  Job
                </Link>
              )}
              {onResolve && o.status === 'review' && (
                <Button size="sm" className="ml-3" onClick={() => onResolve(o)}>
                  Resolve
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ResolveModal({ order, onClose }: { order: OrderT; onClose: () => void }) {
  const qc = useQueryClient();
  const guests = useQuery({ queryKey: ['billing', 'order-guests', order.id], queryFn: () => api.get<{ id: string; name: string; externalId: string; likely: boolean }[]>(`${B}/orders/${order.id}/guests`) });
  const [guestId, setGuestId] = useState('');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: (body: object) => api.post(`${B}/orders/${order.id}/resolve`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      onClose();
    },
  });
  const likely = guests.data?.find((g) => g.likely);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Resolve order ${order.hostname}`} description="The create request reached Virtualizor, but no clear answer came back. Check the VPS list in the Virtualizor panel, then choose.">
      <div className="grid gap-4">
        <p className="text-[13px] text-ink-2">{order.error}</p>
        <div className="rounded-xl border border-rule p-3">
          <h3 className="mb-2 text-[13.5px] font-semibold">The VPS exists</h3>
          <Field label="VPS (from the last sync)" hint={likely ? `${likely.name} matches the ordered hostname.` : 'Run a sync of the integration if it is not listed yet.'}>
            {(id) => (
              <Select id={id} value={guestId || likely?.id || ''} onChange={(e) => setGuestId(e.target.value)}>
                <option value="">Choose…</option>
                {(guests.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} (VPS {g.externalId})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button className="mt-2" variant="primary" busy={m.isPending} disabled={!(guestId || likely)} onClick={() => m.mutate({ action: 'delivered', guestId: guestId || likely?.id })}>
            Link it, invoice and start renewals
          </Button>
        </div>
        <div className="rounded-xl border border-rule p-3">
          <h3 className="mb-2 text-[13.5px] font-semibold">It was not created</h3>
          <Field label="Note">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Checked the panel: no such VPS" />}</Field>
          <Button className="mt-2" busy={m.isPending} onClick={() => m.mutate({ action: 'refund', reason: reason || undefined })}>
            Refund {inr(order.totalPaise)} to the wallet
          </Button>
        </div>
        <ErrorNote error={m.error} />
      </div>
    </Modal>
  );
}

function SubscriptionsTab() {
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['billing', 'subscriptions', status], queryFn: () => api.get<SubT[]>(`${B}/subscriptions${qs({ status })}`), refetchInterval: 30_000 });
  return (
    <Panel
      title="Monthly renewals"
      actions={
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-44" aria-label="Status">
          <option value="">All</option>
          {(Object.keys(SUB_LABEL) as SubStatus[]).map((s) => (
            <option key={s} value={s}>
              {SUB_LABEL[s]}
            </option>
          ))}
        </Select>
      }
      flush
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !q.data!.length ? (
        <EmptyState title="Nothing here">VPS orders become monthly renewals once delivered.</EmptyState>
      ) : (
        <SubsTable rows={q.data!} staff />
      )}
    </Panel>
  );
}

function SubsTable({ rows, staff }: { rows: SubT[]; staff: boolean }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState<SubT | null>(null);
  return (
    <>
      <Table label="Subscriptions">
        <thead>
          <tr>
            {staff && <th>Client</th>}
            <th>VPS</th>
            <th className="text-right">Per month</th>
            <th>Status</th>
            <th>Next renewal</th>
            {staff && can('billing.write') && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              {staff && <td>{s.customer}</td>}
              <td>
                {s.name}
                {s.guestName && (
                  <span className="block text-[12px] text-ink-3">
                    {s.guestId ? (
                      <Link to={`/integrations/virtualizor/vms/${s.guestId}`} className="hover:text-accent hover:underline">
                        {s.guestName}
                      </Link>
                    ) : (
                      s.guestName
                    )}
                    {s.guestStatus ? ` · ${s.guestStatus}` : ''}
                    {s.guestMissing ? ' · no longer in Virtualizor' : ''}
                  </span>
                )}
              </td>
              <td className="text-right">
                <Money p={s.pricePaise} />
                <span className="block text-[12px] text-ink-3">+ GST</span>
              </td>
              <td>
                <Chip tone={SUB_TONE[s.status]}>{SUB_LABEL[s.status]}</Chip>
                {s.status === 'overdue' && s.suspendsAt && <span className="block text-[12px] text-ink-3">suspends {formatDateTime(s.suspendsAt)} unless paid</span>}
                {s.status === 'suspended' && <span className="block text-[12px] text-ink-3">since {formatDate(s.suspendedAt)}; resumes when the wallet covers a month</span>}
                {s.lastError && <span className="block max-w-[40ch] text-[12px] text-crit">{s.lastError}</span>}
              </td>
              <td className="text-[13px] whitespace-nowrap">{s.status === 'cancelled' ? `cancelled ${formatDate(s.cancelledAt)}` : formatDate(s.nextDueAt)}</td>
              {staff && can('billing.write') && (
                <td className="text-right">
                  {s.status !== 'cancelled' && (
                    <Button size="sm" onClick={() => setEditing(s)}>
                      Change
                    </Button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
      {editing && <SubModal sub={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function SubModal({ sub, onClose }: { sub: SubT; onClose: () => void }) {
  const qc = useQueryClient();
  const [price, setPrice] = useState(paiseToRupees(sub.pricePaise));
  const [due, setDue] = useState(sub.nextDueAt.slice(0, 10));
  const [cancel, setCancel] = useState(false);
  const p = rupeesToPaise(price);
  const m = useMutation({
    mutationFn: () => api.put(`${B}/subscriptions/${sub.id}`, cancel ? { cancel: true } : { pricePaise: p ?? undefined, nextDueAt: new Date(`${due}T${sub.nextDueAt.slice(11)}`).toISOString() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={sub.name} description={`${sub.customer} · renews monthly from the wallet`}>
      <div className="grid gap-3">
        <Field label="Monthly price (₹, before GST)" error={p === null ? 'Enter an amount' : undefined}>
          {(id) => <Input id={id} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} disabled={cancel} />}
        </Field>
        <Field label="Next renewal">{(id) => <Input id={id} type="date" value={due} onChange={(e) => setDue(e.target.value)} disabled={cancel} />}</Field>
        <label className="flex items-start gap-2 text-[13.5px]">
          <input type="checkbox" className="mt-1" checked={cancel} onChange={(e) => setCancel(e.target.checked)} />
          <span>
            Stop renewing (cancel). The VPS is <b>not</b> deleted or suspended; remove it in Virtualizor if it should go.
          </span>
        </label>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button variant={cancel ? 'danger' : 'primary'} busy={m.isPending} disabled={!cancel && p === null} onClick={() => m.mutate()}>
            {cancel ? 'Cancel renewals' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function InvoicesTab() {
  const q = useQuery({ queryKey: ['billing', 'invoices'], queryFn: () => api.get<InvoiceRowT[]>(`${B}/invoices`) });
  const totals = useMemo(() => (q.data ?? []).reduce((a, i) => ({ taxable: a.taxable + i.taxablePaise, gst: a.gst + i.totalPaise - i.taxablePaise, total: a.total + i.totalPaise }), { taxable: 0, gst: 0, total: 0 }), [q.data]);
  const csv = () => {
    const rows = [
      ['Number', 'Date', 'Client', 'Place of supply', 'Taxable', 'CGST', 'SGST', 'IGST', 'Total'],
      ...(q.data ?? []).map((i) => [i.number, i.issuedAt.slice(0, 10), i.customer ?? '', i.placeOfSupply ?? '', ...[i.taxablePaise, i.cgstPaise ?? 0, i.sgstPaise ?? 0, i.igstPaise ?? 0, i.totalPaise].map((x) => (x / 100).toFixed(2))]),
    ];
    const blob = new Blob([rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'invoices.csv';
    a.click();
  };
  return (
    <Panel
      title="Tax invoices"
      actions={
        <Button size="sm" onClick={csv} disabled={!q.data?.length}>
          Export CSV (for GSTR-1)
        </Button>
      }
      flush
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !q.data!.length ? (
        <EmptyState title="No invoices yet">An invoice is issued for every VPS charge: the first month when the VPS is delivered, then each renewal.</EmptyState>
      ) : (
        <Table label="Invoices">
          <thead>
            <tr>
              <th>Number</th>
              <th>Date</th>
              <th>Client</th>
              <th>For</th>
              <th className="text-right">Taxable</th>
              <th className="text-right">GST</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {q.data!.map((i) => (
              <tr key={i.id}>
                <td>
                  <Link to={`/wallet/invoices/${i.id}`} className="font-mono text-[13px] text-accent hover:underline">
                    {i.number}
                  </Link>
                </td>
                <td className="text-[13px]">{formatDate(i.issuedAt)}</td>
                <td>{i.customer}</td>
                <td className="max-w-[40ch] truncate text-[13px] text-ink-2">{i.description}</td>
                <td className="text-right">
                  <Money p={i.taxablePaise} />
                </td>
                <td className="text-right">
                  <Money p={i.totalPaise - i.taxablePaise} />
                  <span className="block text-[11.5px] text-ink-3">{i.igstPaise ? 'IGST' : 'CGST + SGST'}</span>
                </td>
                <td className="text-right font-semibold">
                  <Money p={i.totalPaise} />
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={4} className="text-right text-[13px] font-semibold">
                All listed
              </td>
              <td className="text-right font-semibold">
                <Money p={totals.taxable} />
              </td>
              <td className="text-right font-semibold">
                <Money p={totals.gst} />
              </td>
              <td className="text-right font-semibold">
                <Money p={totals.total} />
              </td>
            </tr>
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function PlansTab() {
  const { can } = useAuth();
  const write = can('billing.write');
  const plans = useQuery({ queryKey: ['billing', 'plans'], queryFn: () => api.get<PlanT[]>(`${B}/plans`) });
  const hv = useQuery({ queryKey: ['billing', 'hv-plans'], queryFn: () => api.get<HvT[]>(`${B}/hypervisor-plans`) });
  const [editing, setEditing] = useState<{ plan?: PlanT; hv: HvT; ext: HvT['plans'][number] } | null>(null);
  return (
    <div className="grid gap-5">
      <Panel title="On sale" flush>
        {plans.isLoading ? (
          <Loading />
        ) : plans.error ? (
          <ErrorNote error={plans.error} className="m-4" />
        ) : !plans.data!.length ? (
          <EmptyState title="No plans on sale">Pick a Virtualizor plan below and give it a monthly price.</EmptyState>
        ) : (
          <Table label="Plans on sale">
            <thead>
              <tr>
                <th>Plan</th>
                <th>Resources</th>
                <th className="text-right">Per month</th>
                <th>Offered</th>
                {write && <th />}
              </tr>
            </thead>
            <tbody>
              {plans.data!.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="font-medium">{p.name}</span>
                    <span className="block text-[12px] text-ink-3">
                      {p.integration} · Virtualizor plan {p.externalPlanId} ·{' '}
                      {p.serverId ? `on ${hv.data?.find((x) => x.id === p.integrationId)?.servers.find((x) => x.id === p.serverId)?.name ?? `server ${p.serverId}`}` : 'server chosen by Virtualizor'}
                    </span>
                  </td>
                  <td className="text-[13px] text-ink-2">{specLine(p.specs) || '—'}</td>
                  <td className="text-right">
                    <Money p={p.pricePaise} />
                    <span className="block text-[12px] text-ink-3">+ GST</span>
                  </td>
                  <td>
                    {!p.active ? <Chip>Not on sale</Chip> : p.visibleToCustomers ? <Chip tone="ok">Clients can order</Chip> : <Chip tone="accent">Staff only</Chip>}
                    {!p.orderable && p.active && <span className="block text-[12px] text-warn">VM actions are off for {p.integration}</span>}
                  </td>
                  {write && (
                    <td className="text-right">
                      <Button
                        size="sm"
                        onClick={() => {
                          const h = hv.data?.find((x) => x.id === p.integrationId);
                          const ext = h?.plans.find((x) => x.id === p.externalPlanId);
                          if (h)
                            setEditing({ plan: p, hv: h, ext: ext ?? { id: p.externalPlanId!, name: p.name, virt: null, ramMb: null, diskGb: null, cores: null, bandwidthGb: null, ips: null, ips6: null, speedMbps: null, offeredAs: p.id } });
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Panel title="Plans in Virtualizor" flush>
        {hv.isLoading ? (
          <Loading />
        ) : hv.error ? (
          <ErrorNote error={hv.error} className="m-4" />
        ) : !hv.data!.length ? (
          <EmptyState title="No Virtualizor integration">
            Add your panel in{' '}
            <Link to="/integrations/virtualizor" className="text-accent hover:underline">
              Virtualizor
            </Link>{' '}
            first; its plans are read on every sync.
          </EmptyState>
        ) : (
          hv.data!.map((h) => (
            <div key={h.id} className="border-t border-rule first:border-t-0">
              <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px]">
                <b>{h.name}</b>
                <span className="text-ink-3">{h.lastSyncAt ? `synced ${formatDateTime(h.lastSyncAt)}` : 'not synced yet'}</span>
                {!h.actionsEnabled && <Chip tone="warn">VM actions off: orders can't create VPSs</Chip>}
              </div>
              {!h.synced ? (
                <p className="px-4 pb-3 text-[13px] text-ink-2">No plans read yet. The next sync reads them (Virtualizor admin API, act=plans).</p>
              ) : (
                <Table label={`Plans in ${h.name}`}>
                  <thead>
                    <tr>
                      <th>Plan</th>
                      <th>Resources</th>
                      <th>Type</th>
                      {write && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {h.plans.map((x) => (
                      <tr key={x.id}>
                        <td>
                          {x.name} <span className="text-[12px] text-ink-3">#{x.id}</span>
                        </td>
                        <td className="text-[13px] text-ink-2">{specLine(x) || '—'}</td>
                        <td className="text-[13px] uppercase">{x.virt ?? '—'}</td>
                        {write && (
                          <td className="text-right">
                            {x.offeredAs ? (
                              <Chip tone="ok">On sale</Chip>
                            ) : (
                              <Button size="sm" variant="primary" onClick={() => setEditing({ hv: h, ext: x })}>
                                Sell this plan
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          ))
        )}
      </Panel>
      {editing && <PlanModal {...editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function PlanModal({ plan, hv, ext, onClose }: { plan?: PlanT; hv: HvT; ext: HvT['plans'][number]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(plan?.name ?? ext.name);
  const [description, setDescription] = useState(plan?.description ?? '');
  const [price, setPrice] = useState(plan ? paiseToRupees(plan.defaultPricePaise ?? plan.pricePaise) : '');
  const [serverId, setServerId] = useState(plan?.serverId ?? '');
  const [active, setActive] = useState(plan?.active ?? true);
  const [visible, setVisible] = useState(plan?.visibleToCustomers ?? true);
  const sameType = hv.templates.filter((t) => !ext.virt || (t.type ?? '').toLowerCase() === ext.virt.toLowerCase());
  const offered = sameType.length ? sameType : hv.templates;
  const [osIds, setOsIds] = useState<string[]>(plan?.osIds ?? []);
  const p = rupeesToPaise(price);
  const m = useMutation({
    mutationFn: () => {
      const body = { integrationId: hv.id, externalPlanId: ext.id, name, description: description || null, pricePaise: p, serverId: serverId || null, active, visibleToCustomers: visible, osIds };
      return plan ? api.put(`${B}/plans/${plan.id}`, body) : api.post(`${B}/plans`, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={plan ? `Edit ${plan.name}` : `Sell ${ext.name}`} description={`${hv.name}, Virtualizor plan #${ext.id}: ${specLine(ext) || 'resources as set in Virtualizor'}`} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name clients see">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Monthly price (₹, before GST)" hint="Clients can get their own price on their account." error={price && p === null ? 'Enter an amount like 499 or 499.50' : undefined}>
          {(id) => <Input id={id} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="499" />}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description (optional)">{(id) => <Textarea id={id} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </div>
        <Field label="Create VPSs on" hint={serverId ? 'Every VPS of this plan is created on this server.' : 'Virtualizor picks a server for each new VPS.'}>
          {(id) => (
            <Select id={id} value={serverId} onChange={(e) => setServerId(e.target.value)}>
              <option value="">Let Virtualizor choose</option>
              {hv.servers
                .filter((x) => !x.missing || x.id === serverId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.memTotalBytes ? ` · ${gib(Math.max(0, x.memTotalBytes - (x.memUsedBytes ?? 0)))} RAM free` : ''}
                    {` · ${x.vms} VPS${x.vms === 1 ? '' : 's'}`}
                    {x.status && x.status !== 'online' ? ` · ${x.status}` : ''}
                  </option>
                ))}
              {serverId && !hv.servers.some((x) => x.id === serverId) && <option value={serverId}>Server {serverId} (not in the last sync)</option>}
            </Select>
          )}
        </Field>
        <div className="grid content-start gap-2 pt-6 text-[13.5px]">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> On sale
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Clients can order it themselves
          </label>
        </div>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-[13px] font-medium">Operating systems offered</p>
          <p className="mb-2 text-[12.5px] text-ink-3">None ticked: every installed {ext.virt?.toUpperCase() ?? ''} template.</p>
          <div className="grid max-h-48 grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-1 overflow-y-auto rounded-xl border border-rule p-2 text-[13px]">
            {offered.map((t) => (
              <label key={t.osid} className="flex items-center gap-2">
                <input type="checkbox" checked={osIds.includes(t.osid)} onChange={(e) => setOsIds(e.target.checked ? [...osIds, t.osid] : osIds.filter((x) => x !== t.osid))} />
                {t.name}
              </label>
            ))}
            {!offered.length && <span className="text-ink-3">No OS templates read from this panel yet.</span>}
          </div>
        </div>
      </div>
      <ErrorNote error={m.error} className="mt-3" />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={m.isPending} disabled={!name || p === null || !price} onClick={() => m.mutate()}>
          {plan ? 'Save' : 'Put on sale'}
        </Button>
      </div>
    </Modal>
  );
}

function SettingsTab() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['billing', 'settings'], queryFn: () => api.get<{ settings: SettingsT | null; states: Record<string, string> }>(`${B}/settings`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  return <SettingsForm initial={q.data!.settings} readOnly={!can('billing.write')} />;
}

function SettingsForm({ initial, readOnly }: { initial: SettingsT | null; readOnly: boolean }) {
  const qc = useQueryClient();
  const [f, setF] = useState<SettingsT>(
    initial ?? { legalName: '', address: '', stateCode: '', gstin: '', pan: '', sacCode: '998315', gstRateBp: 1800, invoicePrefix: 'INV', receiptPrefix: 'RCPT', graceDays: 3, email: '', phone: '', bankDetails: '', invoiceNotes: '' },
  );
  const set = (k: keyof SettingsT) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const gstinBad = !!f.gstin && !validGstin(f.gstin);
  const m = useMutation({
    mutationFn: () =>
      api.put(`${B}/settings`, {
        ...f,
        gstin: f.gstin || null,
        pan: f.pan || null,
        email: f.email || null,
        phone: f.phone || null,
        bankDetails: f.bankDetails || null,
        invoiceNotes: f.invoiceNotes || null,
        gstRateBp: Number(f.gstRateBp),
        graceDays: Number(f.graceDays),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing'] }),
  });
  return (
    <Panel title="Your GST details and billing rules">
      <fieldset disabled={readOnly} className="grid gap-3 sm:grid-cols-2">
        <Field label="Legal name (as on GST registration)">{(id) => <Input id={id} value={f.legalName} onChange={set('legalName')} />}</Field>
        <Field label="GSTIN" error={gstinBad ? 'Not a valid GSTIN (check the 15 characters)' : undefined}>
          {(id) => (
            <Input
              id={id}
              className="font-mono uppercase"
              value={f.gstin ?? ''}
              onChange={(e) => {
                const v = e.target.value.toUpperCase();
                setF({ ...f, gstin: v, stateCode: validGstin(v) ? v.slice(0, 2) : f.stateCode });
              }}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label="Registered address">{(id) => <Textarea id={id} rows={2} value={f.address} onChange={set('address')} />}</Field>
        </div>
        <Field label="State (for CGST/SGST vs IGST)">
          {(id) => (
            <Select id={id} value={f.stateCode} onChange={set('stateCode')}>
              <option value="">Choose…</option>
              {Object.entries(GST_STATES).map(([c, n]) => (
                <option key={c} value={c}>
                  {c} {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="PAN">{(id) => <Input id={id} className="font-mono uppercase" value={f.pan ?? ''} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} />}</Field>
        <Field label="SAC code" hint="998315: hosting and IT infrastructure provisioning services.">
          {(id) => <Input id={id} value={f.sacCode} onChange={set('sacCode')} />}
        </Field>
        <Field label="GST rate (%)">{(id) => <Input id={id} inputMode="decimal" value={String(f.gstRateBp / 100)} onChange={(e) => setF({ ...f, gstRateBp: Math.round(Number(e.target.value) * 100) || 0 })} />}</Field>
        <Field label="Invoice number prefix" hint={`Numbers look like ${f.invoicePrefix || 'INV'}/26-27/0001, consecutive per financial year.`}>
          {(id) => <Input id={id} value={f.invoicePrefix} onChange={(e) => setF({ ...f, invoicePrefix: e.target.value.toUpperCase() })} />}
        </Field>
        <Field label="Receipt number prefix">{(id) => <Input id={id} value={f.receiptPrefix} onChange={(e) => setF({ ...f, receiptPrefix: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Grace days before suspension" hint="After a renewal falls due and the wallet is short, the VPS is suspended in Virtualizor after this many days.">
          {(id) => <Input id={id} type="number" min={0} max={60} value={f.graceDays} onChange={(e) => setF({ ...f, graceDays: Number(e.target.value) })} />}
        </Field>
        <Field label="Billing e-mail">{(id) => <Input id={id} type="email" value={f.email ?? ''} onChange={set('email')} />}</Field>
        <Field label="Phone">{(id) => <Input id={id} value={f.phone ?? ''} onChange={set('phone')} />}</Field>
        <div className="sm:col-span-2">
          <Field label="Bank details printed on invoices (for top-ups)">{(id) => <Textarea id={id} rows={3} value={f.bankDetails ?? ''} onChange={set('bankDetails')} placeholder="A/c name, number, IFSC, UPI ID" />}</Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Notes printed on invoices">{(id) => <Textarea id={id} rows={2} value={f.invoiceNotes ?? ''} onChange={set('invoiceNotes')} />}</Field>
        </div>
      </fieldset>
      <p className="mt-3 text-[12.5px] text-ink-3">Have your accountant confirm the SAC code, rate and place-of-supply treatment for your registration. Issued invoices keep the details they were issued with.</p>
      <ErrorNote error={m.error} className="mt-3" />
      {!readOnly && (
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" busy={m.isPending} disabled={!f.legalName || !f.address || !f.stateCode || gstinBad} onClick={() => m.mutate()}>
            Save
          </Button>
          {m.isSuccess && <span className="text-[13px] text-ok">Saved</span>}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ a client's account (staff and client) */

export function ClientAccount({ customerId, staff }: { customerId?: string; staff: boolean }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['billing', 'account', customerId ?? 'me'], queryFn: () => api.get<AccountT>(`${B}/account${qs({ customerId })}`), refetchInterval: 15_000 });
  const [modal, setModal] = useState<'funds' | 'adjust' | 'profile' | 'order' | 'prices' | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const a = q.data!;
  const write = staff && can('billing.write');
  const canOrder = staff ? write : can('orders.place');
  const due = a.subscriptions.filter((s) => s.status !== 'cancelled');
  const next = due[0];
  return (
    <div className="grid gap-5">
      <Panel
        title={staff ? `${a.customer.name} · wallet` : 'Your wallet'}
        actions={
          <div className="flex flex-wrap gap-2">
            {write && (
              <>
                <Button size="sm" variant="primary" onClick={() => setModal('funds')}>
                  Add funds
                </Button>
                <Button size="sm" onClick={() => setModal('adjust')}>
                  Correct balance
                </Button>
                <Button size="sm" onClick={() => setModal('prices')}>
                  Client prices
                </Button>
              </>
            )}
            {canOrder && (
              <Button size="sm" variant={write ? 'secondary' : 'primary'} onClick={() => setModal('order')}>
                Order a VPS
              </Button>
            )}
          </div>
        }
      >
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-4">
          <Stat label="Balance" value={inr(a.balancePaise)} tone={a.balancePaise < 0 ? 'crit' : undefined} note={staff ? 'prepaid' : 'available for orders and renewals'} />
          <Stat label="VPS renewals per month" value={inr(a.monthlyPaise)} note={`${due.length} VPS${due.length === 1 ? '' : 's'}, before GST`} />
          <Stat label="Next renewal" value={next ? formatDate(next.nextDueAt) : '—'} note={next ? next.name : 'nothing due'} />
        </dl>
        {!staff && (
          <p className="mt-4 text-[13px] text-ink-2">
            To add funds, pay us by UPI or bank transfer and tell us the reference; we credit your wallet and you get a receipt here. Renewals are taken from the wallet on their due date; if the balance is short, a VPS is suspended
            {a.graceDays !== null ? ` after ${a.graceDays} day${a.graceDays === 1 ? '' : 's'}` : ''} and resumes as soon as the wallet covers a month.
          </p>
        )}
      </Panel>

      <Panel title="VPS subscriptions" flush>
        {a.subscriptions.length ? (
          <SubsTable rows={a.subscriptions} staff={staff} />
        ) : (
          <EmptyState title="No VPSs yet">{canOrder ? 'Order one from a plan; it is paid from the wallet and renews monthly.' : 'VPSs ordered through billing appear here.'}</EmptyState>
        )}
      </Panel>

      {a.orders.length > 0 && (
        <Panel title="Orders" flush>
          <OrdersTable rows={a.orders} staff={false} />
        </Panel>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Invoices" flush>
          {a.invoices.length ? (
            <Table label="Invoices">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Date</th>
                  <th className="text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {a.invoices.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/wallet/invoices/${i.id}`} className="font-mono text-[13px] text-accent hover:underline">
                        {i.number}
                      </Link>
                      <span className="block max-w-[34ch] truncate text-[12px] text-ink-3">{i.description}</span>
                    </td>
                    <td className="text-[13px]">{formatDate(i.issuedAt)}</td>
                    <td className="text-right">
                      <Money p={i.totalPaise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No invoices yet">A GST invoice is issued for every VPS charge.</EmptyState>
          )}
        </Panel>
        <Panel title="Wallet history" flush>
          {a.transactions.length ? (
            <Table label="Wallet history">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {a.transactions.map((t) => (
                  <tr key={t.id}>
                    <td className="text-[13px] whitespace-nowrap">{formatDate(t.at)}</td>
                    <td className="text-[13px]">
                      <span className="font-medium">{TX_LABEL[t.kind]}</span> {t.description !== 'Payment received' && <span className="text-ink-2">{t.description}</span>}
                      <span className="block text-[12px] text-ink-3">
                        {[t.method ? (WALLET_METHOD_LABELS[t.method as keyof typeof WALLET_METHOD_LABELS] ?? t.method) : null, t.reference, staff && t.actor ? `by ${t.actor}` : null].filter(Boolean).join(' · ')}
                        {t.receiptNumber && (
                          <>
                            {' · '}
                            <Link to={`/wallet/receipts/${t.id}`} className="text-accent hover:underline">
                              Receipt {t.receiptNumber}
                            </Link>
                          </>
                        )}
                        {t.invoiceId && (
                          <>
                            {' · '}
                            <Link to={`/wallet/invoices/${t.invoiceId}`} className="text-accent hover:underline">
                              Invoice
                            </Link>
                          </>
                        )}
                      </span>
                    </td>
                    <td className={cx('text-right tabular-nums', t.amountPaise > 0 ? 'text-ok' : '')}>
                      {t.amountPaise > 0 ? '+' : ''}
                      {inr(t.amountPaise)}
                    </td>
                    <td className="text-right">
                      <Money p={t.balanceAfterPaise} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title="No movements yet" />
          )}
        </Panel>
      </div>

      <Panel
        title="GST details for invoices"
        actions={
          (write || (!staff && can('orders.place'))) && (
            <Button size="sm" onClick={() => setModal('profile')}>
              Edit
            </Button>
          )
        }
      >
        <dl className="grid gap-x-6 gap-y-2 text-[13.5px] sm:grid-cols-[max-content_1fr]">
          <dt className="text-ink-2">Billed to</dt>
          <dd>{a.customer.legalName || a.customer.name}</dd>
          <dt className="text-ink-2">GSTIN</dt>
          <dd className="font-mono">{a.customer.gstin ?? <span className="font-sans text-ink-3">Not registered (B2C invoice)</span>}</dd>
          <dt className="text-ink-2">Address</dt>
          <dd className="whitespace-pre-line">{a.customer.billingAddress ?? '—'}</dd>
          <dt className="text-ink-2">Place of supply</dt>
          <dd>{stateName(a.customer.gstin?.slice(0, 2) ?? a.customer.stateCode) === '—' ? 'Our state (no state given)' : stateName(a.customer.gstin?.slice(0, 2) ?? a.customer.stateCode)}</dd>
          <dt className="text-ink-2">Invoices e-mail</dt>
          <dd>{a.customer.billingEmail ?? a.customer.contactEmail ?? '—'}</dd>
        </dl>
      </Panel>

      {modal === 'funds' && <FundsModal account={a} onClose={() => setModal(null)} />}
      {modal === 'adjust' && <AdjustModal account={a} onClose={() => setModal(null)} />}
      {modal === 'profile' && <ProfileModal account={a} onClose={() => setModal(null)} />}
      {modal === 'prices' && <PricesModal account={a} onClose={() => setModal(null)} />}
      {modal === 'order' && <OrderModal customerId={staff ? a.customer.id : undefined} balancePaise={a.balancePaise} onClose={() => setModal(null)} />}
    </div>
  );
}

function ClientHome() {
  return (
    <>
      <PageHeader title="Billing & Wallet" description="Your balance, VPSs, invoices and payments." />
      <ClientAccount staff={false} />
    </>
  );
}

function FundsModal({ account, onClose }: { account: AccountT; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof WALLET_METHODS)[number]>('upi');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [key] = useState(newKey);
  const p = rupeesToPaise(amount);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ receiptNumber: string; transactionId: number; balancePaise: number }>(`${B}/customers/${account.customer.id}/funds`, { amountPaise: p, method, reference: reference || null, note: note || null }, { 'Idempotency-Key': key }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing'] }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Add funds for ${account.customer.name}`}
      description="Record a payment you have received. The client gets a receipt; due renewals are charged on the next billing run (within a minute)."
    >
      {m.data ? (
        <div className="grid gap-3">
          <p>
            Credited <b>{inr(p ?? 0)}</b>. New balance <b>{inr(m.data.balancePaise)}</b>.
          </p>
          <div className="flex justify-end gap-2">
            <Link to={`/wallet/receipts/${m.data.transactionId}`} className="inline-flex h-9 items-center rounded-lg px-3 text-[13.5px] text-accent hover:underline">
              Receipt {m.data.receiptNumber}
            </Link>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <Field label="Amount received (₹)" error={amount && p === null ? 'Enter an amount like 1000 or 1000.50' : undefined}>
            {(id) => <Input id={id} inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000" />}
          </Field>
          <Field label="How it was paid">
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                {WALLET_METHODS.map((x) => (
                  <option key={x} value={x}>
                    {WALLET_METHOD_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reference (UTR, cheque number…)">{(id) => <Input id={id} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
          <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <ErrorNote error={m.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={m.isPending} disabled={!p || p < 100} onClick={() => m.mutate()}>
              Credit {p ? inr(p) : ''}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function AdjustModal({ account, onClose }: { account: AccountT; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [sign, setSign] = useState<1 | -1>(-1);
  const [reason, setReason] = useState('');
  const p = rupeesToPaise(amount);
  const m = useMutation({
    mutationFn: () => api.post(`${B}/customers/${account.customer.id}/adjust`, { amountPaise: sign * (p ?? 0), reason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Correct the balance"
      description="For mistakes only (a payment recorded twice, a goodwill credit). It is not a payment and gets no receipt; the reason is kept in the ledger and the audit log."
    >
      <div className="grid gap-3">
        <div className="flex gap-2">
          <Select value={String(sign)} onChange={(e) => setSign(Number(e.target.value) as 1 | -1)} aria-label="Direction" className="w-36">
            <option value="-1">Take off</option>
            <option value="1">Add</option>
          </Select>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount in ₹" aria-label="Amount" />
        </div>
        <Field label="Reason">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={m.isPending} disabled={!p || reason.trim().length < 3} onClick={() => m.mutate()}>
            {sign < 0 ? 'Take off' : 'Add'} {p ? inr(p) : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ProfileModal({ account, onClose }: { account: AccountT; onClose: () => void }) {
  const qc = useQueryClient();
  const c = account.customer;
  const [legalName, setLegalName] = useState(c.legalName ?? '');
  const [gstin, setGstin] = useState(c.gstin ?? '');
  const [address, setAddress] = useState(c.billingAddress ?? '');
  const [stateCode, setStateCode] = useState(c.stateCode ?? '');
  const [email, setEmail] = useState(c.billingEmail ?? '');
  const bad = !!gstin && !validGstin(gstin);
  const m = useMutation({
    mutationFn: () => api.put(`${B}/customers/${c.id}/profile`, { legalName: legalName || null, gstin: gstin || null, address: address || null, stateCode: stateCode || null, billingEmail: email || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="GST details for invoices" description="Used on invoices issued from now on. With a GSTIN the invoice is B2C → B2B, and its state decides CGST + SGST or IGST.">
      <div className="grid gap-3">
        <Field label="Legal name">{(id) => <Input id={id} value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder={c.name} />}</Field>
        <Field label="GSTIN (optional)" error={bad ? 'Not a valid GSTIN' : undefined}>
          {(id) => (
            <Input
              id={id}
              className="font-mono uppercase"
              value={gstin}
              onChange={(e) => {
                const v = e.target.value.toUpperCase();
                setGstin(v);
                if (validGstin(v)) setStateCode(v.slice(0, 2));
              }}
            />
          )}
        </Field>
        <Field label="Billing address">{(id) => <Textarea id={id} rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />}</Field>
        <Field label="State (place of supply)">
          {(id) => (
            <Select id={id} value={stateCode} onChange={(e) => setStateCode(e.target.value)}>
              <option value="">Not given (our state)</option>
              {Object.entries(GST_STATES).map(([k, n]) => (
                <option key={k} value={k}>
                  {k} {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="E-mail for invoices">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={c.contactEmail ?? ''} />}</Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={m.isPending} disabled={bad} onClick={() => m.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PricesModal({ account, onClose }: { account: AccountT; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['billing', 'prices', account.customer.id],
    queryFn: () => api.get<{ planId: string; name: string; active: boolean; defaultPricePaise: number; clientPricePaise: number | null }[]>(`${B}/customers/${account.customer.id}/prices`),
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const m = useMutation({ mutationFn: (b: { planId: string; pricePaise: number | null }) => api.put(`${B}/customers/${account.customer.id}/prices`, b), onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing'] }) });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Prices for ${account.customer.name}`}
      description="A client price replaces the plan price for new orders and for this client's future renewals of new VPSs. Existing renewals keep their price (change it under Renewals)."
      wide
    >
      {q.isLoading ? (
        <Loading />
      ) : (
        <Table label="Client prices">
          <thead>
            <tr>
              <th>Plan</th>
              <th className="text-right">Plan price</th>
              <th>Client price (₹/month, before GST)</th>
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((r) => {
              const v = draft[r.planId] ?? (r.clientPricePaise !== null ? paiseToRupees(r.clientPricePaise) : '');
              const p = v ? rupeesToPaise(v) : null;
              return (
                <tr key={r.planId}>
                  <td>
                    {r.name}
                    {!r.active && <span className="ml-1 text-[12px] text-ink-3">(not on sale)</span>}
                  </td>
                  <td className="text-right">
                    <Money p={r.defaultPricePaise} />
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <Input inputMode="decimal" className="h-8 w-32" value={v} placeholder="plan price" onChange={(e) => setDraft({ ...draft, [r.planId]: e.target.value })} aria-label={`Client price for ${r.name}`} />
                      <Button size="sm" disabled={(!!v && p === null) || m.isPending} onClick={() => m.mutate({ planId: r.planId, pricePaise: v ? p : null })}>
                        {v ? 'Set' : 'Use plan price'}
                      </Button>
                      {r.clientPricePaise !== null && <Chip tone="accent">{inr(r.clientPricePaise)}</Chip>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <ErrorNote error={m.error} className="mt-3" />
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ ordering */

function NewOrderButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Order a VPS for a client
      </Button>
      {open && <OrderModal pickCustomer onClose={() => setOpen(false)} />}
    </>
  );
}

function OrderModal({ customerId, pickCustomer, balancePaise, onClose }: { customerId?: string; pickCustomer?: boolean; balancePaise?: number; onClose: () => void }) {
  const qc = useQueryClient();
  const customers = useCustomerOptions();
  const [cid, setCid] = useState(customerId ?? '');
  const plans = useQuery({ queryKey: ['billing', 'plans'], queryFn: () => api.get<PlanT[]>(`${B}/plans`) });
  const prices = useQuery({ queryKey: ['billing', 'prices', cid], queryFn: () => api.get<{ planId: string; clientPricePaise: number | null }[]>(`${B}/customers/${cid}/prices`), enabled: !!cid && (pickCustomer || !!customerId) });
  const account = useQuery({ queryKey: ['billing', 'account', cid || 'me'], queryFn: () => api.get<AccountT>(`${B}/account${qs({ customerId: cid || undefined })}`), enabled: !!cid || (!customerId && !pickCustomer) });
  const [planId, setPlanId] = useState('');
  const templates = useQuery({ queryKey: ['billing', 'templates', planId], queryFn: () => api.get<{ osid: string; name: string }[]>(`${B}/plans/${planId}/templates`), enabled: !!planId });
  const [hostname, setHostname] = useState('');
  const [osId, setOsId] = useState('');
  const [serverId, setServerId] = useState('');
  const [password, setPassword] = useState('');
  const [key] = useState(newKey);
  const staffOrder = !!(pickCustomer || customerId);
  const hv = useQuery({ queryKey: ['billing', 'hv-plans'], queryFn: () => api.get<HvT[]>(`${B}/hypervisor-plans`), enabled: staffOrder });
  const list = (plans.data ?? []).filter((p) => p.active !== false && p.orderable);
  // With a single plan on sale there is nothing to choose: select it.
  const only = list.length === 1 ? list[0]!.id : null;
  useEffect(() => {
    if (!planId && only) setPlanId(only);
  }, [planId, only]);
  const plan = list.find((p) => p.id === planId);
  const servers = (hv.data?.find((h) => h.id === plan?.integrationId)?.servers ?? []).filter((x) => !x.missing);
  const planServer = plan?.serverId ? (servers.find((x) => x.id === plan.serverId)?.name ?? `server ${plan.serverId}`) : null;
  const price = plan ? (prices.data?.find((x) => x.planId === plan.id)?.clientPricePaise ?? plan.pricePaise) : null;
  const balance = account.data?.balancePaise ?? balancePaise ?? null;
  const pwOk = password.length >= 10 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
  const hostOk = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(hostname);
  const m = useMutation({
    mutationFn: () => api.post(`${B}/orders`, { customerId: cid || undefined, planId, hostname, osId, password, serverId: serverId || null }, { 'Idempotency-Key': key }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing'] }),
  });
  const gen = () => {
    const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const r = crypto.getRandomValues(new Uint32Array(16));
    setPassword(`${Array.from(r, (x) => a[x % a.length]).join('')}a7K`);
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Order a VPS"
      description="The first month (plus GST) is taken from the wallet now and the VPS is created in Virtualizor. If it can't be created, the amount goes back to the wallet."
      wide
    >
      {m.isSuccess ? (
        <div className="grid gap-3">
          <p>
            Order placed. <b>{hostname}</b> is being created in Virtualizor; it usually takes a few minutes. The invoice appears once the VPS exists.
          </p>
          <p className="text-[13px] text-ink-2">The root password is not stored after it is sent to Virtualizor: keep it safe now.</p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4">
          {pickCustomer && (
            <Field label="Client">
              {(id) => (
                <Select id={id} value={cid} onChange={(e) => setCid(e.target.value)}>
                  <option value="">Choose…</option>
                  {(customers.data?.items ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Plan</p>
            {plans.isLoading ? (
              <Loading />
            ) : !list.length ? (
              <p className="text-[13px] text-ink-2">No plans can be ordered right now.</p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2" role="radiogroup" aria-label="Plan">
                {list.map((p) => {
                  const own = prices.data?.find((x) => x.planId === p.id)?.clientPricePaise ?? p.pricePaise;
                  return (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={planId === p.id}
                      onClick={() => {
                        setPlanId(p.id);
                        setOsId('');
                        setServerId('');
                      }}
                      className={cx('rounded-xl border px-3 py-2.5 text-left transition', planId === p.id ? 'border-accent bg-accent/10' : 'border-rule hover:border-accent/50')}
                    >
                      <span className="block font-semibold">{p.name}</span>
                      <span className="block text-[12px] text-ink-2">{specLine(p.specs) || p.description || '—'}</span>
                      <span className="mt-1 block text-[15px] font-semibold tabular-nums">
                        {inr(own)}
                        <span className="text-[12px] font-normal text-ink-3"> /month + GST</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Hostname" error={hostname && !hostOk ? 'Use letters, digits, dashes and dots, e.g. vps1.example.com' : undefined}>
              {(id) => <Input id={id} value={hostname} onChange={(e) => setHostname(e.target.value.trim().toLowerCase())} placeholder="vps1.example.com" />}
            </Field>
            <Field label="Operating system">
              {(id) => (
                <Select id={id} value={osId} onChange={(e) => setOsId(e.target.value)} disabled={!planId}>
                  <option value="">{planId ? (templates.isLoading ? 'Loading…' : 'Choose…') : 'Choose a plan first'}</option>
                  {(templates.data ?? []).map((t) => (
                    <option key={t.osid} value={t.osid}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {staffOrder && (
              <div className="sm:col-span-2">
                <Field label="Create on server" hint={serverId ? 'The VPS is created on this server.' : planServer ? `The plan's server (${planServer}).` : 'Virtualizor picks the server.'}>
                  {(id) => (
                    <Select id={id} value={serverId} onChange={(e) => setServerId(e.target.value)} disabled={!planId}>
                      <option value="">{planServer ? `Plan default: ${planServer}` : 'Let Virtualizor choose'}</option>
                      {servers.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                          {x.memTotalBytes ? ` · ${gib(Math.max(0, x.memTotalBytes - (x.memUsedBytes ?? 0)))} RAM free` : ''}
                          {` · ${x.vms} VPS${x.vms === 1 ? '' : 's'}`}
                          {x.status && x.status !== 'online' ? ` · ${x.status}` : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            )}
            <div className="sm:col-span-2">
              <Field label="Root password" hint="At least 10 characters with a capital letter, a small letter and a digit. Sent to Virtualizor once, then deleted." error={password && !pwOk ? 'Too weak' : undefined}>
                {(id) => (
                  <div className="flex gap-2">
                    <Input id={id} className="font-mono" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                    <Button onClick={gen}>Generate</Button>
                  </div>
                )}
              </Field>
            </div>
          </div>
          {price !== null && (
            <div className="rounded-xl border border-rule bg-sunken/50 px-4 py-3 text-[13.5px]">
              <div className="flex justify-between">
                <span>First month</span>
                <Money p={price} />
              </div>
              <div className="flex justify-between text-ink-2">
                <span>GST</span>
                <span>{plan?.gstPaise != null && !pickCustomer && !customerId ? inr(plan.gstPaise) : 'as per the client’s state, on the invoice'}</span>
              </div>
              {balance !== null && (
                <div className="mt-1 flex justify-between border-t border-rule pt-1">
                  <span>Wallet balance</span>
                  <Money p={balance} className={plan?.totalPaise != null && balance < plan.totalPaise ? 'text-crit' : undefined} />
                </div>
              )}
            </div>
          )}
          <ErrorNote error={m.error} />
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" busy={m.isPending} disabled={(pickCustomer && !cid) || !planId || !osId || !hostOk || !pwOk} onClick={() => m.mutate()}>
              Pay from wallet and create
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ printable documents */

interface InvoiceT {
  id: string;
  number: string;
  issuedAt: string;
  supplier: { legalName: string; address: string; stateCode: string; gstin: string | null; pan: string | null; email: string | null; phone: string | null; bankDetails: string | null; notes: string | null };
  recipient: { name: string; code: string; address: string | null; stateCode: string | null; gstin: string | null; email: string | null };
  placeOfSupply: string;
  placeOfSupplyName: string;
  lines: { description: string; sac: string; quantity: number; unitPaise: number; amountPaise: number; periodFrom?: string; periodTo?: string }[];
  taxablePaise: number;
  gstRateBp: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  status: string;
}

const DOC_CSS = `
@page { size: A4 portrait; margin: 14mm; }
@media print {
  html, body { background: #fff !important; }
  body::before, body::after, #root::before, #root::after { display: none !important; }
  body * { visibility: hidden; }
  body *:not(#doc):not(#doc *) { background: transparent !important; box-shadow: none !important; backdrop-filter: none !important; }
  #doc, #doc * { visibility: visible; }
  #doc { position: absolute; left: 0; top: 0; width: 100%; box-shadow: none !important; border: 0 !important; padding: 0 !important; }
  .no-print { display: none !important; }
}
#doc { background: #fff; color: #111; font-size: 9.5pt; line-height: 1.35; }
#doc table { width: 100%; border-collapse: collapse; }
#doc th { text-align: left; background: #f1f1f4; border: .6pt solid #bbb; padding: 1.2mm 2mm; font-weight: 600; }
#doc td { border: .6pt solid #ccc; padding: 1.2mm 2mm; vertical-align: top; }
#doc .r { text-align: right; font-variant-numeric: tabular-nums; }
`;

function Doc({ title, back, children }: { title: string; back: string; children: ReactNode }) {
  return (
    <>
      <style>{DOC_CSS}</style>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link to={back} className="text-[13px] text-accent hover:underline">
          ← Billing & Wallet
        </Link>
        <Button variant="primary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
      </div>
      <article id="doc" aria-label={title} className="mx-auto max-w-[210mm] rounded-xl border border-rule p-[12mm] shadow-sm">
        {children}
      </article>
    </>
  );
}

const rupees = (p: number) => (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function InvoicePage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['billing', 'invoice', id], queryFn: () => api.get<InvoiceT>(`${B}/invoices/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const i = q.data!;
  const s = i.supplier;
  const r = i.recipient;
  const rate = i.gstRateBp / 100;
  const intra = i.igstPaise === 0 && (i.cgstPaise > 0 || i.sgstPaise > 0 || i.placeOfSupply === s.stateCode);
  return (
    <Doc title={`Invoice ${i.number}`} back="/wallet?tab=invoices">
      <header className="flex items-start justify-between gap-6 border-b-2 border-[#111] pb-3">
        <div>
          <p className="text-[15pt] font-bold">{s.legalName}</p>
          <p className="whitespace-pre-line">{s.address}</p>
          <p>
            State: {GST_STATES[s.stateCode] ?? s.stateCode} ({s.stateCode})
          </p>
          {s.gstin && (
            <p>
              GSTIN: <b className="font-mono">{s.gstin}</b>
            </p>
          )}
          {s.pan && <p>PAN: {s.pan}</p>}
          {(s.email || s.phone) && <p>{[s.email, s.phone].filter(Boolean).join(' · ')}</p>}
        </div>
        <div className="text-right">
          <p className="text-[14pt] font-bold tracking-wide">TAX INVOICE</p>
          <p>
            No. <b className="font-mono">{i.number}</b>
          </p>
          <p>Date: {formatDate(i.issuedAt)}</p>
          <p className="mt-1 text-[8.5pt] text-[#555]">Paid from prepaid wallet</p>
        </div>
      </header>
      <section className="grid grid-cols-2 gap-6 py-3">
        <div>
          <p className="text-[8.5pt] font-semibold tracking-wide text-[#555] uppercase">Billed to</p>
          <p className="font-semibold">{r.name}</p>
          {r.address && <p className="whitespace-pre-line">{r.address}</p>}
          {r.gstin ? (
            <p>
              GSTIN: <b className="font-mono">{r.gstin}</b>
            </p>
          ) : (
            <p className="text-[#555]">Unregistered recipient</p>
          )}
          <p className="text-[8.5pt] text-[#555]">Client code {r.code}</p>
        </div>
        <div className="text-right">
          <p className="text-[8.5pt] font-semibold tracking-wide text-[#555] uppercase">Place of supply</p>
          <p>
            {i.placeOfSupplyName} ({i.placeOfSupply})
          </p>
          <p className="mt-1 text-[8.5pt] text-[#555]">Reverse charge: No</p>
        </div>
      </section>
      <table>
        <thead>
          <tr>
            <th style={{ width: '6%' }}>#</th>
            <th>Description</th>
            <th style={{ width: '11%' }}>SAC</th>
            <th className="r" style={{ width: '7%' }}>
              Qty
            </th>
            <th className="r" style={{ width: '15%' }}>
              Rate (₹)
            </th>
            <th className="r" style={{ width: '15%' }}>
              Amount (₹)
            </th>
          </tr>
        </thead>
        <tbody>
          {i.lines.map((l, n) => (
            <tr key={n}>
              <td>{n + 1}</td>
              <td>
                {l.description}
                {l.periodFrom && l.periodTo && (
                  <span className="block text-[8.5pt] text-[#555]">
                    Period {formatDate(l.periodFrom)} – {formatDate(l.periodTo)}
                  </span>
                )}
              </td>
              <td className="font-mono">{l.sac}</td>
              <td className="r">{l.quantity}</td>
              <td className="r">{rupees(l.unitPaise)}</td>
              <td className="r">{rupees(l.amountPaise)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={5} className="r">
              Taxable value
            </td>
            <td className="r">{rupees(i.taxablePaise)}</td>
          </tr>
          {intra ? (
            <>
              <tr>
                <td colSpan={5} className="r">
                  CGST @ {rate / 2}%
                </td>
                <td className="r">{rupees(i.cgstPaise)}</td>
              </tr>
              <tr>
                <td colSpan={5} className="r">
                  SGST @ {rate / 2}%
                </td>
                <td className="r">{rupees(i.sgstPaise)}</td>
              </tr>
            </>
          ) : (
            <tr>
              <td colSpan={5} className="r">
                IGST @ {rate}%
              </td>
              <td className="r">{rupees(i.igstPaise)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={5} className="r font-bold">
              Total
            </td>
            <td className="r font-bold">₹{rupees(i.totalPaise)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2">
        <span className="text-[#555]">Amount in words:</span> <b>{amountInWords(i.totalPaise)}</b>
      </p>
      {s.bankDetails && (
        <section className="mt-4">
          <p className="text-[8.5pt] font-semibold tracking-wide text-[#555] uppercase">To add funds</p>
          <p className="whitespace-pre-line">{s.bankDetails}</p>
        </section>
      )}
      {s.notes && <p className="mt-3 whitespace-pre-line text-[8.5pt]">{s.notes}</p>}
      <footer className="mt-10 flex justify-between text-[8.5pt] text-[#555]">
        <span>This is a computer-generated invoice.</span>
        <span>For {s.legalName}</span>
      </footer>
    </Doc>
  );
}

interface ReceiptT {
  number: string;
  at: string;
  amountPaise: number;
  method: string | null;
  reference: string | null;
  note: string;
  balanceAfterPaise: number;
  supplier: { legalName: string; address: string; gstin: string | null; stateCode: string; email: string | null; phone: string | null } | null;
  customer: { name: string; code: string; address: string | null; gstin: string | null };
}

export function ReceiptPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['billing', 'receipt', id], queryFn: () => api.get<ReceiptT>(`${B}/receipts/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const r = q.data!;
  return (
    <Doc title={`Receipt ${r.number}`} back="/wallet">
      <header className="flex items-start justify-between gap-6 border-b-2 border-[#111] pb-3">
        <div>
          <p className="text-[15pt] font-bold">{r.supplier?.legalName ?? ''}</p>
          {r.supplier && <p className="whitespace-pre-line">{r.supplier.address}</p>}
          {r.supplier?.gstin && (
            <p>
              GSTIN: <b className="font-mono">{r.supplier.gstin}</b>
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="text-[14pt] font-bold tracking-wide">PAYMENT RECEIPT</p>
          <p>
            No. <b className="font-mono">{r.number}</b>
          </p>
          <p>Date: {formatDate(r.at)}</p>
        </div>
      </header>
      <section className="py-4">
        <p>
          Received from <b>{r.customer.name}</b> ({r.customer.code}){r.customer.gstin ? `, GSTIN ${r.customer.gstin}` : ''} the sum of <b>₹{rupees(r.amountPaise)}</b> ({amountInWords(r.amountPaise)}) by{' '}
          {r.method ? (WALLET_METHOD_LABELS[r.method as keyof typeof WALLET_METHOD_LABELS] ?? r.method) : 'payment'}
          {r.reference ? `, reference ${r.reference}` : ''}, as an advance credited to the prepaid wallet.
        </p>
        {r.note && r.note !== 'Payment received' && <p className="mt-2">Note: {r.note}</p>}
        <p className="mt-2">Wallet balance after this payment: ₹{rupees(r.balanceAfterPaise)}</p>
      </section>
      <p className="text-[8.5pt] text-[#555]">GST is charged on the tax invoice for each VPS charge paid from the wallet. This is a computer-generated receipt.</p>
    </Doc>
  );
}

/** On a client's page: wallet balance and VPS renewals at a glance, with a link to the full account. */
export function WalletSummaryPanel({ customerId }: { customerId: string }) {
  const q = useQuery({ queryKey: ['billing', 'account', customerId], queryFn: () => api.get<AccountT>(`${B}/account${qs({ customerId })}`) });
  if (!q.data) return q.error ? <ErrorNote error={q.error} /> : null;
  const a = q.data;
  const open = a.subscriptions.filter((s) => s.status !== 'cancelled');
  const late = open.filter((s) => s.status === 'overdue' || s.status === 'suspended');
  return (
    <Panel
      title="Wallet and VPS billing"
      actions={
        <Link to={`/wallet?customer=${customerId}`} className="text-[13px] text-accent hover:underline">
          Open account
        </Link>
      }
    >
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
        <Stat label="Balance" value={inr(a.balancePaise)} tone={a.balancePaise < 0 ? 'crit' : undefined} />
        <Stat label="Renewals per month" value={inr(a.monthlyPaise)} note={`${open.length} VPS${open.length === 1 ? '' : 's'}, before GST`} />
        <Stat label="Overdue or suspended" value={late.length} tone={late.length ? 'warn' : undefined} />
        <Stat label="Invoices" value={a.invoices.length} note={a.invoices[0] ? `last ${formatDate(a.invoices[0].issuedAt)}` : undefined} />
      </dl>
    </Panel>
  );
}
