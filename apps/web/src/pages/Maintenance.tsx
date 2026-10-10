import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { INCIDENT_STATUSES, INCIDENT_STATUS_LABELS, type IncidentStatus } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { useSites } from '../lib/colocation';
import { Button, Chip, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Table, Textarea } from '../components/ui';

interface IncidentT {
  id: string;
  title: string;
  severity: 'minor' | 'major' | 'critical';
  status: IncidentStatus;
  datacenter: { id: string; code: string; name: string } | null;
  public: boolean;
  startedAt: string;
  resolvedAt: string | null;
  latest: string | null;
  customerIds?: string[];
}
interface IncidentDetailT extends IncidentT {
  updates: { id: number; at: string; status: IncidentStatus; message: string; public?: boolean; author?: string | null }[];
}
interface WindowT {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  scope: string;
  datacenter: { code: string; name: string } | null;
  description: string | null;
  affectedDevices: number;
  state: 'scheduled' | 'in_progress' | 'completed';
  customerVisible?: boolean;
  notes?: string | null;
}

const SEV_TONE = { critical: 'crit', major: 'warn', minor: 'accent' } as const;
const STATUS_TONE: Record<IncidentStatus, 'crit' | 'warn' | 'accent' | 'ok'> = { investigating: 'crit', identified: 'warn', monitoring: 'accent', resolved: 'ok' };
const WINDOW_TONE = { scheduled: 'accent', in_progress: 'warn', completed: 'neutral' } as const;

function NewIncident({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const sites = useSites();
  const customers = useQuery({ queryKey: ['status', 'customers'], queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/status/customers') });
  const [f, setF] = useState({ title: '', severity: 'major', datacenterId: '', message: '', public: true });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const m = useMutation({
    mutationFn: () => api.post('/status/incidents', { ...f, datacenterId: f.datacenterId || null, customerIds: [...picked] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['status'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Open an incident" description="A public incident is shown to customers with equipment or space at the site, and to any customers you name. Internal incidents stay with staff." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Title">{(id) => <Input id={id} value={f.title} onChange={(e) => setF((x) => ({ ...x, title: e.target.value }))} placeholder="Power feed A degraded in Hall 1" required />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Severity">
            {(id) => (
              <Select id={id} value={f.severity} onChange={(e) => setF((x) => ({ ...x, severity: e.target.value }))}>
                <option value="minor">Minor</option>
                <option value="major">Major</option>
                <option value="critical">Critical</option>
              </Select>
            )}
          </Field>
          <Field label="Affected site">
            {(id) => (
              <Select id={id} value={f.datacenterId} onChange={(e) => setF((x) => ({ ...x, datacenterId: e.target.value }))}>
                <option value="">None (named customers only)</option>
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <fieldset className="max-h-40 overflow-y-auto rounded-xl border border-rule p-3">
          <legend className="px-1 text-[13px] font-medium text-ink-2">Also affected customers</legend>
          <div className="grid grid-cols-2 gap-x-4">
            {customers.data?.map((c) => (
              <label key={c.id} className="flex items-center gap-2 py-0.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (e.target.checked) n.add(c.id);
                      else n.delete(c.id);
                      return n;
                    })
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="First update">{(id) => <Textarea id={id} rows={3} value={f.message} onChange={(e) => setF((x) => ({ ...x, message: e.target.value }))} required />}</Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={f.public} onChange={(e) => setF((x) => ({ ...x, public: e.target.checked }))} /> Show to affected customers
        </label>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending}>
            Open incident
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function IncidentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { me, can } = useAuth();
  const manage = me?.user.userType === 'staff' && can('alerts.manage');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['status', 'incident', id], queryFn: () => api.get<IncidentDetailT>(`/status/incidents/${id}`) });
  const [f, setF] = useState<{ status: IncidentStatus; message: string; public: boolean }>({ status: 'identified', message: '', public: true });
  const m = useMutation({
    mutationFn: () => api.post(`/status/incidents/${id}/updates`, f),
    onSuccess: () => {
      setF((x) => ({ ...x, message: '' }));
      void qc.invalidateQueries({ queryKey: ['status'] });
    },
  });
  const i = q.data;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={i?.title ?? 'Incident'} description={i ? `${i.datacenter ? `${i.datacenter.name} · ` : ''}started ${formatDateTime(i.startedAt)}${i.resolvedAt ? ` · resolved ${formatDateTime(i.resolvedAt)}` : ''}` : undefined} wide>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {i && (
        <>
          <div className="mb-3 flex gap-2">
            <Chip tone={SEV_TONE[i.severity]}>{i.severity}</Chip>
            <Chip tone={STATUS_TONE[i.status]}>{INCIDENT_STATUS_LABELS[i.status]}</Chip>
            {manage && !i.public && <Chip>internal</Chip>}
          </div>
          <ol className="flex flex-col gap-3 border-l-2 border-rule pl-4">
            {[...i.updates].reverse().map((u) => (
              <li key={u.id}>
                <div className="text-[12.5px] text-ink-3">
                  <b className="text-ink-2">{INCIDENT_STATUS_LABELS[u.status]}</b> · {formatDateTime(u.at)}
                  {manage && u.author ? ` · ${u.author}` : ''} {manage && u.public === false && <Chip>internal</Chip>}
                </div>
                <p className="whitespace-pre-wrap">{u.message}</p>
              </li>
            ))}
          </ol>
          {manage && (
            <form
              className="mt-4 flex flex-col gap-2 border-t border-rule pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                m.mutate();
              }}
            >
              <div className="grid grid-cols-[12rem_1fr] gap-2">
                <Field label="Status">
                  {(fid) => (
                    <Select id={fid} value={f.status} onChange={(e) => setF((x) => ({ ...x, status: e.target.value as IncidentStatus }))}>
                      {INCIDENT_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {INCIDENT_STATUS_LABELS[s]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Update">{(fid) => <Textarea id={fid} rows={2} value={f.message} onChange={(e) => setF((x) => ({ ...x, message: e.target.value }))} required />}</Field>
              </div>
              <label className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={f.public && i.public} disabled={!i.public} onChange={(e) => setF((x) => ({ ...x, public: e.target.checked }))} /> Show to customers
              </label>
              <ErrorNote error={m.error} />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" busy={m.isPending}>
                  Post update
                </Button>
              </div>
            </form>
          )}
        </>
      )}
    </Modal>
  );
}

function NoticeDialog({ w, onClose }: { w: WindowT; onClose: () => void }) {
  const qc = useQueryClient();
  const [visible, setVisible] = useState(w.customerVisible ?? false);
  const [description, setDescription] = useState(w.description ?? '');
  const m = useMutation({
    mutationFn: () => api.put(`/status/maintenance/${w.id}/notice`, { customerVisible: visible, description: description || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['status'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Customer notice: ${w.name}`} description="Published notices are shown to customers with equipment or space in scope. Internal notes are never shown.">
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Show to affected customers
        </label>
        <Field label="What customers see">{(id) => <Textarea id={id} rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="UPS B is replaced. Both feeds stay up; A-only equipment runs without redundancy for about 2 hours." />}</Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending} onClick={() => m.mutate()}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function MaintenancePage() {
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  const manage = staff && can('alerts.manage');
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<WindowT | null>(null);
  const inc = useQuery({ queryKey: ['status', 'incidents', status, page], queryFn: () => api.get<Paginated<IncidentT>>(`/status/incidents${qs({ status, page, pageSize: 25 })}`), refetchInterval: 30_000 });
  const win = useQuery({ queryKey: ['status', 'maintenance'], queryFn: () => api.get<WindowT[]>('/status/maintenance') });
  return (
    <>
      <PageHeader
        title="Maintenance & incidents"
        description={staff ? 'Incidents with timed updates, and the customer-facing notice for each maintenance window. Windows themselves are planned under Monitoring & Alerts.' : 'Incidents and planned maintenance that affect your equipment or space.'}
        actions={
          manage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              Open incident
            </Button>
          )
        }
      />
      <Panel
        title="Incidents"
        flush
        actions={
          <Select
            aria-label="Show"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="h-8 w-36"
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </Select>
        }
      >
        {inc.isLoading && <Loading />}
        <ErrorNote error={inc.error} className="m-4" />
        {inc.data && !inc.data.items.length && <EmptyState title={status === 'open' ? 'No open incidents' : 'No incidents'}>{status === 'open' ? 'All systems are operating normally.' : undefined}</EmptyState>}
        {!!inc.data?.items.length && (
          <>
            <Table label="Incidents">
              <thead>
                <tr>
                  <th>Incident</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Latest update</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {inc.data.items.map((i) => (
                  <tr key={i.id} className="cursor-pointer hover:bg-sunken" onClick={() => setOpen(i.id)}>
                    <td>
                      <div className="font-medium">
                        {i.title} {staff && !i.public && <Chip>internal</Chip>}
                      </div>
                      <div className="text-[12.5px] text-ink-3">{i.datacenter ? i.datacenter.name : 'Specific customers'}</div>
                    </td>
                    <td>
                      <Chip tone={SEV_TONE[i.severity]}>{i.severity}</Chip>
                    </td>
                    <td>
                      <Chip tone={STATUS_TONE[i.status]}>{INCIDENT_STATUS_LABELS[i.status]}</Chip>
                    </td>
                    <td className="max-w-[44ch] truncate text-[12.5px] text-ink-2">{i.latest}</td>
                    <td>{relativeTime(i.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={inc.data.page} pageSize={inc.data.pageSize} total={inc.data.total} onPage={setPage} />
          </>
        )}
      </Panel>
      <Panel title="Maintenance" className="mt-4" flush>
        {win.isLoading && <Loading />}
        <ErrorNote error={win.error} className="m-4" />
        {win.data && !win.data.length && <EmptyState title="No maintenance planned" />}
        {!!win.data?.length && (
          <Table label="Maintenance windows">
            <thead>
              <tr>
                <th>Window</th>
                <th>When</th>
                <th>Scope</th>
                <th>{staff ? 'Customer notice' : 'Details'}</th>
                {manage && <th />}
              </tr>
            </thead>
            <tbody>
              {win.data.map((w) => (
                <tr key={w.id}>
                  <td>
                    <div className="font-medium">{w.name}</div>
                    <Chip tone={WINDOW_TONE[w.state]}>{w.state.replace('_', ' ')}</Chip>
                  </td>
                  <td className="text-[12.5px] whitespace-nowrap">
                    {formatDateTime(w.startsAt)}
                    <br />→ {formatDateTime(w.endsAt)}
                  </td>
                  <td className="text-[12.5px]">{w.scope === 'all' ? 'All sites' : w.scope === 'datacenter' ? w.datacenter?.name : `${w.affectedDevices} device(s)`}</td>
                  <td className="max-w-[48ch] text-[12.5px]">
                    {staff && (w.customerVisible ? <Chip tone="ok">published</Chip> : <Chip>staff only</Chip>)} {w.description ?? (staff ? <span className="text-ink-3">No notice written</span> : '')}
                  </td>
                  {manage && (
                    <td className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setNotice(w)}>
                        Notice
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {creating && <NewIncident onClose={() => setCreating(false)} />}
      {open && <IncidentDetail id={open} onClose={() => setOpen(null)} />}
      {notice && <NoticeDialog w={notice} onClose={() => setNotice(null)} />}
    </>
  );
}
