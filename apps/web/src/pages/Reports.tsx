import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { REPORT_LABELS, type ReportType } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table } from '../components/ui';

interface ReportT {
  type: string;
  title: string;
  period: { name: string; from: string; to: string; timezone: string };
  generatedAt: string;
  scope: string;
  columns: { key: string; label: string; numeric?: boolean; decimals?: number }[];
  rows: Record<string, string | number | boolean | null>[];
  notes: string[];
}
interface ScheduleT {
  id: string;
  name: string;
  type: ReportType;
  period: string;
  format: 'csv' | 'pdf';
  frequency: 'daily' | 'weekly' | 'monthly';
  hour: number;
  weekday: number | null;
  dayOfMonth: number | null;
  channelId: string;
  recipients: string[];
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

const PERIOD_LABEL: Record<string, string> = { last_7d: 'Last 7 days', last_30d: 'Last 30 days', this_month: 'This month', last_month: 'Last month' };
const SNAPSHOT: string[] = ['capacity', 'services'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function cell(c: ReportT['columns'][number], v: unknown) {
  if (v === null || v === undefined || v === '') return <span className="text-ink-3">—</span>;
  if (typeof v === 'number') return c.decimals !== undefined ? v.toLocaleString(undefined, { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals }) : v.toLocaleString();
  return String(v);
}

function ScheduleDialog({ current, types, onClose }: { current: ScheduleT | null; types: { key: string; label: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const channels = useQuery({ queryKey: ['alerts', 'channels'], queryFn: () => api.get<{ id: string; name: string; kind: string }[]>('/alerts/channels') });
  const email = (channels.data ?? []).filter((c) => c.kind === 'email');
  const [f, setF] = useState({
    name: current?.name ?? '',
    type: current?.type ?? 'energy',
    period: current?.period ?? 'last_month',
    format: current?.format ?? 'pdf',
    frequency: current?.frequency ?? 'monthly',
    hour: String(current?.hour ?? 6),
    weekday: String(current?.weekday ?? 1),
    dayOfMonth: String(current?.dayOfMonth ?? 1),
    channelId: current?.channelId ?? '',
    recipients: current?.recipients.join(', ') ?? '',
    enabled: current?.enabled ?? true,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        type: f.type,
        period: f.period,
        format: f.format,
        frequency: f.frequency,
        hour: Number(f.hour),
        weekday: f.frequency === 'weekly' ? Number(f.weekday) : null,
        dayOfMonth: f.frequency === 'monthly' ? Number(f.dayOfMonth) : null,
        channelId: f.channelId,
        recipients: f.recipients.split(/[,\s]+/).filter(Boolean),
        enabled: f.enabled,
      };
      return current ? api.put(`/reports/schedules/${current.id}`, body) : api.post('/reports/schedules', body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reports', 'schedules'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={current ? `Edit ${current.name}` : 'Schedule a report'} description="Sent as an attachment through an email notification channel's SMTP settings. Times are in the organization's time zone." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={set('name')} placeholder="Monthly energy for finance" required />}</Field>
          <Field label="Report">
            {(id) => (
              <Select id={id} value={f.type} onChange={set('type')}>
                {types.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Period">
            {(id) => (
              <Select id={id} value={f.period} onChange={set('period')}>
                {Object.entries(PERIOD_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Format">
            {(id) => (
              <Select id={id} value={f.format} onChange={set('format')}>
                <option value="pdf">PDF</option>
                <option value="csv">CSV</option>
              </Select>
            )}
          </Field>
          <Field label="Send">
            {(id) => (
              <Select id={id} value={f.frequency} onChange={set('frequency')}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-2">
            {f.frequency === 'weekly' && (
              <Field label="On">
                {(id) => (
                  <Select id={id} value={f.weekday} onChange={set('weekday')}>
                    {WEEKDAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {f.frequency === 'monthly' && <Field label="Day">{(id) => <Input id={id} type="number" min={1} max={28} value={f.dayOfMonth} onChange={set('dayOfMonth')} />}</Field>}
            <Field label="Hour">{(id) => <Input id={id} type="number" min={0} max={23} value={f.hour} onChange={set('hour')} />}</Field>
          </div>
          <Field label="Email channel">
            {(id) => (
              <Select id={id} value={f.channelId} onChange={set('channelId')} required>
                <option value="">Choose…</option>
                {email.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Recipients" hint="Comma-separated email addresses">
            {(id, d) => <Input id={id} aria-describedby={d} value={f.recipients} onChange={set('recipients')} required />}
          </Field>
        </div>
        {channels.data && !email.length && <p className="text-[13px] text-warn">Add an email channel under Monitoring & Alerts → Notifications first.</p>}
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF((x) => ({ ...x, enabled: e.target.checked }))} /> Enabled
        </label>
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

function Schedules({ types }: { types: { key: string; label: string }[] }) {
  const { can } = useAuth();
  const manage = can('alerts.manage');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['reports', 'schedules'], queryFn: () => api.get<ScheduleT[]>('/reports/schedules'), refetchInterval: 30_000 });
  const [edit, setEdit] = useState<ScheduleT | 'new' | null>(null);
  const [del, setDel] = useState<ScheduleT | null>(null);
  const run = useMutation({ mutationFn: (id: string) => api.post(`/reports/schedules/${id}/run`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['reports', 'schedules'] }) });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/reports/schedules/${id}`),
    onSuccess: () => {
      setDel(null);
      void qc.invalidateQueries({ queryKey: ['reports', 'schedules'] });
    },
  });
  const when = (s: ScheduleT) => `${s.frequency === 'daily' ? 'Daily' : s.frequency === 'weekly' ? `${WEEKDAYS[s.weekday ?? 1]}s` : `Monthly on day ${s.dayOfMonth}`} at ${String(s.hour).padStart(2, '0')}:00`;
  return (
    <Panel
      title="Scheduled reports"
      className="mt-4"
      flush
      actions={
        manage && (
          <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
            Schedule
          </Button>
        )
      }
    >
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error ?? run.error} className="m-4" />
      {q.data && !q.data.length && <EmptyState title="No schedules">Email a report to finance or customers' account managers every month.</EmptyState>}
      {!!q.data?.length && (
        <Table label="Report schedules">
          <thead>
            <tr>
              <th>Name</th>
              <th>Report</th>
              <th>When</th>
              <th>Recipients</th>
              <th>Last sent</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((s) => (
              <tr key={s.id}>
                <td className="font-medium">
                  {s.name} {!s.enabled && <Chip>disabled</Chip>}
                </td>
                <td className="text-[12.5px]">
                  {REPORT_LABELS[s.type]} · {PERIOD_LABEL[s.period]} · {s.format.toUpperCase()}
                </td>
                <td className="text-[12.5px]">
                  {when(s)}
                  <div className="text-ink-3">next {formatDateTime(s.nextRunAt)}</div>
                </td>
                <td className="text-[12.5px]">{s.recipients.join(', ')}</td>
                <td className="text-[12.5px]">
                  {s.lastRunAt ? (
                    <span title={s.lastError ?? ''}>
                      <Chip tone={s.lastStatus === 'sent' ? 'ok' : 'crit'}>{s.lastStatus}</Chip> {relativeTime(s.lastRunAt)}
                    </span>
                  ) : (
                    'Never'
                  )}
                </td>
                <td className="text-right whitespace-nowrap">
                  {manage && (
                    <>
                      <Button size="sm" variant="ghost" busy={run.isPending && run.variables === s.id} onClick={() => run.mutate(s.id)}>
                        Send now
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDel(s)}>
                        Delete
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit && <ScheduleDialog current={edit === 'new' ? null : edit} types={types} onClose={() => setEdit(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete ${del?.name}?`} body="No further emails are sent for this schedule." confirmLabel="Delete schedule" busy={remove.isPending} error={remove.error} onConfirm={() => del && remove.mutate(del.id)} />
    </Panel>
  );
}

export function ReportsPage() {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const meta = useQuery({ queryKey: ['reports', 'types'], queryFn: () => api.get<{ types: { key: string; label: string }[]; periods: string[] }>('/reports/types') });
  const [type, setType] = useState<string>('energy');
  const [period, setPeriod] = useState('last_month');
  const q = useQuery({ queryKey: ['reports', type, period], queryFn: () => api.get<ReportT>(`/reports${qs({ type, period, format: 'json' })}`) });
  const r = q.data;
  const href = (format: 'csv' | 'pdf') => `/api/v1/reports${qs({ type, period, format })}`;
  return (
    <>
      <PageHeader
        title="Reports & analytics"
        description={staff ? 'Built from collected data only: measured and estimated energy are always shown apart, and bandwidth uses measured 5-minute samples with their coverage.' : 'Reports for your account, built from measured data (estimates are labelled).'}
        actions={
          <>
            <a href={href('csv')} download className="inline-flex h-9 items-center rounded-lg border border-rule-strong bg-field px-3.5 font-medium hover:bg-panel">
              Download CSV
            </a>
            <a href={href('pdf')} download className="inline-flex h-9 items-center rounded-lg border border-rule-strong bg-field px-3.5 font-medium hover:bg-panel">
              Download PDF
            </a>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Report" value={type} onChange={(e) => setType(e.target.value)} className="w-80">
          {(meta.data?.types ?? []).map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} className="w-44" disabled={SNAPSHOT.includes(type)}>
          {Object.entries(PERIOD_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      <Panel
        title={r ? r.title : 'Report'}
        flush
        actions={r && <span className="text-[12.5px] text-ink-3">{SNAPSHOT.includes(type) ? `Snapshot ${formatDateTime(r.generatedAt)}` : `${formatDateTime(r.period.from)} → ${formatDateTime(r.period.to)} (${r.period.timezone})`}</span>}
      >
        {q.isLoading && <Loading />}
        <ErrorNote error={q.error} className="m-4" />
        {r && (
          <>
            <ul className="list-disc space-y-0.5 px-4 pt-3 pl-8 text-[12.5px] text-ink-2">
              {r.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            {!r.rows.length ? (
              <EmptyState title="No data for this period" />
            ) : (
              <Table label={r.title}>
                <thead>
                  <tr>
                    {r.columns.map((c) => (
                      <th key={c.key} className={c.numeric ? 'text-right' : ''}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row, i) => (
                    <tr key={i}>
                      {r.columns.map((c) => (
                        <td key={c.key} className={c.numeric ? 'text-right tabular-nums' : ''}>
                          {cell(c, row[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </>
        )}
      </Panel>
      {staff && meta.data && <Schedules types={meta.data.types} />}
    </>
  );
}
