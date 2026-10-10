import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACTION_LABELS, ACTION_TYPES, CONDITION_OPS, EVENT_TYPES, type ActionType } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table, Textarea } from '../components/ui';
import { Tabs } from './Network';

const TABS = [
  { key: 'workflows', label: 'Workflows' },
  { key: 'runs', label: 'Runs & approvals' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

type Cond = { field: string; op: (typeof CONDITION_OPS)[number]; value?: unknown };
type Action = { type: ActionType; requiresApproval: boolean; [k: string]: unknown };
interface WorkflowT {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: string;
  conditions: Cond[];
  actions: Action[];
  version: number;
  updatedBy: string | null;
  updatedAt: string;
  runs7d?: number;
  waiting?: number;
  failed7d?: number;
  completed7d?: number;
  lastRunAt?: string | null;
}
interface RunT {
  id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  event_id: number;
  event_type: string;
  subject_type: string | null;
  subject_id: string | null;
  status: string;
  next_action: number;
  log: { at: string; message: string; level: string }[];
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  finished_at: string | null;
}

const OP_LABEL: Record<string, string> = { eq: 'equals', neq: 'is not', in: 'is one of', contains: 'contains', gt: '>', gte: '≥', lt: '<', lte: '≤', exists: 'is set' };
const RUN_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'neutral' | 'accent'> = { completed: 'ok', waiting_approval: 'warn', approved: 'accent', pending: 'accent', failed: 'crit', rejected: 'neutral', skipped: 'neutral' };
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const TICKET_KINDS = ['support', 'remote_hands', 'cross_connect', 'shipment', 'access', 'billing', 'other'];

/** Text input → condition value: numbers and true/false are typed; `in` takes a comma-separated list. */
function parseValue(op: string, raw: string): unknown {
  if (op === 'exists') return null;
  const one = (s: string) => (/^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s === 'true' ? true : s === 'false' ? false : s);
  if (op === 'in') return raw.split(',').map((s) => s.trim()).filter(Boolean).map(one);
  return one(raw.trim());
}
const showValue = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === null || v === undefined ? '' : String(v));

function newAction(type: ActionType): Action {
  switch (type) {
    case 'create_ticket':
      return { type, requiresApproval: false, forCustomer: 'event', kind: 'support', priority: 'normal', subject: '', body: '' };
    case 'add_ticket_note':
      return { type, requiresApproval: false, body: '' };
    case 'set_ticket_priority':
      return { type, requiresApproval: false, priority: 'high' };
    case 'assign_ticket':
      return { type, requiresApproval: false, userId: '' };
    case 'notify':
      return { type, requiresApproval: false, channelId: '', title: '', text: '' };
  }
}

function ActionEditor({ a, onChange, onRemove, channels, staff }: { a: Action; onChange: (a: Action) => void; onRemove: () => void; channels: { id: string; name: string; kind: string }[]; staff: { id: string; email: string }[] }) {
  const set = (k: string) => (e: { target: { value: string } }) => onChange({ ...a, [k]: e.target.value });
  return (
    <div className="rounded-xl border border-rule p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-medium">{ACTION_LABELS[a.type]}</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={a.requiresApproval} onChange={(e) => onChange({ ...a, requiresApproval: e.target.checked })} /> Needs approval
          </label>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        </div>
      </div>
      {a.type === 'create_ticket' && (
        <div className="grid grid-cols-3 gap-2">
          <Field label="For">
            {(id) => (
              <Select id={id} value={String(a.forCustomer)} onChange={set('forCustomer')}>
                <option value="event">The event's customer</option>
                <option value="none">Internal ticket</option>
              </Select>
            )}
          </Field>
          <Field label="Kind">
            {(id) => (
              <Select id={id} value={String(a.kind)} onChange={set('kind')}>
                {TICKET_KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Priority">
            {(id) => (
              <Select id={id} value={String(a.priority)} onChange={set('priority')}>
                {PRIORITIES.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </Select>
            )}
          </Field>
          <div className="col-span-3">
            <Field label="Subject">{(id) => <Input id={id} value={String(a.subject)} onChange={set('subject')} required />}</Field>
          </div>
          <div className="col-span-3">
            <Field label="Body">{(id) => <Textarea id={id} rows={2} value={String(a.body)} onChange={set('body')} required />}</Field>
          </div>
        </div>
      )}
      {a.type === 'add_ticket_note' && <Field label="Internal note (staff only)">{(id) => <Textarea id={id} rows={2} value={String(a.body)} onChange={set('body')} required />}</Field>}
      {a.type === 'set_ticket_priority' && (
        <Field label="Priority">
          {(id) => (
            <Select id={id} value={String(a.priority)} onChange={set('priority')}>
              {PRIORITIES.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {a.type === 'assign_ticket' && (
        <Field label="Assign to">
          {(id) => (
            <Select id={id} value={String(a.userId)} onChange={set('userId')} required>
              <option value="">Choose…</option>
              {staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {a.type === 'notify' && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Channel">
            {(id) => (
              <Select id={id} value={String(a.channelId)} onChange={set('channelId')} required>
                <option value="">Choose…</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Title">{(id) => <Input id={id} value={String(a.title)} onChange={set('title')} required />}</Field>
          <div className="col-span-2">
            <Field label="Text">{(id) => <Textarea id={id} rows={2} value={String(a.text)} onChange={set('text')} required />}</Field>
          </div>
        </div>
      )}
    </div>
  );
}

interface DryRunT {
  triggerMatches: boolean;
  conditionsMatched: boolean;
  wouldRun: boolean;
  conditions: { field: string; op: string; value: unknown; actual: unknown; ok: boolean }[];
  actions: { step: number; type: string; requiresApproval: boolean; description: string }[];
}

function WorkflowEditor({ current, onClose }: { current: WorkflowT | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(current?.name ?? '');
  const [description, setDescription] = useState(current?.description ?? '');
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [trigger, setTrigger] = useState(current?.trigger ?? 'ticket.created');
  const [conds, setConds] = useState<{ field: string; op: Cond['op']; raw: string }[]>((current?.conditions ?? []).map((c) => ({ field: c.field, op: c.op, raw: showValue(c.value) })));
  const [actions, setActions] = useState<Action[]>(current?.actions ?? [newAction('add_ticket_note')]);
  const [sample, setSample] = useState('{\n  "priority": "urgent",\n  "subject": "Server down"\n}');
  const [eventId, setEventId] = useState('');
  const channels = useQuery({ queryKey: ['alerts', 'channels'], queryFn: () => api.get<{ id: string; name: string; kind: string }[]>('/alerts/channels') });
  const { can } = useAuth();
  const users = useQuery({ queryKey: ['users', 'staff'], queryFn: () => api.get<{ items: { id: string; email: string; userType: string; status: string }[] }>('/users?userType=staff&status=active&pageSize=100'), enabled: can('users.read') });
  const staff = (users.data?.items ?? []).filter((u) => u.userType === 'staff' && u.status === 'active');
  const body = () => ({ name, description: description || null, enabled, trigger, conditions: conds.map((c) => ({ field: c.field, op: c.op, value: parseValue(c.op, c.raw) })), actions });
  const save = useMutation({
    mutationFn: () => (current ? api.put(`/workflows/${current.id}`, body()) : api.post('/workflows', body())),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      onClose();
    },
  });
  const dry = useMutation({
    mutationFn: () => {
      let payload: Record<string, unknown> = {};
      if (!eventId) payload = JSON.parse(sample || '{}') as Record<string, unknown>;
      return api.post<DryRunT>('/workflows/dry-run', eventId ? { workflow: body(), eventId: Number(eventId) } : { workflow: body(), sample: { payload } });
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={current ? `Edit ${current.name}` : 'New workflow'} description="Workflows only create and change tickets and send notifications. They never power equipment, change network configuration or touch routes." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
          <Field label="When this happens">
            {(id) => (
              <Select id={id} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
                {EVENT_TYPES.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Description">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>

        <fieldset className="rounded-xl border border-rule p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-2">Only if (all must match)</legend>
          {!conds.length && <p className="text-[13px] text-ink-3">No conditions: runs on every {trigger} event.</p>}
          {conds.map((c, i) => (
            <div key={i} className="mb-2 grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
              <Input aria-label="Field" value={c.field} placeholder="payload.priority" className="font-mono text-[12.5px]" onChange={(e) => setConds((l) => l.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} />
              <Select aria-label="Operator" value={c.op} onChange={(e) => setConds((l) => l.map((x, j) => (j === i ? { ...x, op: e.target.value as Cond['op'] } : x)))}>
                {CONDITION_OPS.map((o) => (
                  <option key={o} value={o}>
                    {OP_LABEL[o]}
                  </option>
                ))}
              </Select>
              <Input aria-label="Value" value={c.raw} disabled={c.op === 'exists'} placeholder={c.op === 'in' ? 'high, urgent' : 'urgent'} onChange={(e) => setConds((l) => l.map((x, j) => (j === i ? { ...x, raw: e.target.value } : x)))} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setConds((l) => l.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="secondary" onClick={() => setConds((l) => [...l, { field: 'payload.', op: 'eq', raw: '' }])}>
            Add condition
          </Button>
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded-xl border border-rule p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-2">Then, in order</legend>
          <p className="text-[12.5px] text-ink-3">
            Use <code>{'{{payload.subject}}'}</code>, <code>{'{{customer.name}}'}</code>, <code>{'{{event.type}}'}</code> in text. Steps that need approval wait for someone other than the last editor of this workflow.
          </p>
          {actions.map((a, i) => (
            <ActionEditor key={i} a={a} channels={channels.data ?? []} staff={staff} onChange={(n) => setActions((l) => l.map((x, j) => (j === i ? n : x)))} onRemove={() => setActions((l) => l.filter((_, j) => j !== i))} />
          ))}
          <Select aria-label="Add a step" value="" onChange={(e) => e.target.value && setActions((l) => [...l, newAction(e.target.value as ActionType)])} className="w-60">
            <option value="">Add a step…</option>
            {ACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {ACTION_LABELS[t]}
              </option>
            ))}
          </Select>
        </fieldset>

        <fieldset className="rounded-xl border border-rule p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-2">Dry run (nothing is executed)</legend>
          <div className="grid grid-cols-[1fr_10rem] gap-2">
            <Field label="Sample payload (JSON)">{(id) => <Textarea id={id} rows={4} value={sample} onChange={(e) => setSample(e.target.value)} className="font-mono text-[12px]" disabled={!!eventId} />}</Field>
            <Field label="…or a stored event #">{(id) => <Input id={id} value={eventId} onChange={(e) => setEventId(e.target.value.replace(/\D/g, ''))} placeholder="1234" />}</Field>
          </div>
          <Button type="button" size="sm" variant="secondary" className="mt-2" busy={dry.isPending} onClick={() => dry.mutate()}>
            Test
          </Button>
          <ErrorNote error={dry.error} className="mt-2" />
          {dry.data && (
            <div className="mt-2 text-[13px]">
              <div className="mb-1">{dry.data.wouldRun ? <Chip tone="ok">Would run</Chip> : <Chip tone="warn">Would not run</Chip>} {!dry.data.triggerMatches && 'The event type does not match the trigger.'}</div>
              <ul className="space-y-0.5">
                {dry.data.conditions.map((c, i) => (
                  <li key={i}>
                    {c.ok ? '✓' : '✗'} <code>{c.field}</code> {OP_LABEL[c.op]} {JSON.stringify(c.value)} <span className="text-ink-3">(was {JSON.stringify(c.actual)})</span>
                  </li>
                ))}
              </ul>
              <ol className="mt-1 list-decimal pl-5">
                {dry.data.actions.map((a) => (
                  <li key={a.step}>
                    {a.description} {a.requiresApproval && <Chip tone="warn">approval</Chip>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </fieldset>

        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        {current && <p className="text-[12.5px] text-ink-3">Saving creates version {current.version + 1}. Runs waiting for approval on the current version are rejected.</p>}
        <ErrorNote error={save.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={save.isPending} disabled={!actions.length}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function WorkflowsTab() {
  const q = useQuery({ queryKey: ['workflows'], queryFn: () => api.get<WorkflowT[]>('/workflows') });
  const qc = useQueryClient();
  const [edit, setEdit] = useState<WorkflowT | 'new' | null>(null);
  const [del, setDel] = useState<WorkflowT | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/workflows/${id}`),
    onSuccess: () => {
      setDel(null);
      void qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
  return (
    <Panel
      title="Workflows"
      flush
      actions={
        <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
          New workflow
        </Button>
      }
    >
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} className="m-4" />
      {q.data && !q.data.length && <EmptyState title="No workflows">For example: when an urgent ticket arrives, add a triage note and notify the on-call channel.</EmptyState>}
      {!!q.data?.length && (
        <Table label="Workflows">
          <thead>
            <tr>
              <th>Name</th>
              <th>Trigger</th>
              <th>Steps</th>
              <th>Version</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((w) => (
              <tr key={w.id}>
                <td>
                  <div className="font-medium">
                    {w.name} {!w.enabled && <Chip>disabled</Chip>} {!!w.waiting && <Chip tone="warn">{w.waiting} waiting</Chip>}
                  </div>
                  {w.description && <div className="text-[12.5px] text-ink-3">{w.description}</div>}
                </td>
                <td className="font-mono text-[12.5px]">
                  {w.trigger}
                  {!!w.conditions.length && <span className="text-ink-3"> + {w.conditions.length} condition{w.conditions.length > 1 ? 's' : ''}</span>}
                </td>
                <td className="text-[12.5px]">{w.actions.map((a) => ACTION_LABELS[a.type] + (a.requiresApproval ? ' (approval)' : '')).join(' → ')}</td>
                <td className="text-[12.5px] text-ink-2">
                  v{w.version}
                  {w.updatedBy ? ` by ${w.updatedBy}` : ''}
                </td>
                <td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setEdit(w)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDel(w)}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit && <WorkflowEditor current={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete ${del?.name}?`} body="Its run history is deleted too. Tickets and notes it created stay." confirmLabel="Delete workflow" busy={remove.isPending} error={remove.error} onConfirm={() => del && remove.mutate(del.id)} />
    </Panel>
  );
}

function RunsTab() {
  const { me } = useAuth();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<RunT | null>(null);
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['workflows', 'runs', status], queryFn: () => api.get<RunT[]>(`/workflows/runs${qs({ status: status || undefined })}`), refetchInterval: 10_000 });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => api.post(`/workflows/runs/${id}/${approve ? 'approve' : 'reject'}`, { note: note || null }),
    onSuccess: () => {
      setOpen(null);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
  return (
    <Panel
      title="Runs"
      flush
      actions={
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-48">
          <option value="">All</option>
          {Object.keys(RUN_TONE).map((s) => (
            <option key={s} value={s}>
              {s.replace('_', ' ')}
            </option>
          ))}
        </Select>
      }
    >
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} className="m-4" />
      {q.data && !q.data.length && <EmptyState title="No runs" />}
      {!!q.data?.length && (
        <Table label="Workflow runs">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Event</th>
              <th>Status</th>
              <th>Last step</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((r) => (
              <tr key={r.id} className="cursor-pointer hover:bg-sunken" onClick={() => setOpen(r)}>
                <td className="font-medium">
                  {r.workflow_name} <span className="text-[12px] text-ink-3">v{r.workflow_version}</span>
                </td>
                <td className="font-mono text-[12.5px]">
                  {r.event_type} #{r.event_id}
                </td>
                <td>
                  <Chip tone={RUN_TONE[r.status] ?? 'neutral'}>{r.status.replace('_', ' ')}</Chip>
                </td>
                <td className="max-w-[44ch] truncate text-[12.5px] text-ink-2">{r.log[r.log.length - 1]?.message ?? '—'}</td>
                <td>{relativeTime(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {open && (
        <Modal open onOpenChange={(o) => !o && setOpen(null)} title={`${open.workflow_name}: run`} description={`${open.event_type} #${open.event_id} · started ${formatDateTime(open.created_at)}`} wide>
          <ol className="mb-3 space-y-1 text-[13px]">
            {open.log.map((l, i) => (
              <li key={i} className={l.level === 'error' ? 'text-crit' : l.level === 'warn' ? 'text-warn' : ''}>
                <span className="text-ink-3">{formatDateTime(l.at)}</span> {l.message}
              </li>
            ))}
          </ol>
          {open.decided_by && (
            <p className="mb-3 text-[13px] text-ink-2">
              Decided by {open.decided_by} {relativeTime(open.decided_at)}
            </p>
          )}
          {open.status === 'waiting_approval' && (
            <div className="flex flex-col gap-2 border-t border-rule pt-3">
              <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              <p className="text-[12.5px] text-ink-3">Signed in as {me?.user.email}. The last editor of the workflow can't approve its steps.</p>
              <ErrorNote error={decide.error} />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" busy={decide.isPending && !decide.variables?.approve} onClick={() => decide.mutate({ id: open.id, approve: false })}>
                  Reject
                </Button>
                <Button variant="primary" busy={decide.isPending && decide.variables?.approve} onClick={() => decide.mutate({ id: open.id, approve: true })}>
                  Approve step
                </Button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </Panel>
  );
}

export function WorkflowsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) ?? 'workflows';
  return (
    <>
      <PageHeader title="Automation & workflows" description="React to events with ticket actions and notifications. Conditions are checked first; steps can require a second person's approval; every step is audited." />
      <Tabs tabs={TABS} value={tab} label="Workflow sections" onChange={(k) => setParams(k === 'workflows' ? {} : { tab: k }, { replace: true })} />
      {tab === 'workflows' && <WorkflowsTab />}
      {tab === 'runs' && <RunsTab />}
    </>
  );
}
