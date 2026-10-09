import { useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { Customer } from '../lib/types';
import { Button, Chip, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Table, Textarea } from '../components/ui';

const STATUS_TONE = { active: 'ok', suspended: 'warn', closed: 'neutral' } as const;
const STATUS_LABEL = { active: 'Active', suspended: 'Suspended', closed: 'Closed' } as const;

type FormState = { name: string; code: string; contactEmail: string; phone: string; billingReference: string; notes: string; status: Customer['status'] };

function toForm(c?: Customer): FormState {
  return {
    name: c?.name ?? '',
    code: c?.code ?? '',
    contactEmail: c?.contactEmail ?? '',
    phone: c?.phone ?? '',
    billingReference: c?.billingReference ?? '',
    notes: c?.notes ?? '',
    status: c?.status ?? 'active',
  };
}

function CustomerForm({ customer, onClose }: { customer?: Customer; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(toForm(customer));
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        code: f.code,
        contactEmail: f.contactEmail || null,
        phone: f.phone || null,
        billingReference: f.billingReference || null,
        notes: f.notes || null,
        status: f.status,
      };
      return customer ? api.patch<Customer>(`/customers/${customer.id}`, body) : api.post<Customer>('/customers', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['customers'] });
      onClose();
    },
  });
  const closing = customer && customer.status !== 'closed' && f.status === 'closed';
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} autoFocus />}</Field>
      <Field label="Account code" hint="Short unique code, e.g. ACME-01. Letters, digits and dashes.">
        {(id, d) => <Input id={id} aria-describedby={d} required value={f.code} onChange={set('code')} className="font-mono uppercase" />}
      </Field>
      <Field label="Contact email">{(id) => <Input id={id} type="email" value={f.contactEmail} onChange={set('contactEmail')} />}</Field>
      <Field label="Phone">{(id) => <Input id={id} type="tel" value={f.phone} onChange={set('phone')} />}</Field>
      <Field label="Billing reference" hint="For example, the WHMCS client ID. Staff only.">
        {(id, d) => <Input id={id} aria-describedby={d} value={f.billingReference} onChange={set('billingReference')} />}
      </Field>
      <Field label="Status">
        {(id) => (
          <Select id={id} value={f.status} onChange={set('status')}>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="closed">Closed</option>
          </Select>
        )}
      </Field>
      <div className="sm:col-span-2">
        <Field label="Internal notes" hint="Visible to staff only, never to the customer.">
          {(id, d) => <Textarea id={id} aria-describedby={d} value={f.notes} onChange={set('notes')} />}
        </Field>
      </div>
      {closing && <p className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn sm:col-span-2">Closing the account signs out all of its portal users and blocks them from signing in.</p>}
      <ErrorNote error={m.error} className="sm:col-span-2" />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          {customer ? 'Save changes' : 'Add customer'}
        </Button>
      </div>
    </form>
  );
}

export function CustomersPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const [search, setSearch] = useState(q);
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);

  const list = useQuery({
    queryKey: ['customers', { page, q, status }],
    queryFn: () => api.get<Paginated<Customer>>(`/customers${qs({ page, pageSize: 25, q, status })}`),
    placeholderData: keepPreviousData,
  });

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Customers and tenants"
        description="Each customer is a tenant. Its portal users only ever see resources assigned to it."
        actions={can('customers.write') && <Button variant="primary" onClick={() => setEditing('new')}>Add customer</Button>}
      />
      <Panel flush>
        <form
          className="flex flex-wrap gap-2 border-b border-rule p-3"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim(), page: '' });
          }}
          role="search"
        >
          <label className="sr-only" htmlFor="customer-search">Search customers</label>
          <Input id="customer-search" placeholder="Search name, code or email" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <label className="sr-only" htmlFor="customer-status">Status</label>
          <Select id="customer-status" value={status} onChange={(e) => update({ status: e.target.value, page: '' })} className="w-40">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="closed">Closed</option>
          </Select>
          <Button type="submit">Search</Button>
        </form>
        {list.isLoading && <Loading />}
        <ErrorNote error={list.error} className="m-4" />
        {list.data && list.data.items.length === 0 && (
          <EmptyState title={q || status ? 'No customers match' : 'No customers yet'} action={!q && !status && can('customers.write') ? <Button variant="primary" onClick={() => setEditing('new')}>Add customer</Button> : undefined}>
            {q || status ? 'Try a different search or clear the status filter.' : 'Add your first customer to start assigning servers, IPs and colocation space to them.'}
          </EmptyState>
        )}
        {list.data && list.data.items.length > 0 && (
          <>
            <Table label="Customers">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Code</th>
                  <th>Contact</th>
                  <th>Portal users</th>
                  <th>Status</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((c) => (
                  <tr key={c.id} className="hover:bg-sunken/50">
                    <td>
                      {can('customers.write') ? (
                        <button className="text-left font-medium text-accent hover:underline" onClick={() => setEditing(c)}>
                          {c.name}
                        </button>
                      ) : (
                        <span className="font-medium">{c.name}</span>
                      )}
                    </td>
                    <td className="font-mono text-[13px]">{c.code}</td>
                    <td className="text-ink-2">{c.contactEmail ?? '—'}</td>
                    <td>
                      {can('users.read') && c.userCount ? (
                        <Link className="text-accent hover:underline" to={`/users?customerId=${c.id}`}>
                          {c.userCount}
                        </Link>
                      ) : (
                        c.userCount ?? 0
                      )}
                    </td>
                    <td>
                      <Chip tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Chip>
                    </td>
                    <td className="text-ink-2">{formatDateTime(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => update({ page: String(p) })} />
          </>
        )}
      </Panel>
      <Modal wide open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add customer' : `Edit ${editing?.name ?? ''}`}>
        {editing !== null && <CustomerForm customer={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </Modal>
    </>
  );
}
