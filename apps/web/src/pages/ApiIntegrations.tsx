import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EVENT_TYPES, PERMISSIONS } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table } from '../components/ui';
import { Tabs } from './Network';

const TABS = [
  { key: 'keys', label: 'API keys' },
  { key: 'webhooks', label: 'Webhooks' },
  { key: 'events', label: 'Event log' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/** Shows a secret once, with a copy button and a plain warning. */
export function SecretOnce({ title, label, value, onClose, children }: { title: string; label: string; value: string; onClose: () => void; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title} description="Copy it now. It is stored only as a hash or encrypted, and is never shown again." wide>
      <div className="flex flex-col gap-3">
        <Field label={label}>{(id) => <Input id={id} readOnly value={value} className="font-mono text-[12.5px]" onFocus={(e) => e.currentTarget.select()} />}</Field>
        {children}
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              void navigator.clipboard?.writeText(value).then(
                () => setCopied(true),
                () => undefined,
              )
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="primary" onClick={onClose}>
            I have stored it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ API keys */

interface KeyT {
  id: string;
  name: string;
  prefix: string;
  owner: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
}

function NewKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (token: string) => void }) {
  const { me } = useAuth();
  const held = new Set(me?.permissions ?? []);
  const options = PERMISSIONS.filter((p) => held.has(p.key));
  const [name, setName] = useState('');
  const [days, setDays] = useState('365');
  const [scopes, setScopes] = useState<Set<string>>(new Set(options.filter((p) => p.key.endsWith('.read')).map((p) => p.key)));
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.post<{ token: string }>('/api-keys', { name, scopes: [...scopes], expiresInDays: days ? Number(days) : null }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      onCreated(r.token);
    },
  });
  const groups = [...new Set(options.map((p) => p.group))];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="New API key" description="A key acts with the permissions you tick, and never more than you hold yourself. If you lose a role, your keys lose it too." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="WHMCS usage reader" required />}</Field>
          <Field label="Expires after">
            {(id) => (
              <Select id={id} value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="730">2 years</option>
                <option value="">Never</option>
              </Select>
            )}
          </Field>
        </div>
        <fieldset className="max-h-72 overflow-y-auto rounded-xl border border-rule p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-2">Scopes</legend>
          {groups.map((g) => (
            <div key={g} className="mb-2">
              <div className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">{g}</div>
              <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                {options
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <label key={p.key} className="flex items-center gap-2 py-0.5 text-[13px]">
                      <input
                        type="checkbox"
                        checked={scopes.has(p.key)}
                        onChange={(e) =>
                          setScopes((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(p.key);
                            else n.delete(p.key);
                            return n;
                          })
                        }
                      />
                      <span>{p.label}</span>
                      {p.dangerous && <Chip tone="warn">sensitive</Chip>}
                    </label>
                  ))}
              </div>
            </div>
          ))}
        </fieldset>
        <p className="text-[12.5px] text-ink-3">Keys can't manage keys, sign in, or approve workflow steps: those need a signed-in person.</p>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!scopes.size}>
            Create key
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function KeysTab() {
  const q = useQuery({ queryKey: ['api-keys'], queryFn: () => api.get<KeyT[]>('/api-keys') });
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<KeyT | null>(null);
  const r = useMutation({
    mutationFn: (id: string) => api.delete(`/api-keys/${id}`),
    onSuccess: () => {
      setRevoke(null);
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  return (
    <Panel
      title="API keys"
      flush
      actions={
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          New key
        </Button>
      }
    >
      <p className="px-4 pt-3 text-[13px] text-ink-2">
        Send as <code className="rounded bg-sunken px-1">Authorization: Bearer ndc_…</code>. Every call is audited under the key's name.
      </p>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} className="m-4" />
      {q.data && !q.data.length && <EmptyState title="No API keys">Create one for scripts and integrations.</EmptyState>}
      {!!q.data?.length && (
        <Table label="API keys">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Owner</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((k) => (
              <tr key={k.id} className={k.active ? '' : 'opacity-60'}>
                <td className="font-medium">{k.name}</td>
                <td className="font-mono text-[12.5px]">{k.prefix}</td>
                <td>{k.owner}</td>
                <td className="max-w-[28ch] text-[12.5px] text-ink-2" title={k.scopes.join(', ')}>
                  {k.scopes.length} permission{k.scopes.length === 1 ? '' : 's'}
                </td>
                <td>{k.lastUsedAt ? `${relativeTime(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` : 'Never'}</td>
                <td>{k.revokedAt ? <Chip tone="crit">Revoked</Chip> : k.expiresAt ? (k.active ? formatDateTime(k.expiresAt) : <Chip tone="warn">Expired</Chip>) : 'Never'}</td>
                <td className="text-right">
                  {k.active && (
                    <Button size="sm" variant="ghost" onClick={() => setRevoke(k)}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {creating && (
        <NewKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(t) => {
            setCreating(false);
            setToken(t);
          }}
        />
      )}
      {token && <SecretOnce title="Your new API key" label="Token" value={token} onClose={() => setToken(null)} />}
      <ConfirmDialog open={!!revoke} onOpenChange={(o) => !o && setRevoke(null)} title={`Revoke ${revoke?.name}?`} body="Anything using this key stops working immediately. This can't be undone." confirmLabel="Revoke key" busy={r.isPending} error={r.error} onConfirm={() => revoke && r.mutate(revoke.id)} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ webhooks */

interface SubT {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  pending: number;
  failed: number;
  sent7d: number;
}
interface DeliveryT {
  id: string;
  event_id: number;
  event_type: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  response_status: number | null;
  last_error: string | null;
  sent_at: string | null;
  created_at: string;
}

function SubscriptionDialog({ current, onClose, onSecret }: { current: SubT | null; onClose: () => void; onSecret: (s: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(current?.name ?? '');
  const [url, setUrl] = useState(current?.url ?? 'https://');
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [events, setEvents] = useState<Set<string>>(new Set(current?.events ?? ['*']));
  const m = useMutation({
    mutationFn: () => {
      const body = { name, url, enabled, events: [...events] };
      return current ? api.put<SubT>(`/automation/webhooks/${current.id}`, body) : api.post<SubT & { signingSecret: string }>('/automation/webhooks', body);
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
      onClose();
      if ('signingSecret' in r) onSecret((r as { signingSecret: string }).signingSecret);
    },
  });
  const toggle = (e: string, on: boolean) =>
    setEvents((s) => {
      const n = new Set(e === '*' ? [] : [...s].filter((x) => x !== '*'));
      if (on) n.add(e);
      else n.delete(e);
      return n;
    });
  const groups = [...new Set(EVENT_TYPES.map((e) => e.split('.')[0]!))];
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={current ? `Edit ${current.name}` : 'New webhook'} description="NexoraDC POSTs each event as JSON, signed with HMAC-SHA256. Deliveries are retried for about 12 hours with backoff." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
          <Field label="Receiver URL" hint="Private and loopback addresses are refused unless the operator allows them.">
            {(id, d) => <Input id={id} aria-describedby={d} value={url} onChange={(e) => setUrl(e.target.value)} required />}
          </Field>
        </div>
        <fieldset className="max-h-64 overflow-y-auto rounded-xl border border-rule p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-2">Events</legend>
          <label className="mb-2 flex items-center gap-2 text-[13px] font-medium">
            <input type="checkbox" checked={events.has('*')} onChange={(e) => toggle('*', e.target.checked)} /> All events
          </label>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            {groups.map((g) => (
              <div key={g} className="mb-1">
                {EVENT_TYPES.filter((e) => e.startsWith(`${g}.`)).map((e) => (
                  <label key={e} className="flex items-center gap-2 py-0.5 font-mono text-[12.5px]">
                    <input type="checkbox" checked={events.has('*') || events.has(e)} disabled={events.has('*')} onChange={(x) => toggle(e, x.target.checked)} /> {e}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!events.size}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const DELIVERY_TONE: Record<string, 'ok' | 'warn' | 'crit' | 'neutral'> = { sent: 'ok', pending: 'warn', failed: 'crit', cancelled: 'neutral' };

function Deliveries({ sub, onClose }: { sub: SubT; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['webhooks', sub.id, 'deliveries'], queryFn: () => api.get<DeliveryT[]>(`/automation/webhooks/${sub.id}/deliveries`), refetchInterval: 10_000 });
  const again = useMutation({ mutationFn: (id: string) => api.post(`/automation/deliveries/${id}/redeliver`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['webhooks'] }) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Deliveries: ${sub.name}`} description="Redelivering sends the same event id, so receivers can drop repeats." wide>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error ?? again.error} />
      {q.data && !q.data.length && <EmptyState title="No deliveries yet" />}
      {!!q.data?.length && (
        <div className="-mx-5">
          <Table label="Deliveries">
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Result</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div className="font-mono text-[12.5px]">{d.event_type}</div>
                    <div className="text-[12px] text-ink-3">
                      #{d.event_id} · {relativeTime(d.created_at)}
                    </div>
                  </td>
                  <td>
                    <Chip tone={DELIVERY_TONE[d.status] ?? 'neutral'}>{d.status}</Chip>
                  </td>
                  <td>{d.attempts}</td>
                  <td className="max-w-[30ch] text-[12.5px] text-ink-2">{d.sent_at ? `HTTP ${d.response_status} · ${relativeTime(d.sent_at)}` : (d.last_error ?? (d.status === 'pending' ? `next try ${relativeTime(d.next_attempt_at)}` : '—'))}</td>
                  <td className="text-right">
                    {d.status !== 'pending' && (
                      <Button size="sm" variant="ghost" busy={again.isPending && again.variables === d.id} onClick={() => again.mutate(d.id)}>
                        Redeliver
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Modal>
  );
}

function WebhooksTab() {
  const q = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<SubT[]>('/automation/webhooks'), refetchInterval: 15_000 });
  const qc = useQueryClient();
  const [edit, setEdit] = useState<SubT | 'new' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [del, setDel] = useState<SubT | null>(null);
  const [view, setView] = useState<SubT | null>(null);
  const rotate = useMutation({ mutationFn: (id: string) => api.post<{ signingSecret: string }>(`/automation/webhooks/${id}/rotate-secret`), onSuccess: (r) => setSecret(r.signingSecret) });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/automation/webhooks/${id}`),
    onSuccess: () => {
      setDel(null);
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  return (
    <>
      <Panel
        title="Webhook subscriptions"
        flush
        actions={
          <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
            New webhook
          </Button>
        }
      >
        {q.isLoading && <Loading />}
        <ErrorNote error={q.error ?? rotate.error} className="m-4" />
        {q.data && !q.data.length && <EmptyState title="No webhooks">Subscribe a URL to tickets, services, alerts and other events.</EmptyState>}
        {!!q.data?.length && (
          <Table label="Webhooks">
            <thead>
              <tr>
                <th>Name</th>
                <th>Events</th>
                <th>Health</th>
                <th>Queue</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div className="font-medium">
                      {s.name} {!s.enabled && <Chip>disabled</Chip>}
                    </div>
                    <div className="max-w-[40ch] truncate font-mono text-[12px] text-ink-3">{s.url}</div>
                  </td>
                  <td className="text-[12.5px]">{s.events.includes('*') ? 'All events' : s.events.length <= 2 ? s.events.join(', ') : `${s.events.length} event types`}</td>
                  <td className="text-[12.5px]">
                    {s.lastFailureAt && (!s.lastSuccessAt || s.lastFailureAt > s.lastSuccessAt) ? (
                      <span title={s.lastError ?? ''}>
                        <Chip tone="crit">Failing</Chip> {relativeTime(s.lastFailureAt)}
                      </span>
                    ) : s.lastSuccessAt ? (
                      <span>
                        <Chip tone="ok">OK</Chip> {relativeTime(s.lastSuccessAt)}
                      </span>
                    ) : (
                      <span className="text-ink-3">No deliveries yet</span>
                    )}
                  </td>
                  <td className="text-[12.5px]">
                    {s.sent7d} sent (7d) · {s.pending} pending · <span className={s.failed ? 'text-crit' : ''}>{s.failed} failed</span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => setView(s)}>
                      Deliveries
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" busy={rotate.isPending && rotate.variables === s.id} onClick={() => rotate.mutate(s.id)}>
                      New secret
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDel(s)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Panel title="Verifying deliveries" className="mt-4">
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-ink-2">
          <li>
            Headers: <code>X-NexoraDC-Event</code>, <code>X-NexoraDC-Event-Id</code>, <code>X-NexoraDC-Delivery</code>, <code>X-NexoraDC-Timestamp</code>, <code>X-NexoraDC-Signature</code>.
          </li>
          <li>
            Signature: <code>sha256=</code> + hex HMAC-SHA256 of <code>&lt;timestamp&gt;.&lt;raw body&gt;</code> with the signing secret. Reject old timestamps (e.g. older than 5 minutes).
          </li>
          <li>The event id is stable across retries and redeliveries: store it and ignore repeats. Answer with any 2xx within 15 seconds.</li>
        </ul>
      </Panel>
      {edit && <SubscriptionDialog current={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSecret={setSecret} />}
      {secret && <SecretOnce title="Signing secret" label="Secret" value={secret} onClose={() => setSecret(null)} />}
      {view && <Deliveries sub={view} onClose={() => setView(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete ${del?.name}?`} body="Pending deliveries are dropped. The receiver gets nothing further." confirmLabel="Delete webhook" busy={remove.isPending} error={remove.error} onConfirm={() => del && remove.mutate(del.id)} />
    </>
  );
}

/* ------------------------------------------------------------------ events */

interface EventT {
  id: number;
  type: string;
  customerId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  causedByRunId: string | null;
  at: string;
  processedAt: string | null;
}

function EventsTab() {
  const [type, setType] = useState('');
  const [open, setOpen] = useState<EventT | null>(null);
  const q = useQuery({ queryKey: ['events', type], queryFn: () => api.get<EventT[]>(`/automation/events${qs({ type: type || undefined, limit: 200 })}`), refetchInterval: 10_000 });
  return (
    <Panel
      title="Event log"
      flush
      actions={
        <Select aria-label="Event type" value={type} onChange={(e) => setType(e.target.value)} className="h-8 w-56">
          <option value="">All types</option>
          {EVENT_TYPES.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </Select>
      }
    >
      <p className="px-4 pt-3 text-[13px] text-ink-2">Every change that webhooks and workflows can react to. Events are written in the same transaction as the change itself.</p>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} className="m-4" />
      {q.data && !q.data.length && <EmptyState title="No events" />}
      {!!q.data?.length && (
        <Table label="Events">
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Subject</th>
              <th>When</th>
              <th>Fan-out</th>
            </tr>
          </thead>
          <tbody>
            {q.data.map((e) => (
              <tr key={e.id} className="cursor-pointer hover:bg-sunken" onClick={() => setOpen(e)}>
                <td className="font-mono text-[12.5px]">{e.id}</td>
                <td className="font-mono text-[12.5px]">
                  {e.type} {e.causedByRunId && <Chip tone="accent">by workflow</Chip>}
                </td>
                <td className="text-[12.5px] text-ink-2">{e.subjectType ? `${e.subjectType} ${e.subjectId?.slice(0, 8)}` : '—'}</td>
                <td>{formatDateTime(e.at)}</td>
                <td>{e.processedAt ? <Chip tone="ok">done</Chip> : <Chip tone="warn">queued</Chip>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {open && (
        <Modal open onOpenChange={(o) => !o && setOpen(null)} title={`Event #${open.id}: ${open.type}`} wide>
          <pre className="max-h-[60vh] overflow-auto rounded-xl bg-sunken p-3 font-mono text-[12px]">{JSON.stringify(open, null, 2)}</pre>
        </Modal>
      )}
    </Panel>
  );
}

export function ApiIntegrationsPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useAuth();
  const tabs = TABS.filter((t) => t.key === 'keys' || can('workflows.manage'));
  const tab = ((params.get('tab') as TabKey) ?? 'keys') satisfies TabKey;
  return (
    <>
      <PageHeader title="API & integrations" description="API keys for scripts and integrations, signed outbound webhooks, and the event log that drives them." />
      <Tabs tabs={tabs} value={tab} label="Integration sections" onChange={(k) => setParams(k === 'keys' ? {} : { tab: k }, { replace: true })} />
      {tab === 'keys' && <KeysTab />}
      {tab === 'webhooks' && can('workflows.manage') && <WebhooksTab />}
      {tab === 'events' && can('workflows.manage') && <EventsTab />}
    </>
  );
}
