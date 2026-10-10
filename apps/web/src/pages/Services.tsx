import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SERVICE_KINDS, SERVICE_KIND_LABELS, SERVICE_STATUSES, SERVICE_STATUS_LABELS, SERVICE_TRANSITIONS, type ServiceKind, type ServiceStatus } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { useCustomerDevices, useCustomerOptions, watts, type ServiceT } from '../lib/colocation';
import { Button, Chip, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Table, Textarea } from '../components/ui';

const TONE: Record<ServiceStatus, 'ok' | 'warn' | 'neutral' | 'accent' | 'crit'> = { pending: 'accent', active: 'ok', suspended: 'warn', cancelled: 'neutral', terminated: 'neutral' };
const kindLabel = (k: string) => SERVICE_KIND_LABELS[k as ServiceKind] ?? k;

function ServiceDialog({ current, onClose }: { current: ServiceT | null; onClose: () => void }) {
  const qc = useQueryClient();
  const customers = useCustomerOptions();
  const [f, setF] = useState({
    customerId: current?.customerId ?? '',
    kind: current?.kind ?? 'colocation',
    name: current?.name ?? '',
    description: current?.description ?? '',
    startDate: current?.startDate ?? '',
    endDate: current?.endDate ?? '',
    billingReference: current?.billingReference ?? '',
    deviceId: current?.deviceId ?? '',
    notes: current?.notes ?? '',
  });
  const devs = useCustomerDevices(f.customerId);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => {
      const body = {
        customerId: f.customerId,
        kind: f.kind,
        name: f.name,
        description: f.description || null,
        startDate: f.startDate || null,
        endDate: f.endDate || null,
        billingReference: f.billingReference || null,
        deviceId: f.deviceId || null,
        guestId: current?.guestId ?? null,
        notes: f.notes || null,
      };
      return current ? api.put(`/services/${current.id}`, body) : api.post('/services', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['services'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={current ? `Edit ${current.name}` : 'New service'} wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer">
            {(id) => (
              <Select id={id} value={f.customerId} onChange={set('customerId')} disabled={!!current} required>
                <option value="">Choose…</option>
                {customers.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Kind">
            {(id) => (
              <Select id={id} value={f.kind} onChange={set('kind')}>
                {SERVICE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SERVICE_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={set('name')} placeholder="Half rack MUM1-A01" required />}</Field>
        <Field label="Description (shown to the customer)">{(id) => <Textarea id={id} rows={2} value={f.description} onChange={set('description')} />}</Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Starts">{(id) => <Input id={id} type="date" value={f.startDate} onChange={set('startDate')} />}</Field>
          <Field label="Ends">{(id) => <Input id={id} type="date" value={f.endDate} onChange={set('endDate')} />}</Field>
          <Field label="Billing reference">{(id) => <Input id={id} value={f.billingReference} onChange={set('billingReference')} placeholder="WHMCS-4411" />}</Field>
          <Field label="Server">
            {(id) => (
              <Select id={id} value={f.deviceId} onChange={set('deviceId')}>
                <option value="">None</option>
                {devs.data?.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hostname ?? d.assetTag}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Notes (staff only)">{(id) => <Textarea id={id} rows={2} value={f.notes} onChange={set('notes')} />}</Field>
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

interface DetailT extends ServiceT {
  events: { id: number; at: string; actorLabel: string | null; fromStatus: string | null; toStatus: string | null; summary: string }[];
  allocations: { id: string; kind: string; start_u: number; end_u: number; contracted_power_w: number; ended_at: string | null; rack_name: string }[];
  crossConnects: { id: string; a_label: string; z_label: string; status: string; circuit_id: string | null }[];
}

function ServiceDetail({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (s: ServiceT) => void }) {
  const { me, can } = useAuth();
  const manage = me?.user.userType === 'staff' && can('services.write');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['services', 'detail', id], queryFn: () => api.get<DetailT>(`/services/${id}`) });
  const [reason, setReason] = useState('');
  const status = useMutation({
    mutationFn: (to: ServiceStatus) => api.post(`/services/${id}/status`, { status: to, reason: reason || null }),
    onSuccess: () => {
      setReason('');
      void qc.invalidateQueries({ queryKey: ['services'] });
    },
  });
  const s = q.data;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={s ? s.name : 'Service'} wide>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {s && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
            <Chip tone={TONE[s.status]}>{SERVICE_STATUS_LABELS[s.status]}</Chip>
            <span>{kindLabel(s.kind)}</span>
            <span>· {s.customerName}</span>
            {s.billingReference && <span>· {s.billingReference}</span>}
            {s.startDate && <span>· from {s.startDate}</span>}
            {s.endDate && <span>to {s.endDate}</span>}
          </div>
          {s.description && <p className="text-ink-2">{s.description}</p>}
          {s.notes && <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-2">Staff note: {s.notes}</p>}
          {(s.allocations.length > 0 || s.crossConnects.length > 0 || s.deviceName || s.guestName) && (
            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-ink-2">Delivered as</h3>
              <ul className="text-[13px]">
                {s.deviceName && <li>Server {s.deviceName}</li>}
                {s.guestName && <li>VM {s.guestName}</li>}
                {s.allocations.map((a) => (
                  <li key={a.id}>
                    Rack {a.rack_name} U{a.start_u}–U{a.end_u}, {watts(a.contracted_power_w)} contracted{a.ended_at ? ' (ended)' : ''}
                  </li>
                ))}
                {s.crossConnects.map((x) => (
                  <li key={x.id}>
                    Cross-connect {x.a_label} ↔ {x.z_label} ({x.status}
                    {x.circuit_id ? `, ${x.circuit_id}` : ''})
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3 className="mb-1 text-[13px] font-semibold text-ink-2">History</h3>
            <ol className="flex flex-col gap-1 text-[13px]">
              {s.events.map((e) => (
                <li key={e.id}>
                  <span className="text-ink-3">{formatDateTime(e.at)}</span> {e.summary}
                  {e.actorLabel && <span className="text-ink-3"> · {e.actorLabel}</span>}
                </li>
              ))}
            </ol>
          </section>
          {manage && SERVICE_TRANSITIONS[s.status].length > 0 && (
            <section className="border-t border-rule pt-3">
              <p className="mb-2 text-[12.5px] text-ink-3">Changing the status is a record only: nothing is switched off or reconfigured.</p>
              <Field label="Reason (recorded)">{(fid) => <Input id={fid} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
              <div className="mt-2 flex flex-wrap gap-2">
                {SERVICE_TRANSITIONS[s.status].map((to) => (
                  <Button key={to} size="sm" variant={to === 'terminated' || to === 'cancelled' ? 'danger' : 'secondary'} busy={status.isPending && status.variables === to} onClick={() => status.mutate(to)}>
                    {to === 'active' ? (s.status === 'suspended' ? 'Reactivate' : 'Activate') : to === 'suspended' ? 'Suspend' : to === 'terminated' ? 'Terminate' : 'Cancel order'}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onEdit(s)}>
                  Edit
                </Button>
              </div>
              <ErrorNote error={status.error} className="mt-2" />
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

export function ServicesPage() {
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  const manage = staff && can('services.write');
  const customers = useCustomerOptions();
  const [f, setF] = useState({ q: '', status: '', kind: '', customerId: '' });
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['services', 'list', f, page],
    queryFn: () => api.get<Paginated<ServiceT>>(`/services${qs({ ...f, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<ServiceT | 'new' | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => (setF((x) => ({ ...x, [k]: e.target.value })), setPage(1));
  return (
    <>
      <PageHeader
        title="Orders & services"
        description={staff ? 'What each customer has, its lifecycle and billing reference. Status changes are records; they never switch equipment off.' : 'Your services and their status.'}
        actions={
          manage && (
            <Button variant="primary" onClick={() => setEdit('new')}>
              New service
            </Button>
          )
        }
      />
      <Panel
        flush
        actions={
          <div className="flex flex-wrap gap-2">
            <Input className="w-48" aria-label="Search" placeholder="Name or billing ref" value={f.q} onChange={set('q')} />
            {staff && (
              <Select className="w-44" aria-label="Customer" value={f.customerId} onChange={set('customerId')}>
                <option value="">All customers</option>
                {customers.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
            <Select className="w-36" aria-label="Kind" value={f.kind} onChange={set('kind')}>
              <option value="">Every kind</option>
              {SERVICE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {SERVICE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
            <Select className="w-32" aria-label="Status" value={f.status} onChange={set('status')}>
              <option value="">Any status</option>
              {SERVICE_STATUSES.map((k) => (
                <option key={k} value={k}>
                  {SERVICE_STATUS_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>
        }
        title="Services"
      >
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorNote error={q.error} className="m-4" />
        ) : !q.data!.items.length ? (
          <EmptyState title="No services">{staff ? 'Create a service for each thing a customer has ordered; link rack space, servers and cross-connects to it.' : 'Services on your account appear here.'}</EmptyState>
        ) : (
          <>
            <Table label="Services">
              <thead>
                <tr>
                  <th>Service</th>
                  {staff && <th>Customer</th>}
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Term</th>
                  <th>Billing ref</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.items.map((s) => (
                  <tr key={s.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => setOpen(s.id)}>
                    <td className="font-medium">{s.name}</td>
                    {staff && <td>{s.customerName}</td>}
                    <td className="text-[13px]">{kindLabel(s.kind)}</td>
                    <td>
                      <Chip tone={TONE[s.status]}>{SERVICE_STATUS_LABELS[s.status]}</Chip>
                    </td>
                    <td className="text-[13px]">
                      {s.startDate ?? '—'}
                      {s.endDate ? ` → ${s.endDate}` : ''}
                    </td>
                    <td className="font-mono text-[12.5px]">{s.billingReference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={q.data!.page} pageSize={q.data!.pageSize} total={q.data!.total} onPage={setPage} />
          </>
        )}
      </Panel>
      {open && (
        <ServiceDetail
          id={open}
          onClose={() => setOpen(null)}
          onEdit={(s) => {
            setOpen(null);
            setEdit(s);
          }}
        />
      )}
      {edit && <ServiceDialog current={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}
