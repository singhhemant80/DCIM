import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SERVICE_KIND_LABELS, type ServiceKind } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { Button, Chip, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Stat, Table } from '../components/ui';
import { SecretOnce } from './ApiIntegrations';

interface IntegrationT {
  id: string;
  name: string;
  url: string | null;
  autoCreateCustomers: boolean;
  autoCreateServices: boolean;
  enabled: boolean;
  lastEventAt: string | null;
  events30d: Record<string, number>;
}
interface MappingT {
  id: string;
  productId: string;
  kind: ServiceKind;
  label: string | null;
}
interface BillingEventT {
  id: number;
  eventId: string;
  type: string;
  status: string;
  message: string | null;
  customerId: string | null;
  serviceId: string | null;
  receivedAt: string;
}
interface ReconT {
  id: string;
  at: string;
  source: string;
  summary: { whmcsServices: number; matched: number; missingInNexoradc: number; missingInWhmcs: number; statusMismatch: number; customerMismatch: number };
  items: Record<string, string | null>[];
}
interface UsageT {
  service: { name: string; status: string };
  period: { from: string; to: string };
  energy: { devices: number; measuredKwh: number; estimatedKwh: number; unknownHours: number };
  contractedPowerW: number | null;
  bandwidth: { ports: number; samples: number; expectedSamples: number; inP95Bps: number | null; outP95Bps: number | null; billableP95Bps: number | null; coverage: number | null };
}

const KINDS: ServiceKind[] = ['colocation', 'dedicated_server', 'vps', 'ip_transit', 'cross_connect', 'remote_hands', 'other'];
const STATUS_TONE: Record<string, 'ok' | 'neutral' | 'crit' | 'warn'> = { applied: 'ok', ignored: 'neutral', rejected: 'crit', review: 'warn' };
const mbps = (v: number | null) => (v === null ? '—' : `${(v / 1e6).toFixed(2)} Mbit/s`);
const KIND_LABEL: Record<string, string> = { missing_in_nexoradc: 'Only in WHMCS', missing_in_whmcs: 'Only in NexoraDC', status_mismatch: 'Status differs', customer_mismatch: 'Customer differs' };

function IntegrationDialog({ current, onClose, onSecret }: { current: IntegrationT | null; onClose: () => void; onSecret: (s: string, id: string) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: current?.name ?? 'WHMCS', url: current?.url ?? '', autoCreateCustomers: current?.autoCreateCustomers ?? true, autoCreateServices: current?.autoCreateServices ?? true, enabled: current?.enabled ?? true });
  const m = useMutation({
    mutationFn: () => {
      const body = { ...f, url: f.url || null };
      return current ? api.put<IntegrationT>(`/billing/integrations/${current.id}`, body) : api.post<IntegrationT & { webhookSecret: string }>('/billing/integrations', body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      onClose();
      if ('webhookSecret' in r) onSecret((r as { webhookSecret: string }).webhookSecret, r.id);
    },
  });
  const check = (k: 'autoCreateCustomers' | 'autoCreateServices' | 'enabled', label: string) => (
    <label className="flex items-center gap-2 text-[13px]">
      <input type="checkbox" checked={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.checked }))} /> {label}
    </label>
  );
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={current ? `Edit ${current.name}` : 'Connect WHMCS'} description="Billing events update customer and service records only. A suspended or terminated service never switches equipment off." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} required />}</Field>
          <Field label="WHMCS address (optional)">{(id) => <Input id={id} value={f.url} onChange={(e) => setF((x) => ({ ...x, url: e.target.value }))} placeholder="https://billing.example.com" />}</Field>
        </div>
        {check('autoCreateCustomers', 'Create customers for new WHMCS clients (code WHMCS-<client id>)')}
        {check('autoCreateServices', 'Create services for new WHMCS services (kind from the product mapping)')}
        {check('enabled', 'Accept events')}
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Mappings({ i }: { i: IntegrationT }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['billing', i.id, 'mappings'], queryFn: () => api.get<MappingT[]>(`/billing/integrations/${i.id}/mappings`) });
  const [f, setF] = useState({ productId: '', kind: 'colocation', label: '' });
  const put = useMutation({
    mutationFn: () => api.put(`/billing/integrations/${i.id}/mappings`, { ...f, label: f.label || null }),
    onSuccess: () => {
      setF({ productId: '', kind: 'colocation', label: '' });
      void qc.invalidateQueries({ queryKey: ['billing', i.id, 'mappings'] });
    },
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/billing/integrations/${i.id}/mappings/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['billing', i.id, 'mappings'] }) });
  return (
    <Panel title="Product mapping" flush>
      <p className="px-4 pt-3 text-[13px] text-ink-2">Which kind of service a WHMCS product becomes. Unmapped products create services of kind “Other”.</p>
      {q.isLoading && <Loading />}
      {!!q.data?.length && (
        <Table label="Product mappings">
          <thead>
            <tr>
              <th>WHMCS product id</th>
              <th>Service kind</th>
              <th>Label</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((m) => (
              <tr key={m.id}>
                <td className="font-mono">{m.productId}</td>
                <td>{SERVICE_KIND_LABELS[m.kind]}</td>
                <td>{m.label ?? '—'}</td>
                <td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => del.mutate(m.id)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        className="flex flex-wrap items-end gap-2 border-t border-rule p-4"
        onSubmit={(e) => {
          e.preventDefault();
          put.mutate();
        }}
      >
        <Field label="Product id">{(id) => <Input id={id} className="w-28" value={f.productId} onChange={(e) => setF((x) => ({ ...x, productId: e.target.value }))} required />}</Field>
        <Field label="Kind">
          {(id) => (
            <Select id={id} value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {SERVICE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Label">{(id) => <Input id={id} value={f.label} onChange={(e) => setF((x) => ({ ...x, label: e.target.value }))} />}</Field>
        <Button type="submit" variant="secondary" busy={put.isPending}>
          Save mapping
        </Button>
        <ErrorNote error={put.error ?? del.error} />
      </form>
    </Panel>
  );
}

function Events({ i }: { i: IntegrationT }) {
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['billing', i.id, 'events', status], queryFn: () => api.get<BillingEventT[]>(`/billing/integrations/${i.id}/events${qs({ status: status || undefined })}`), refetchInterval: 15_000 });
  return (
    <Panel
      title="Received events"
      flush
      actions={
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-40">
          <option value="">All</option>
          <option value="applied">Applied</option>
          <option value="ignored">No change</option>
          <option value="review">Needs review</option>
          <option value="rejected">Rejected</option>
        </Select>
      }
    >
      <p className="px-4 pt-3 text-[13px] text-ink-2">Each event id is applied once; repeats are answered as duplicates and change nothing.</p>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} className="m-4" />
      {q.data && !q.data.length && <EmptyState title="No events yet" />}
      {!!q.data?.length && (
        <Table label="Billing events">
          <thead>
            <tr>
              <th>Received</th>
              <th>Event</th>
              <th>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap">{formatDateTime(e.receivedAt)}</td>
                <td>
                  <div className="font-mono text-[12.5px]">{e.type}</div>
                  <div className="font-mono text-[11.5px] text-ink-3">{e.eventId}</div>
                </td>
                <td>
                  <Chip tone={STATUS_TONE[e.status] ?? 'neutral'}>{e.status}</Chip>
                </td>
                <td className="max-w-[48ch] text-[12.5px] text-ink-2">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function Reconciliation({ i }: { i: IntegrationT }) {
  const q = useQuery({ queryKey: ['billing', i.id, 'recon'], queryFn: () => api.get<ReconT[]>(`/billing/integrations/${i.id}/reconciliations`) });
  const [open, setOpen] = useState<ReconT | null>(null);
  return (
    <Panel title="Reconciliation" flush>
      <p className="px-4 pt-3 text-[13px] text-ink-2">The WHMCS module sends a snapshot of its services daily. Differences are reported here; nothing is changed automatically.</p>
      {q.isLoading && <Loading />}
      {q.data && !q.data.length && <EmptyState title="No reconciliation yet">It runs with the WHMCS daily cron.</EmptyState>}
      {!!q.data?.length && (
        <Table label="Reconciliations">
          <thead>
            <tr>
              <th>When</th>
              <th>Source</th>
              <th>Matched</th>
              <th>Differences</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => {
              const diff = r.summary.missingInNexoradc + r.summary.missingInWhmcs + r.summary.statusMismatch + r.summary.customerMismatch;
              return (
                <tr key={r.id} className="cursor-pointer hover:bg-sunken" onClick={() => setOpen(r)}>
                  <td>{formatDateTime(r.at)}</td>
                  <td>{r.source}</td>
                  <td>
                    {r.summary.matched} of {r.summary.whmcsServices}
                  </td>
                  <td>{diff ? <Chip tone="warn">{diff} to check</Chip> : <Chip tone="ok">None</Chip>}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {open && (
        <Modal open onOpenChange={(o) => !o && setOpen(null)} title={`Reconciliation ${formatDateTime(open.at)}`} wide>
          {!open.items.length ? (
            <p>Everything matches.</p>
          ) : (
            <div className="-mx-5">
              <Table label="Differences">
                <thead>
                  <tr>
                    <th>Difference</th>
                    <th>Service</th>
                    <th>WHMCS</th>
                    <th>NexoraDC</th>
                  </tr>
                </thead>
                <tbody>
                  {open.items.map((x, n) => (
                    <tr key={n}>
                      <td>
                        <Chip tone="warn">{KIND_LABEL[String(x.kind)] ?? x.kind}</Chip>
                      </td>
                      <td className="text-[12.5px]">
                        <span className="font-mono">{x.serviceId}</span> {x.name}
                      </td>
                      <td className="text-[12.5px]">
                        {x.whmcsStatus ?? '—'}
                        {x.whmcsClientId ? ` · client ${x.whmcsClientId}` : x.clientId ? ` · client ${x.clientId}` : ''}
                      </td>
                      <td className="text-[12.5px]">
                        {x.nexoradcStatus ?? '—'}
                        {x.customerName ? ` · ${x.customerName}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
        </Modal>
      )}
    </Panel>
  );
}

function UsageLookup() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [f, setF] = useState({ ref: '', from: first.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) });
  const m = useMutation({ mutationFn: () => api.get<UsageT>(`/billing/usage${qs({ billingReference: f.ref, from: new Date(`${f.from}T00:00:00Z`).toISOString(), to: new Date(`${f.to}T23:59:59Z`).toISOString() })}`) });
  const u = m.data;
  return (
    <Panel title="Usage for billing">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Billing reference">{(id) => <Input id={id} value={f.ref} onChange={(e) => setF((x) => ({ ...x, ref: e.target.value }))} placeholder="WHMCS service id" required />}</Field>
        <Field label="From (UTC)">{(id) => <Input id={id} type="date" value={f.from} onChange={(e) => setF((x) => ({ ...x, from: e.target.value }))} />}</Field>
        <Field label="To (UTC)">{(id) => <Input id={id} type="date" value={f.to} onChange={(e) => setF((x) => ({ ...x, to: e.target.value }))} />}</Field>
        <Button type="submit" variant="secondary" busy={m.isPending}>
          Look up
        </Button>
      </form>
      <ErrorNote error={m.error} className="mt-3" />
      {u && (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat label="Measured energy" value={`${u.energy.measuredKwh.toFixed(3)} kWh`} note={`${u.energy.devices} device(s)`} />
          <Stat label="Estimated energy" value={`${u.energy.estimatedKwh.toFixed(3)} kWh`} tone="est" note={u.energy.unknownHours ? `${u.energy.unknownHours} device-hours without data` : 'Not metered'} />
          <Stat label="Bandwidth 95th" value={mbps(u.bandwidth.billableP95Bps)} note={`in ${mbps(u.bandwidth.inP95Bps)} · out ${mbps(u.bandwidth.outP95Bps)}`} />
          <Stat label="Sample coverage" value={u.bandwidth.coverage === null ? '—' : `${u.bandwidth.coverage}%`} tone={u.bandwidth.coverage !== null && u.bandwidth.coverage < 95 ? 'warn' : undefined} note={`${u.bandwidth.ports} port(s), customer-wide`} />
        </dl>
      )}
    </Panel>
  );
}

export function BillingPage() {
  const q = useQuery({ queryKey: ['billing', 'integrations'], queryFn: () => api.get<IntegrationT[]>('/billing/integrations'), refetchInterval: 30_000 });
  const qc = useQueryClient();
  const [sel, setSel] = useState<string | null>(null);
  const [edit, setEdit] = useState<IntegrationT | 'new' | null>(null);
  const [secret, setSecret] = useState<{ value: string; id: string } | null>(null);
  const rotate = useMutation({ mutationFn: (id: string) => api.post<{ webhookSecret: string }>(`/billing/integrations/${id}/rotate-secret`), onSuccess: (r, id) => setSecret({ value: r.webhookSecret, id }) });
  const list = q.data ?? [];
  const cur = list.find((i) => i.id === sel) ?? list[0];
  return (
    <>
      <PageHeader
        title="Billing integrations"
        description="WHMCS keeps customers and services in step through signed, idempotent events. Billing changes are records only: nothing here powers equipment off or changes the network."
        actions={
          <Button variant="primary" onClick={() => setEdit('new')}>
            Connect WHMCS
          </Button>
        }
      />
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error ?? rotate.error} />
      {q.data && !list.length && (
        <Panel>
          <EmptyState title="No billing system connected">Install the NexoraDC module in WHMCS (integrations/whmcs in the repository), then connect it here.</EmptyState>
        </Panel>
      )}
      {cur && (
        <div className="flex flex-col gap-4">
          {list.length > 1 && (
            <Select aria-label="Integration" value={cur.id} onChange={(e) => setSel(e.target.value)} className="w-64">
              {list.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          )}
          <Panel
            title={
              <span>
                {cur.name} {cur.enabled ? <Chip tone="ok">accepting events</Chip> : <Chip>disabled</Chip>}
              </span>
            }
            actions={
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEdit(cur)}>
                  Settings
                </Button>
                <Button size="sm" variant="ghost" busy={rotate.isPending} onClick={() => rotate.mutate(cur.id)}>
                  New secret
                </Button>
              </div>
            }
          >
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
              <Stat label="Last event" value={cur.lastEventAt ? relativeTime(cur.lastEventAt) : 'None'} />
              <Stat label="Applied (30d)" value={cur.events30d.applied ?? 0} tone="ok" />
              <Stat label="No change (30d)" value={cur.events30d.ignored ?? 0} />
              <Stat label="Needs review" value={cur.events30d.review ?? 0} tone={cur.events30d.review ? 'warn' : undefined} />
              <Stat label="Rejected" value={cur.events30d.rejected ?? 0} tone={cur.events30d.rejected ? 'crit' : undefined} />
            </dl>
            <div className="mt-4 rounded-xl bg-sunken p-3 text-[13px]">
              <div className="mb-1 font-medium">WHMCS server settings</div>
              <div>
                Module <b>NexoraDC</b> · Hostname <code>{location.host}</code> · Username (integration id) <code className="select-all">{cur.id}</code> · Password: the shared secret
              </div>
            </div>
          </Panel>
          <div className="grid gap-4 xl:grid-cols-2">
            <Mappings i={cur} />
            <Reconciliation i={cur} />
          </div>
          <Events i={cur} />
          <UsageLookup />
        </div>
      )}
      {edit && <IntegrationDialog current={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSecret={(value, id) => (setSecret({ value, id }), setSel(id))} />}
      {secret && (
        <SecretOnce title="WHMCS shared secret" label="Secret (WHMCS server password)" value={secret.value} onClose={() => (setSecret(null), void qc.invalidateQueries({ queryKey: ['billing'] }))}>
          <p className="text-[13px] text-ink-2">
            In WHMCS, add a server with module <b>NexoraDC</b>, hostname <code>{location.host}</code>, username <code>{secret.id}</code> and this secret as the password. A new secret replaces the old one immediately.
          </p>
        </SecretOnce>
      )}
    </>
  );
}
