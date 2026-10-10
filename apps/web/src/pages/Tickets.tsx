import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { TICKET_KINDS, TICKET_KIND_LABELS, TICKET_PRIORITIES, TICKET_STATUSES, TICKET_STATUS_LABELS, type TicketKind, type TicketStatus } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { useCustomerDevices, useCustomerOptions, type TicketDetailT, type TicketT } from '../lib/colocation';
import { Button, Chip, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Table, Textarea, cx } from '../components/ui';

const STATUS_TONE: Record<TicketStatus, 'ok' | 'warn' | 'neutral' | 'accent'> = { open: 'accent', in_progress: 'accent', waiting_customer: 'warn', resolved: 'ok', closed: 'neutral' };
const PRIORITY_TONE = { low: 'neutral', normal: 'neutral', high: 'warn', urgent: 'crit' } as const;
const kindLabel = (k: string) => TICKET_KIND_LABELS[k as TicketKind] ?? k;

function NewTicket({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const customers = useCustomerOptions();
  const [f, setF] = useState({ customerId: '', kind: 'remote_hands' as TicketKind, priority: 'normal', subject: '', body: '', deviceId: '', authorizedMinutes: '30' });
  const devs = useCustomerDevices(f.customerId);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () =>
      api.post<TicketT>('/tickets', {
        customerId: staff ? f.customerId || null : undefined,
        kind: f.kind,
        priority: f.priority,
        subject: f.subject,
        body: f.body,
        deviceId: f.deviceId || null,
        authorizedMinutes: f.kind === 'remote_hands' && f.authorizedMinutes ? Number(f.authorizedMinutes) : null,
      }),
    onSuccess: (t) => onCreated(t.id),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={staff ? 'New ticket' : 'Open a ticket'} wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {staff && (
            <Field label="Customer" hint="Leave empty for an internal ticket">
              {(id) => (
                <Select id={id} value={f.customerId} onChange={set('customerId')}>
                  <option value="">Internal</option>
                  {customers.data?.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Type">
            {(id) => (
              <Select id={id} value={f.kind} onChange={set('kind')}>
                {TICKET_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TICKET_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Priority">
            {(id) => (
              <Select id={id} value={f.priority} onChange={set('priority')}>
                {TICKET_PRIORITIES.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Subject">{(id) => <Input id={id} value={f.subject} onChange={set('subject')} required />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Equipment">
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
          {f.kind === 'remote_hands' && (
            <Field label="Authorized time (minutes)" hint="Billable remote-hands work you approve in advance">
              {(id) => <Input id={id} inputMode="numeric" value={f.authorizedMinutes} onChange={(e) => setF((x) => ({ ...x, authorizedMinutes: e.target.value.replace(/\D/g, '') }))} />}
            </Field>
          )}
        </div>
        <Field label="Details">{(id) => <Textarea id={id} rows={6} value={f.body} onChange={set('body')} required placeholder={f.kind === 'remote_hands' ? 'What should the technician do, step by step? Which rack, unit and port?' : undefined} />}</Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending}>
            Open ticket
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function TicketsPage() {
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  const navigate = useNavigate();
  const customers = useCustomerOptions();
  const [f, setF] = useState({ status: 'open', kind: '', customerId: '', q: '', mine: '' });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['tickets', 'list', f, page],
    queryFn: () => api.get<Paginated<TicketT>>(`/tickets${qs({ ...f, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => (setF((x) => ({ ...x, [k]: e.target.value })), setPage(1));
  return (
    <>
      <PageHeader
        title="Remote hands & tickets"
        description={staff ? 'Support requests and remote-hands work for customers, plus internal tasks. Internal notes are never shown to customers.' : 'Ask the datacenter team for help or hands-on work on your equipment.'}
        actions={
          can('tickets.write') && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {staff ? 'New ticket' : 'Open a ticket'}
            </Button>
          )
        }
      />
      <Panel
        flush
        title="Tickets"
        actions={
          <div className="flex flex-wrap gap-2">
            <Input className="w-40" aria-label="Search" placeholder="Subject or #number" value={f.q} onChange={set('q')} />
            {staff && (
              <Select className="w-40" aria-label="Customer" value={f.customerId} onChange={set('customerId')}>
                <option value="">All customers</option>
                {customers.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
            <Select className="w-36" aria-label="Type" value={f.kind} onChange={set('kind')}>
              <option value="">Every type</option>
              {TICKET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {TICKET_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
            <Select className="w-36" aria-label="Status" value={f.status} onChange={set('status')}>
              <option value="open">Open</option>
              <option value="all">All</option>
              {TICKET_STATUSES.map((k) => (
                <option key={k} value={k}>
                  {TICKET_STATUS_LABELS[k]}
                </option>
              ))}
            </Select>
            {staff && (
              <Select className="w-32" aria-label="Assigned" value={f.mine} onChange={set('mine')}>
                <option value="">Anyone</option>
                <option value="true">Assigned to me</option>
              </Select>
            )}
          </div>
        }
      >
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorNote error={q.error} className="m-4" />
        ) : !q.data!.items.length ? (
          <EmptyState title={f.status === 'open' ? 'No open tickets' : 'No tickets'} />
        ) : (
          <>
            <Table label="Tickets">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Subject</th>
                  {staff && <th>Customer</th>}
                  <th>Status</th>
                  <th>Priority</th>
                  {staff && <th>Assignee</th>}
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {q.data!.items.map((t) => (
                  <tr key={t.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => navigate(`/tickets/${t.id}`)}>
                    <td className="font-mono text-[12.5px]">{t.number}</td>
                    <td>
                      <div className="font-medium">{t.subject}</div>
                      <div className="text-[12.5px] text-ink-3">
                        {kindLabel(t.kind)}
                        {t.deviceName ? ` · ${t.deviceName}` : ''}
                        {t.kind === 'remote_hands' && ` · ${t.minutesSpent} min${t.authorizedMinutes != null ? ` of ${t.authorizedMinutes}` : ''}`}
                      </div>
                    </td>
                    {staff && <td>{t.customerName ?? <span className="text-ink-3">Internal</span>}</td>}
                    <td>
                      <Chip tone={STATUS_TONE[t.status]}>{TICKET_STATUS_LABELS[t.status]}</Chip>
                      {staff && t.lastPublicReplyBy === 'customer' && t.status !== 'closed' && t.status !== 'resolved' && <div className="mt-1 text-[12px] text-accent">Customer replied</div>}
                    </td>
                    <td>
                      <Chip tone={PRIORITY_TONE[t.priority]}>{t.priority}</Chip>
                    </td>
                    {staff && <td className="text-[13px]">{t.assigneeName ?? <span className="text-ink-3">—</span>}</td>}
                    <td className="text-[13px] text-ink-2">{relativeTime(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={q.data!.page} pageSize={q.data!.pageSize} total={q.data!.total} onPage={setPage} />
          </>
        )}
      </Panel>
      {creating && <NewTicket onClose={() => setCreating(false)} onCreated={(id) => navigate(`/tickets/${id}`)} />}
    </>
  );
}

function StaffControls({ t }: { t: TicketDetailT }) {
  const qc = useQueryClient();
  const assignees = useQuery({ queryKey: ['tickets', 'assignees'], queryFn: () => api.get<{ id: string; name: string; email: string }[]>('/tickets/assignees') });
  const update = useMutation({ mutationFn: (b: object) => api.patch(`/tickets/${t.id}`, b), onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }) });
  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');
  const [billable, setBillable] = useState(true);
  const time = useMutation({
    mutationFn: () => api.post<{ totalBillableMinutes: number; overAuthorized: boolean }>(`/tickets/${t.id}/time`, { minutes: Number(minutes), note, billable }),
    onSuccess: () => {
      setMinutes('');
      setNote('');
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
  return (
    <Panel title="Handling">
      <div className="flex flex-col gap-3">
        <Field label="Status">
          {(id) => (
            <Select id={id} value={t.status} onChange={(e) => update.mutate({ status: e.target.value })}>
              {TICKET_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TICKET_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Priority">
          {(id) => (
            <Select id={id} value={t.priority} onChange={(e) => update.mutate({ priority: e.target.value })}>
              {TICKET_PRIORITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Assignee">
          {(id) => (
            <Select id={id} value={t.assigneeUserId ?? ''} onChange={(e) => update.mutate({ assigneeUserId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {assignees.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorNote error={update.error} />
        {t.kind === 'remote_hands' && (
          <form
            className="flex flex-col gap-2 border-t border-rule pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              time.mutate();
            }}
          >
            <p className="text-[13px] font-semibold text-ink-2">Log work</p>
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <Input aria-label="Minutes" inputMode="numeric" placeholder="min" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} required />
              <Input aria-label="What was done" placeholder="What was done" value={note} onChange={(e) => setNote(e.target.value)} required />
            </div>
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable (shown to the customer)
            </label>
            <Button type="submit" size="sm" busy={time.isPending}>
              Log time
            </Button>
            {time.data?.overAuthorized && <p className="text-[12.5px] text-warn">Billable time ({time.data.totalBillableMinutes} min) is over what the customer authorized.</p>}
            <ErrorNote error={time.error} />
          </form>
        )}
      </div>
    </Panel>
  );
}

export function TicketDetailPage() {
  const { id } = useParams();
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tickets', 'detail', id], queryFn: () => api.get<TicketDetailT>(`/tickets/${id}`), refetchInterval: 30_000 });
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const reply = useMutation({
    mutationFn: () => api.post(`/tickets/${id}/messages`, { body, internal }),
    onSuccess: () => {
      setBody('');
      setInternal(false);
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
  const setStatus = useMutation({ mutationFn: (status: TicketStatus) => api.patch(`/tickets/${id}`, { status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tickets'] }) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const t = q.data!;
  const writable = can('tickets.write') && t.status !== 'closed';
  const spent = t.time.filter((e) => e.billable).reduce((a, e) => a + e.minutes, 0);
  return (
    <>
      <Link to="/tickets" className="text-[13px] text-accent hover:underline">
        Remote hands & tickets
      </Link>
      <PageHeader
        title={`#${t.number} ${t.subject}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={STATUS_TONE[t.status]}>{TICKET_STATUS_LABELS[t.status]}</Chip>
            <Chip tone={PRIORITY_TONE[t.priority]}>{t.priority}</Chip>
            <span>{kindLabel(t.kind)}</span>
            {staff && <span>· {t.customerName ?? 'Internal'}</span>}
            {t.deviceName && <span>· {t.deviceName}</span>}
            <span>· opened by {t.createdBy} {relativeTime(t.createdAt)}</span>
          </span>
        }
        actions={
          !staff &&
          can('tickets.write') && (
            <>
              {t.status === 'resolved' && (
                <Button busy={setStatus.isPending} onClick={() => setStatus.mutate('open')}>
                  Reopen
                </Button>
              )}
              {t.status !== 'closed' && t.status !== 'resolved' && (
                <Button busy={setStatus.isPending} onClick={() => setStatus.mutate('resolved')}>
                  Mark resolved
                </Button>
              )}
              {t.status !== 'closed' && (
                <Button variant="ghost" busy={setStatus.isPending} onClick={() => setStatus.mutate('closed')}>
                  Close
                </Button>
              )}
            </>
          )
        }
      />
      <ErrorNote error={setStatus.error} className="mb-3" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-5">
          <Panel title="Conversation">
            <ol className="flex flex-col gap-3">
              {t.messages.map((m) =>
                m.authorType === 'system' ? (
                  <li key={m.id} className={cx('text-center text-[12.5px]', m.internal ? 'text-warn' : 'text-ink-3')}>
                    {m.body} · {formatDateTime(m.at)}
                    {m.internal ? ' · internal' : ''}
                  </li>
                ) : (
                  <li key={m.id} className={cx('rounded-xl border px-3 py-2', m.internal ? 'border-warn/40 bg-warn-soft' : m.authorType === 'staff' ? 'border-rule bg-accent-soft/40' : 'border-rule bg-panel')}>
                    <div className="mb-1 flex flex-wrap items-baseline gap-2 text-[12.5px] text-ink-3">
                      <span className="font-medium text-ink-2">{m.authorLabel}</span>
                      <span>{m.authorType === 'staff' ? 'Datacenter team' : 'Customer'}</span>
                      {m.internal && <Chip tone="warn">Internal note</Chip>}
                      <span className="ml-auto">{formatDateTime(m.at)}</span>
                    </div>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </li>
                ),
              )}
            </ol>
            {writable ? (
              <form
                className="mt-4 flex flex-col gap-2 border-t border-rule pt-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  reply.mutate();
                }}
              >
                <Textarea aria-label="Reply" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder={internal ? 'Internal note (customers never see it)' : 'Reply'} required />
                <div className="flex items-center gap-3">
                  {staff && (
                    <label className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note
                    </label>
                  )}
                  <Button type="submit" variant="primary" className="ml-auto" busy={reply.isPending}>
                    {internal ? 'Add note' : 'Send reply'}
                  </Button>
                </div>
                <ErrorNote error={reply.error} />
              </form>
            ) : (
              t.status === 'closed' && <p className="mt-4 text-[13px] text-ink-3">{staff ? 'This ticket is closed; change its status to reopen it.' : 'This ticket is closed. Open a new ticket if you need more help.'}</p>
            )}
          </Panel>
        </div>
        <div className="flex flex-col gap-5">
          {staff && can('tickets.write') && <StaffControls t={t} />}
          {(t.kind === 'remote_hands' || t.time.length > 0) && (
            <Panel title="Remote-hands time">
              <p className="text-[13px] text-ink-2">
                {spent} min billable{t.authorizedMinutes != null ? ` of ${t.authorizedMinutes} min authorized` : ''}
                {t.authorizedMinutes != null && spent > t.authorizedMinutes && <span className="text-warn"> (over)</span>}
              </p>
              {t.time.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-[13px]">
                  {t.time.map((e) => (
                    <li key={e.id} className={cx(!e.billable && 'text-ink-3')}>
                      {e.minutes} min · {e.note}
                      {!e.billable && ' (not billed)'}
                      <div className="text-[12px] text-ink-3">
                        {e.userLabel} · {formatDateTime(e.at)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

