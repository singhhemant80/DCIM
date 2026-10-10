import { useEffect, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ALERT_METRICS,
  ALERT_METRIC_LABELS,
  ALERT_SCOPES,
  ALERT_SCOPE_LABELS,
  ALERT_SEVERITIES,
  CHANNEL_KINDS,
  CHANNEL_KIND_LABELS,
  CREDENTIAL_KIND_LABELS,
  POLL_KINDS,
  STATE_METRICS,
  formatBitRate,
  type AlertMetric,
  type ChannelKind,
  type CredentialKind,
} from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import type { NetworkDeviceT } from '../lib/network';
import { useMonitoringStream, type AlertSummaryT, type PortRateT } from '../lib/monitoring';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Stat, Table, Textarea, cx } from '../components/ui';
import { Tabs } from './Network';

const TABS = [
  { key: 'alerts', label: 'Alerts' },
  { key: 'rules', label: 'Rules' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'channels', label: 'Notifications' },
  { key: 'polling', label: 'Polling' },
  { key: 'retention', label: 'Data retention' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const SEV_TONE = { critical: 'crit', warning: 'warn', info: 'accent' } as const;
type Sev = keyof typeof SEV_TONE;

interface AlertT {
  id: string;
  ruleId: string | null;
  ruleName: string;
  metric: AlertMetric;
  severity: Sev;
  status: 'firing' | 'resolved';
  message: string;
  deviceId: string | null;
  deviceName: string | null;
  interfaceId: string | null;
  interfaceName: string | null;
  startedAt: string;
  resolvedAt: string | null;
  lastValue: number | null;
  peakValue: number | null;
  suppressed: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  ackNote: string | null;
}

interface RuleT {
  id: string;
  name: string;
  enabled: boolean;
  metric: AlertMetric;
  comparator: 'gt' | 'lt';
  threshold: number;
  forSeconds: number;
  minSamples: number;
  clearSamples: number;
  severity: Sev;
  scope: (typeof ALERT_SCOPES)[number];
  datacenterId: string | null;
  deviceIds: string[];
  interfaceIds: string[];
  channelIds: string[];
  notifyOnResolve: boolean;
}

interface MaintenanceT {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  scope: 'all' | 'datacenter' | 'devices';
  datacenterId: string | null;
  deviceIds: string[];
  notes: string | null;
  createdBy: string | null;
}

interface ChannelT {
  id: string;
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  config: Record<string, unknown>;
  secretConfigured: true;
  lastSentAt: string | null;
  lastError: string | null;
}

interface DeliveryT {
  id: string;
  channelId: string;
  channelName: string;
  alertId: string | null;
  event: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface PollingT {
  deviceId: string;
  deviceName: string;
  platform: string | null;
  configured: boolean;
  enabled: boolean;
  credentialKind: CredentialKind | null;
  intervalSeconds: number | null;
  lastPollAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastDurationMs: number | null;
  lastMatched: number | null;
  lastReported: number | null;
  credentialKinds: CredentialKind[];
  monitoredPorts: number;
}

interface DatacenterT {
  id: string;
  name: string;
  code: string;
}

const duration = (from: string, to?: string | null) => {
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} d`;
};
const isBps = (m: AlertMetric) => m === 'in_bps' || m === 'out_bps';
const fmtValue = (m: AlertMetric, v: number | null) => (v === null ? '—' : m.startsWith('util_') ? `${v.toFixed(1)}%` : isBps(m) ? formatBitRate(v) : STATE_METRICS.includes(m) ? String(v) : `${v.toFixed(2)}/s`);
const localInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/* ------------------------------------------------------------------ alerts */

function AlertsTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'firing' | 'resolved' | 'all'>('firing');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const [ack, setAck] = useState<AlertT | null>(null);
  const [note, setNote] = useState('');
  const stream = useMonitoringStream();
  const list = useQuery({
    queryKey: ['alerts', 'list', status, severity, page],
    queryFn: () => api.get<Paginated<AlertT>>(`/alerts${qs({ status, severity, page, pageSize: 50 })}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (stream.lastAlertAt) void qc.invalidateQueries({ queryKey: ['alerts'] });
  }, [stream.lastAlertAt, qc]);
  const doAck = useMutation({
    mutationFn: () => api.post(`/alerts/${ack!.id}/ack`, { note: note || undefined }),
    onSuccess: () => {
      setAck(null);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['alerts'] });
    },
  });
  return (
    <Panel
      flush
      title="Alerts"
      actions={
        <div className="flex gap-2">
          <Select className="w-32" value={status} onChange={(e) => (setStatus(e.target.value as typeof status), setPage(1))} aria-label="Status">
            <option value="firing">Firing</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </Select>
          <Select className="w-32" value={severity} onChange={(e) => (setSeverity(e.target.value), setPage(1))} aria-label="Severity">
            <option value="">Any severity</option>
            {ALERT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </div>
      }
    >
      <p className="border-b border-rule px-4 py-2.5 text-[13px] text-ink-2">Alerts record and notify only. Nothing here shuts a port, changes a route or otherwise acts on a device.</p>
      <ErrorNote error={list.error} className="m-4" />
      {list.isLoading && <Loading />}
      {list.data?.total === 0 && <EmptyState title={status === 'firing' ? 'Nothing is firing' : 'No alerts'}>{status === 'firing' ? 'All monitored ports and devices are within their rules.' : 'Alerts appear here once a rule has fired.'}</EmptyState>}
      {!!list.data?.items.length && (
        <Table label="Alerts">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Alert</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Value (peak)</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((a) => (
              <tr key={a.id}>
                <td>
                  <Chip tone={SEV_TONE[a.severity]}>{a.severity}</Chip>
                </td>
                <td>
                  <span className="font-medium">{a.ruleName}</span>
                  <span className="block text-[13px] text-ink-2">{a.message}</span>
                  {a.interfaceId && (
                    <Link to={`/network-monitoring?port=${a.interfaceId}`} className="text-[12.5px] text-accent hover:underline">
                      Traffic chart
                    </Link>
                  )}
                </td>
                <td className="text-[13px] whitespace-nowrap" title={formatDateTime(a.startedAt)}>
                  {relativeTime(a.startedAt)}
                </td>
                <td className="text-[13px]">{duration(a.startedAt, a.resolvedAt)}</td>
                <td className="text-[13px] tabular-nums">
                  {fmtValue(a.metric, a.lastValue)}
                  {a.peakValue !== null && a.peakValue !== a.lastValue && <span className="text-ink-3"> ({fmtValue(a.metric, a.peakValue)})</span>}
                </td>
                <td className="text-[13px]">
                  <div className="flex flex-wrap gap-1">
                    {a.status === 'firing' ? <Chip tone="crit">Firing</Chip> : <Chip tone="ok">Resolved {a.resolvedAt && relativeTime(a.resolvedAt)}</Chip>}
                    {a.suppressed && (
                      <Chip tone="neutral" title="Raised during a maintenance window: no notification was sent">
                        Maintenance
                      </Chip>
                    )}
                  </div>
                  {a.acknowledgedAt && (
                    <span className="mt-1 block text-[12px] text-ink-3" title={a.ackNote ?? undefined}>
                      Acknowledged by {a.acknowledgedBy} {relativeTime(a.acknowledgedAt)}
                      {a.ackNote && `: ${a.ackNote}`}
                    </span>
                  )}
                </td>
                <td className="text-right">
                  {can('alerts.manage') && a.status === 'firing' && !a.acknowledgedAt && (
                    <Button size="sm" variant="ghost" onClick={() => setAck(a)}>
                      Acknowledge
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {list.data && list.data.total > list.data.pageSize && (
        <div className="border-t border-rule px-4 py-2">
          <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
        </div>
      )}
      <Modal open={!!ack} onOpenChange={(o) => !o && setAck(null)} title="Acknowledge alert" description="Shows the team that someone is handling it. It stays open until the condition clears.">
        <Field label="Note (optional)">{(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
        <ErrorNote error={doAck.error} className="mt-3" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setAck(null)}>
            Cancel
          </Button>
          <Button variant="primary" busy={doAck.isPending} onClick={() => doAck.mutate()}>
            Acknowledge
          </Button>
        </div>
      </Modal>
    </Panel>
  );
}

/* ------------------------------------------------------------------ pickers */

function DevicePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const devices = useQuery({ queryKey: ['network', 'devices', 'all'], queryFn: () => api.get<NetworkDeviceT[]>('/network/devices?all=true') });
  const [f, setF] = useState('');
  const list = (devices.data ?? []).filter((d) => `${d.hostname ?? ''} ${d.assetTag}`.toLowerCase().includes(f.toLowerCase()));
  return (
    <div className="rounded-lg border border-rule-strong">
      <Input className="rounded-b-none border-0 border-b" placeholder="Filter devices" value={f} onChange={(e) => setF(e.target.value)} aria-label="Filter devices" />
      <div className="max-h-44 overflow-y-auto p-2 text-[13px]">
        {devices.isLoading && <Loading />}
        {list.map((d) => (
          <label key={d.id} className="flex items-center gap-2 py-0.5">
            <input type="checkbox" checked={value.includes(d.id)} onChange={(e) => onChange(e.target.checked ? [...value, d.id] : value.filter((x) => x !== d.id))} />
            {d.hostname || d.assetTag} <span className="text-ink-3">{d.assetTag}</span>
          </label>
        ))}
      </div>
      <p className="border-t border-rule px-2 py-1 text-[12px] text-ink-3">{value.length} selected</p>
    </div>
  );
}

function PortPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [f, setF] = useState('');
  const ports = useQuery({ queryKey: ['monitoring', 'ports', 'picker', f], queryFn: () => api.get<Paginated<PortRateT>>(`/monitoring/ports${qs({ q: f, sort: 'name', pageSize: 100 })}`), placeholderData: keepPreviousData });
  return (
    <div className="rounded-lg border border-rule-strong">
      <Input className="rounded-b-none border-0 border-b" placeholder="Search monitored ports" value={f} onChange={(e) => setF(e.target.value)} aria-label="Search ports" />
      <div className="max-h-44 overflow-y-auto p-2 text-[13px]">
        {ports.data?.items.map((p) => (
          <label key={p.interfaceId} className="flex items-center gap-2 py-0.5">
            <input type="checkbox" checked={value.includes(p.interfaceId)} onChange={(e) => onChange(e.target.checked ? [...value, p.interfaceId] : value.filter((x) => x !== p.interfaceId))} />
            {p.deviceName} <span className="font-mono">{p.name}</span>
          </label>
        ))}
        {ports.data?.total === 0 && <p className="text-ink-3">No monitored ports match.</p>}
      </div>
      <p className="border-t border-rule px-2 py-1 text-[12px] text-ink-3">{value.length} selected (only monitored ports are listed)</p>
    </div>
  );
}

function DatacenterSelect({ value, onChange }: { value: string | null; onChange: (v: string) => void }) {
  const dcs = useQuery({ queryKey: ['dcim', 'datacenters'], queryFn: () => api.get<DatacenterT[]>('/dcim/datacenters') });
  return (
    <Select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label="Datacenter">
      <option value="">Choose…</option>
      {dcs.data?.map((d) => (
        <option key={d.id} value={d.id}>
          {d.code} — {d.name}
        </option>
      ))}
    </Select>
  );
}

/* ------------------------------------------------------------------ rules */

const BLANK_RULE: Omit<RuleT, 'id'> = { name: '', enabled: true, metric: 'util_max', comparator: 'gt', threshold: 80, forSeconds: 300, minSamples: 3, clearSamples: 2, severity: 'warning', scope: 'totals', datacenterId: null, deviceIds: [], interfaceIds: [], channelIds: [], notifyOnResolve: true };

function RuleForm({ rule, onDone }: { rule: RuleT | 'new'; onDone: () => void }) {
  const qc = useQueryClient();
  const [r, setR] = useState<Omit<RuleT, 'id'>>(rule === 'new' ? BLANK_RULE : rule);
  const [mbps, setMbps] = useState(rule !== 'new' && isBps(rule.metric) ? String(rule.threshold / 1e6) : '1000');
  const channels = useQuery({ queryKey: ['alerts', 'channels'], queryFn: () => api.get<ChannelT[]>('/alerts/channels') });
  const set = <K extends keyof typeof r>(k: K, v: (typeof r)[K]) => setR((x) => ({ ...x, [k]: v }));
  const stateMetric = STATE_METRICS.includes(r.metric);
  const deviceMetric = r.metric === 'device_unreachable';
  const save = useMutation({
    mutationFn: () => {
      const body = { ...r, threshold: isBps(r.metric) ? Number(mbps) * 1e6 : stateMetric ? 0 : r.threshold, datacenterId: r.scope === 'datacenter' ? r.datacenterId : null };
      return rule === 'new' ? api.post('/alerts/rules', body) : api.put(`/alerts/rules/${rule.id}`, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      onDone();
    },
  });
  const scopes = ALERT_SCOPES.filter((s) => !deviceMetric || (s !== 'interfaces' && s !== 'totals'));
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name">{(id) => <Input id={id} required value={r.name} onChange={(e) => set('name', e.target.value)} maxLength={120} />}</Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Metric">
          {(id) => (
            <Select
              id={id}
              value={r.metric}
              onChange={(e) => {
                const m = e.target.value as AlertMetric;
                setR((x) => ({ ...x, metric: m, scope: m === 'device_unreachable' && (x.scope === 'interfaces' || x.scope === 'totals') ? 'all' : x.scope }));
              }}
            >
              {ALERT_METRICS.map((m) => (
                <option key={m} value={m}>
                  {ALERT_METRIC_LABELS[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Severity">
          {(id) => (
            <Select id={id} value={r.severity} onChange={(e) => set('severity', e.target.value as Sev)}>
              {ALERT_SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {!stateMetric && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Condition">
            {(id) => (
              <Select id={id} value={r.comparator} onChange={(e) => set('comparator', e.target.value as 'gt' | 'lt')}>
                <option value="gt">Above</option>
                <option value="lt">Below</option>
              </Select>
            )}
          </Field>
          {isBps(r.metric) ? (
            <Field label="Threshold (Mbit/s)" hint={formatBitRate(Number(mbps) * 1e6)}>
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} step="any" required value={mbps} onChange={(e) => setMbps(e.target.value)} />}
            </Field>
          ) : (
            <Field label={r.metric.startsWith('util_') ? 'Threshold (%)' : 'Threshold (per second)'}>{(id) => <Input id={id} type="number" min={0} max={r.metric.startsWith('util_') ? 100 : undefined} step="any" required value={r.threshold} onChange={(e) => set('threshold', Number(e.target.value))} />}</Field>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="For at least (seconds)" hint="Condition must hold this long…">
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} max={86400} value={r.forSeconds} onChange={(e) => set('forSeconds', Number(e.target.value))} />}
        </Field>
        <Field label="Consecutive samples" hint="…and for this many polls in a row">
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={60} value={r.minSamples} onChange={(e) => set('minSamples', Number(e.target.value))} />}
        </Field>
        <Field label="Good samples to resolve" hint="Avoids flapping">
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={60} value={r.clearSamples} onChange={(e) => set('clearSamples', Number(e.target.value))} />}
        </Field>
      </div>
      <Field label="Applies to">
        {(id) => (
          <Select id={id} value={r.scope} onChange={(e) => set('scope', e.target.value as RuleT['scope'])}>
            {scopes.map((s) => (
              <option key={s} value={s}>
                {deviceMetric && s === 'all' ? 'Every polled device' : deviceMetric && s === 'devices' ? 'Selected devices' : deviceMetric && s === 'datacenter' ? 'Devices in one datacenter' : ALERT_SCOPE_LABELS[s]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {r.scope === 'datacenter' && <DatacenterSelect value={r.datacenterId} onChange={(v) => set('datacenterId', v || null)} />}
      {r.scope === 'devices' && <DevicePicker value={r.deviceIds} onChange={(v) => set('deviceIds', v)} />}
      {r.scope === 'interfaces' && <PortPicker value={r.interfaceIds} onChange={(v) => set('interfaceIds', v)} />}
      <div>
        <p className="mb-1 text-[13px] font-medium text-ink-2">Notify</p>
        {channels.data?.length === 0 && <p className="text-[13px] text-ink-3">No notification channels yet. Alerts will still be listed here.</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          {channels.data?.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5">
              <input type="checkbox" checked={r.channelIds.includes(c.id)} onChange={(e) => set('channelIds', e.target.checked ? [...r.channelIds, c.id] : r.channelIds.filter((x) => x !== c.id))} />
              {c.name} <span className="text-ink-3">({CHANNEL_KIND_LABELS[c.kind]})</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={r.notifyOnResolve} onChange={(e) => set('notifyOnResolve', e.target.checked)} /> Also notify when resolved
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={r.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled
        </label>
      </div>
      {rule !== 'new' && <p className="text-[12.5px] text-ink-3">Saving closes this rule's open alerts and restarts its evaluation with the new settings.</p>}
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save rule
        </Button>
      </div>
    </form>
  );
}

function RulesTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('alerts.manage');
  const rules = useQuery({ queryKey: ['alerts', 'rules'], queryFn: () => api.get<RuleT[]>('/alerts/rules') });
  const [edit, setEdit] = useState<RuleT | 'new' | null>(null);
  const [del, setDel] = useState<RuleT | null>(null);
  const remove = useMutation({ mutationFn: () => api.delete(`/alerts/rules/${del!.id}`), onSuccess: () => (setDel(null), qc.invalidateQueries({ queryKey: ['alerts'] })) });
  const condition = (r: RuleT) => {
    if (r.metric === 'oper_down') return 'Port is down';
    if (r.metric === 'device_unreachable') return 'Polls fail';
    return `${ALERT_METRIC_LABELS[r.metric].replace(/ \(.*\)$/, '')} ${r.comparator === 'gt' ? '>' : '<'} ${fmtValue(r.metric, r.threshold)}`;
  };
  return (
    <Panel
      flush
      title="Alert rules"
      actions={
        manage && (
          <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
            Add rule
          </Button>
        )
      }
    >
      <ErrorNote error={rules.error} className="m-4" />
      {rules.isLoading && <Loading />}
      {rules.data?.length === 0 && <EmptyState title="No rules">Start with one for uplink utilization (for example above 80 % for 5 minutes) and one for ports going down.</EmptyState>}
      {!!rules.data?.length && (
        <Table label="Alert rules">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Condition</th>
              <th>Timing</th>
              <th>Applies to</th>
              <th>Notify</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.data.map((r) => (
              <tr key={r.id} className={cx(!r.enabled && 'opacity-60')}>
                <td>
                  <span className="font-medium">{r.name}</span> <Chip tone={SEV_TONE[r.severity]}>{r.severity}</Chip>
                  {!r.enabled && <Chip>Disabled</Chip>}
                </td>
                <td className="text-[13px]">{condition(r)}</td>
                <td className="text-[13px]">
                  ≥ {r.forSeconds} s and {r.minSamples} sample{r.minSamples === 1 ? '' : 's'}; clears after {r.clearSamples}
                </td>
                <td className="text-[13px]">{r.scope === 'devices' ? `${r.deviceIds.length} device(s)` : r.scope === 'interfaces' ? `${r.interfaceIds.length} port(s)` : ALERT_SCOPE_LABELS[r.scope]}</td>
                <td className="text-[13px]">{r.channelIds.length ? `${r.channelIds.length} channel(s)` : <span className="text-ink-3">List only</span>}</td>
                <td className="text-right whitespace-nowrap">
                  {manage && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(r)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDel(r)}>
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
      <Modal open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit === 'new' ? 'New alert rule' : 'Edit alert rule'} wide>
        {edit && <RuleForm rule={edit} onDone={() => setEdit(null)} />}
      </Modal>
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete rule" body={<>Delete “{del?.name}”? Its open alerts are closed; past alerts stay in the history.</>} confirmLabel="Delete rule" onConfirm={() => remove.mutate()} busy={remove.isPending} error={remove.error} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ maintenance */

function MaintenanceForm({ win, onDone }: { win: MaintenanceT | 'new'; onDone: () => void }) {
  const qc = useQueryClient();
  const start = win === 'new' ? new Date(Date.now() + 15 * 60000).toISOString() : win.startsAt;
  const end = win === 'new' ? new Date(Date.now() + 2 * 3600000).toISOString() : win.endsAt;
  const [m, setM] = useState({ name: win === 'new' ? '' : win.name, startsAt: localInput(start), endsAt: localInput(end), scope: win === 'new' ? ('devices' as const) : win.scope, datacenterId: win === 'new' ? null : win.datacenterId, deviceIds: win === 'new' ? [] : win.deviceIds, notes: win === 'new' ? '' : (win.notes ?? '') });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...m, startsAt: new Date(m.startsAt).toISOString(), endsAt: new Date(m.endsAt).toISOString(), notes: m.notes || null };
      return win === 'new' ? api.post('/alerts/maintenance', body) : api.put(`/alerts/maintenance/${win.id}`, body);
    },
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ['alerts', 'maintenance'] }), onDone()),
  });
  return (
    <form className="grid gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <Field label="Name">{(id) => <Input id={id} required value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} maxLength={120} />}</Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts">{(id) => <Input id={id} type="datetime-local" required value={m.startsAt} onChange={(e) => setM({ ...m, startsAt: e.target.value })} />}</Field>
        <Field label="Ends" hint="At most 31 days">
          {(id, d) => <Input id={id} aria-describedby={d} type="datetime-local" required value={m.endsAt} onChange={(e) => setM({ ...m, endsAt: e.target.value })} />}
        </Field>
      </div>
      <Field label="Covers">
        {(id) => (
          <Select id={id} value={m.scope} onChange={(e) => setM({ ...m, scope: e.target.value as typeof m.scope })}>
            <option value="devices">Selected devices</option>
            <option value="datacenter">Everything in one datacenter</option>
            <option value="all">Everything</option>
          </Select>
        )}
      </Field>
      {m.scope === 'datacenter' && <DatacenterSelect value={m.datacenterId} onChange={(v) => setM({ ...m, datacenterId: v || null })} />}
      {m.scope === 'devices' && <DevicePicker value={m.deviceIds} onChange={(v) => setM({ ...m, deviceIds: v })} />}
      <Field label="Notes">{(id) => <Textarea id={id} value={m.notes} onChange={(e) => setM({ ...m, notes: e.target.value })} maxLength={2000} />}</Field>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save window
        </Button>
      </div>
    </form>
  );
}

function MaintenanceTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('alerts.manage');
  const list = useQuery({ queryKey: ['alerts', 'maintenance'], queryFn: () => api.get<MaintenanceT[]>('/alerts/maintenance') });
  const [edit, setEdit] = useState<MaintenanceT | 'new' | null>(null);
  const [del, setDel] = useState<MaintenanceT | null>(null);
  const remove = useMutation({ mutationFn: () => api.delete(`/alerts/maintenance/${del!.id}`), onSuccess: () => (setDel(null), qc.invalidateQueries({ queryKey: ['alerts', 'maintenance'] })) });
  const now = Date.now();
  return (
    <Panel
      flush
      title="Maintenance windows"
      actions={
        manage && (
          <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
            Schedule window
          </Button>
        )
      }
    >
      <p className="border-b border-rule px-4 py-2.5 text-[13px] text-ink-2">During a window, alerts on the covered devices are still recorded but no notifications are sent. If a problem is still there when the window ends, it is notified then.</p>
      <ErrorNote error={list.error} className="m-4" />
      {list.isLoading && <Loading />}
      {list.data?.length === 0 && <EmptyState title="No maintenance scheduled" />}
      {!!list.data?.length && (
        <Table label="Maintenance windows">
          <thead>
            <tr>
              <th>Name</th>
              <th>When</th>
              <th>Covers</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((w) => {
              const s = new Date(w.startsAt).getTime();
              const e = new Date(w.endsAt).getTime();
              return (
                <tr key={w.id}>
                  <td>
                    <span className="font-medium">{w.name}</span>
                    {w.notes && <span className="block max-w-[40ch] truncate text-[12.5px] text-ink-3">{w.notes}</span>}
                  </td>
                  <td className="text-[13px]">
                    {formatDateTime(w.startsAt)} → {formatDateTime(w.endsAt)}
                  </td>
                  <td className="text-[13px]">{w.scope === 'all' ? 'Everything' : w.scope === 'datacenter' ? 'One datacenter' : `${w.deviceIds.length} device(s)`}</td>
                  <td>{now < s ? <Chip tone="accent">Scheduled</Chip> : now < e ? <Chip tone="warn">In progress</Chip> : <Chip>Ended</Chip>}</td>
                  <td className="text-right whitespace-nowrap">
                    {manage && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEdit(w)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDel(w)}>
                          Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <Modal open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit === 'new' ? 'Schedule maintenance' : 'Edit maintenance window'} wide>
        {edit && <MaintenanceForm win={edit} onDone={() => setEdit(null)} />}
      </Modal>
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete maintenance window" body={<>Delete “{del?.name}”? Notifications resume immediately for the covered devices.</>} confirmLabel="Delete" onConfirm={() => remove.mutate()} busy={remove.isPending} error={remove.error} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ channels */

function ChannelForm({ channel, onDone }: { channel: ChannelT | 'new'; onDone: () => void }) {
  const qc = useQueryClient();
  const c = channel === 'new' ? null : channel;
  const cfg = (k: string, d = '') => (c?.config[k] as string | undefined) ?? d;
  const [kind, setKind] = useState<ChannelKind>(c?.kind ?? 'webhook');
  const [v, setV] = useState<Record<string, string>>({
    name: c?.name ?? '',
    to: ((c?.config.to as string[] | undefined) ?? []).join(', '),
    from: cfg('from'),
    smtpHost: cfg('smtpHost'),
    smtpPort: String(c?.config.smtpPort ?? 587),
    smtpSecurity: cfg('smtpSecurity', 'starttls'),
    smtpUser: cfg('smtpUser'),
    smtpPassword: '',
    url: cfg('url'),
    signingSecret: '',
    webhookUrl: '',
    botToken: '',
    chatId: cfg('chatId'),
  });
  const [enabled, setEnabled] = useState(c?.enabled ?? true);
  const set = (k: string) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const base = { kind, name: v.name, enabled };
      const body =
        kind === 'email'
          ? { ...base, to: v.to!.split(/[,\s]+/).filter(Boolean), from: v.from, smtpHost: v.smtpHost, smtpPort: Number(v.smtpPort), smtpSecurity: v.smtpSecurity, smtpUser: v.smtpUser || null, smtpPassword: v.smtpPassword || null }
          : kind === 'webhook'
            ? { ...base, url: v.url, signingSecret: v.signingSecret }
            : kind === 'slack'
              ? { ...base, webhookUrl: v.webhookUrl }
              : { ...base, botToken: v.botToken, chatId: v.chatId };
      return c ? api.put(`/alerts/channels/${c.id}`, body) : api.post('/alerts/channels', body);
    },
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ['alerts', 'channels'] }), onDone()),
  });
  const secretHint = c ? 'Stored encrypted and never shown. Enter it again to save changes.' : 'Stored encrypted; it can’t be viewed again.';
  const field = (label: string, k: string, props: Record<string, unknown> = {}, hint?: ReactNode) => <Field label={label} hint={hint}>{(id, d) => <Input id={id} aria-describedby={d} value={v[k]} onChange={set(k)} {...props} />}</Field>;
  return (
    <form className="grid gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <div className="grid gap-3 sm:grid-cols-2">
        {field('Name', 'name', { required: true, maxLength: 80 })}
        <Field label="Type">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as ChannelKind)}>
              {CHANNEL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CHANNEL_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {kind === 'email' && (
        <>
          {field('Recipients', 'to', { required: true, placeholder: 'noc@example.net, oncall@example.net' })}
          {field('From address', 'from', { required: true, type: 'email' })}
          <div className="grid gap-3 sm:grid-cols-3">
            {field('SMTP server', 'smtpHost', { required: true })}
            {field('Port', 'smtpPort', { type: 'number', min: 1, max: 65535, required: true })}
            <Field label="Security">
              {(id) => (
                <Select id={id} value={v.smtpSecurity} onChange={set('smtpSecurity')}>
                  <option value="starttls">STARTTLS (587)</option>
                  <option value="tls">TLS (465)</option>
                  <option value="none">None (lab only)</option>
                </Select>
              )}
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field('SMTP user', 'smtpUser', { autoComplete: 'off' })}
            {field('SMTP password', 'smtpPassword', { type: 'password', autoComplete: 'new-password' }, secretHint)}
          </div>
        </>
      )}
      {kind === 'webhook' && (
        <>
          {field('URL', 'url', { required: true, type: 'url', placeholder: 'https://example.net/hooks/dcim' })}
          {field('Signing secret', 'signingSecret', { required: true, type: 'password', minLength: 8, autoComplete: 'new-password' }, <>Requests carry <code>X-CDCIM-Signature: sha256=HMAC(secret, timestamp + "." + body)</code> and <code>X-CDCIM-Timestamp</code>. {secretHint}</>)}
        </>
      )}
      {kind === 'slack' && field('Incoming webhook URL', 'webhookUrl', { required: true, type: 'password', autoComplete: 'off', placeholder: 'https://hooks.slack.com/services/…' }, `The URL is the secret. ${secretHint}`)}
      {kind === 'telegram' && (
        <div className="grid gap-3 sm:grid-cols-2">
          {field('Bot token', 'botToken', { required: true, type: 'password', autoComplete: 'off' }, secretHint)}
          {field('Chat id', 'chatId', { required: true, placeholder: '-1001234567890 or @channel' })}
        </div>
      )}
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
      </label>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save channel
        </Button>
      </div>
    </form>
  );
}

function ChannelsTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('monitoring.configure');
  const channels = useQuery({ queryKey: ['alerts', 'channels'], queryFn: () => api.get<ChannelT[]>('/alerts/channels') });
  const deliveries = useQuery({ queryKey: ['alerts', 'deliveries'], queryFn: () => api.get<DeliveryT[]>('/alerts/notifications') });
  const pending = deliveries.data?.some((d) => d.status === 'pending');
  useEffect(() => {
    if (!pending) return;
    const h = setInterval(() => void qc.invalidateQueries({ queryKey: ['alerts', 'deliveries'] }), 3000);
    return () => clearInterval(h);
  }, [pending, qc]);
  const [edit, setEdit] = useState<ChannelT | 'new' | null>(null);
  const [del, setDel] = useState<ChannelT | null>(null);
  const test = useMutation({ mutationFn: (id: string) => api.post(`/alerts/channels/${id}/test`), onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }) });
  const remove = useMutation({ mutationFn: () => api.delete(`/alerts/channels/${del!.id}`), onSuccess: () => (setDel(null), qc.invalidateQueries({ queryKey: ['alerts'] })) });
  const where = (c: ChannelT) => (c.kind === 'email' ? (c.config.to as string[]).join(', ') : c.kind === 'webhook' ? String(c.config.url) : c.kind === 'telegram' ? `chat ${String(c.config.chatId)}` : 'Slack webhook');
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Panel
        flush
        title="Notification channels"
        actions={
          manage && (
            <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
              Add channel
            </Button>
          )
        }
      >
        <ErrorNote error={channels.error ?? test.error} className="m-4" />
        {channels.isLoading && <Loading />}
        {channels.data?.length === 0 && <EmptyState title="No channels">Add email, a signed webhook, Slack or Telegram, then pick it in a rule.</EmptyState>}
        {!!channels.data?.length && (
          <Table label="Notification channels">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Destination</th>
                <th>Last delivery</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {channels.data.map((c) => (
                <tr key={c.id} className={cx(!c.enabled && 'opacity-60')}>
                  <td className="font-medium">
                    {c.name} {!c.enabled && <Chip>Disabled</Chip>}
                  </td>
                  <td className="text-[13px]">{CHANNEL_KIND_LABELS[c.kind]}</td>
                  <td className="max-w-[32ch] truncate text-[13px]">{where(c)}</td>
                  <td className="text-[13px]">{c.lastError ? <span className="text-crit">Failed: {c.lastError}</span> : c.lastSentAt ? <span className="text-ok">Sent {relativeTime(c.lastSentAt)}</span> : <span className="text-ink-3">Never</span>}</td>
                  <td className="text-right whitespace-nowrap">
                    {manage && (
                      <>
                        <Button size="sm" variant="ghost" busy={test.isPending && test.variables === c.id} onClick={() => test.mutate(c.id)}>
                          Send test
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEdit(c)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDel(c)}>
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
      </Panel>
      <Panel flush title="Recent deliveries">
        {deliveries.data?.length === 0 && <EmptyState title="Nothing sent yet" />}
        {!!deliveries.data?.length && (
          <Table label="Recent deliveries">
            <thead>
              <tr>
                <th>When</th>
                <th>Channel</th>
                <th>Event</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.data.slice(0, 30).map((d) => (
                <tr key={d.id}>
                  <td className="text-[13px]">{relativeTime(d.createdAt)}</td>
                  <td className="text-[13px]">{d.channelName}</td>
                  <td className="text-[13px]">{d.event === 'test' ? 'Test' : d.event === 'firing' ? 'Alert fired' : 'Alert resolved'}</td>
                  <td className="text-[13px]">
                    {d.status === 'sent' ? (
                      <Chip tone="ok">Sent</Chip>
                    ) : d.status === 'failed' ? (
                      <span className="text-crit">Failed after {d.attempts} attempts: {d.lastError}</span>
                    ) : (
                      <span className="text-ink-3">{d.attempts ? `Retrying (attempt ${d.attempts}): ${d.lastError ?? ''}` : 'Queued'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Modal open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit === 'new' ? 'New notification channel' : 'Edit notification channel'} wide>
        {edit && <ChannelForm channel={edit} onDone={() => setEdit(null)} />}
      </Modal>
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete channel" body={<>Delete “{del?.name}”? Rules that used it keep working without it.</>} confirmLabel="Delete channel" onConfirm={() => remove.mutate()} busy={remove.isPending} error={remove.error} />
    </div>
  );
}

/* ------------------------------------------------------------------ polling */

function PollingForm({ row, onDone }: { row: PollingT; onDone: () => void }) {
  const qc = useQueryClient();
  const kinds = row.credentialKinds.filter((k) => (POLL_KINDS as readonly string[]).includes(k));
  const [kind, setKind] = useState<CredentialKind | ''>(row.credentialKind ?? kinds[0] ?? '');
  const [interval, setIntervalS] = useState(row.intervalSeconds ?? 60);
  const [enabled, setEnabled] = useState(row.configured ? row.enabled : true);
  const save = useMutation({ mutationFn: () => api.put(`/monitoring/devices/${row.deviceId}`, { enabled, credentialKind: kind, intervalSeconds: interval }), onSuccess: () => (void qc.invalidateQueries({ queryKey: ['monitoring'] }), onDone()) });
  const remove = useMutation({ mutationFn: () => api.delete(`/monitoring/devices/${row.deviceId}`), onSuccess: () => (void qc.invalidateQueries({ queryKey: ['monitoring'] }), onDone()) });
  if (!kinds.length) {
    return (
      <p className="text-ink-2">
        This device has no stored credential that can read counters. Add a read-only SNMP, RouterOS, FortiOS or NX-API credential in the <Link to={`/network/devices/${row.deviceId}`} className="text-accent hover:underline">device's Read-only access panel</Link> first.
      </p>
    );
  }
  return (
    <form className="grid gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <Field label="Read counters with" hint="The stored credential is used read-only. Polling never changes the device.">
        {(id, d) => (
          <Select id={id} aria-describedby={d} value={kind} onChange={(e) => setKind(e.target.value as CredentialKind)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {CREDENTIAL_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Interval" hint="Shorter intervals give finer charts and faster alerts but more load on the device">
        {(id, d) => (
          <Select id={id} aria-describedby={d} value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
            {[30, 60, 120, 300, 600].map((s) => (
              <option key={s} value={s}>
                {s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Polling enabled
      </label>
      <p className="text-[12.5px] text-ink-3">Counters are matched to the {row.monitoredPorts} monitored port(s) in inventory by name (SNMP ifIndex as a fallback). Ports the device reports that aren't in inventory are counted but not stored; run a discovery to add them.</p>
      <ErrorNote error={save.error ?? remove.error} />
      <div className="flex justify-between gap-2">
        {row.configured ? (
          <Button type="button" variant="ghost" busy={remove.isPending} onClick={() => remove.mutate()}>
            Remove polling
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={save.isPending} disabled={!kind}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

function PollingTab() {
  const { can } = useAuth();
  const manage = can('monitoring.configure');
  const list = useQuery({ queryKey: ['monitoring', 'devices'], queryFn: () => api.get<PollingT[]>('/monitoring/devices'), refetchInterval: 15_000 });
  const [edit, setEdit] = useState<PollingT | null>(null);
  return (
    <Panel flush title="Polling">
      <p className="border-b border-rule px-4 py-2.5 text-[13px] text-ink-2">
        The background worker reads interface counters from each enabled device on its interval and computes rates. Devices are listed when they have a stored access credential. Credentials are managed in each network device's Read-only access panel.
      </p>
      <ErrorNote error={list.error} className="m-4" />
      {list.isLoading && <Loading />}
      {list.data?.length === 0 && (
        <EmptyState title="No devices with credentials">
          Add a read-only credential to a router or switch under <Link to="/network" className="text-accent hover:underline">Network</Link> → device → Read-only access, then enable polling here.
        </EmptyState>
      )}
      {!!list.data?.length && (
        <Table label="Polling per device">
          <thead>
            <tr>
              <th>Device</th>
              <th>Method</th>
              <th>Interval</th>
              <th>Last poll</th>
              <th>Ports matched</th>
              <th>Duration</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.deviceId}>
                <td>
                  <Link to={`/network-monitoring?device=${d.deviceId}`} className="font-medium text-accent hover:underline">
                    {d.deviceName}
                  </Link>
                </td>
                <td className="text-[13px]">{d.credentialKind ? CREDENTIAL_KIND_LABELS[d.credentialKind] : <span className="text-ink-3">Not polled</span>}</td>
                <td className="text-[13px]">{d.configured ? (d.enabled ? `${d.intervalSeconds} s` : <Chip>Paused</Chip>) : '—'}</td>
                <td className="text-[13px]">
                  {!d.configured ? (
                    '—'
                  ) : !d.lastPollAt ? (
                    <span className="text-ink-3">Waiting</span>
                  ) : d.consecutiveFailures ? (
                    <span className="text-crit" title={d.lastError ?? undefined}>
                      Failing ×{d.consecutiveFailures}: {d.lastError}
                    </span>
                  ) : (
                    <span className="text-ok">OK {relativeTime(d.lastOkAt)}</span>
                  )}
                </td>
                <td className="text-[13px] tabular-nums">{d.lastMatched !== null ? `${d.lastMatched} of ${d.lastReported} reported` : '—'}</td>
                <td className="text-[13px] tabular-nums">{d.lastDurationMs !== null ? `${d.lastDurationMs} ms` : '—'}</td>
                <td className="text-right">
                  {manage && (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(d)}>
                      {d.configured ? 'Change' : 'Enable'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={`Polling: ${edit?.deviceName ?? ''}`}>
        {edit && <PollingForm row={edit} onDone={() => setEdit(null)} />}
      </Modal>
    </Panel>
  );
}

/* ------------------------------------------------------------------ retention */

function RetentionTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['monitoring', 'settings'], queryFn: () => api.get<{ rawDays: number; fiveMinuteDays: number; hourlyDays: number }>('/monitoring/settings') });
  const [v, setV] = useState<{ rawDays: number; fiveMinuteDays: number; hourlyDays: number } | null>(null);
  useEffect(() => {
    if (q.data && !v) setV(q.data);
  }, [q.data, v]);
  const save = useMutation({ mutationFn: () => api.put('/monitoring/settings', v), onSuccess: () => qc.invalidateQueries({ queryKey: ['monitoring', 'settings'] }) });
  if (!v) return <Loading />;
  const manage = can('monitoring.configure');
  return (
    <Panel title="How long traffic data is kept">
      <form className="grid max-w-xl gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Every poll (days)" hint="1–90">
            {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={90} disabled={!manage} value={v.rawDays} onChange={(e) => setV({ ...v, rawDays: Number(e.target.value) })} />}
          </Field>
          <Field label="5-minute (days)" hint="7–730; used for 95th percentile">
            {(id, d) => <Input id={id} aria-describedby={d} type="number" min={7} max={730} disabled={!manage} value={v.fiveMinuteDays} onChange={(e) => setV({ ...v, fiveMinuteDays: Number(e.target.value) })} />}
          </Field>
          <Field label="Hourly (days)" hint="30–1825">
            {(id, d) => <Input id={id} aria-describedby={d} type="number" min={30} max={1825} disabled={!manage} value={v.hourlyDays} onChange={(e) => setV({ ...v, hourlyDays: Number(e.target.value) })} />}
          </Field>
        </div>
        <p className="text-[12.5px] text-ink-3">Older data is deleted hourly by the worker. 95th-percentile billing over a month needs at least 31 days of 5-minute data.</p>
        <ErrorNote error={save.error} />
        {save.isSuccess && <p className="text-[13px] text-ok">Saved.</p>}
        {manage && (
          <div>
            <Button type="submit" variant="primary" busy={save.isPending}>
              Save
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ page */

export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as TabKey) ?? 'alerts';
  const summary = useQuery({ queryKey: ['alerts', 'summary'], queryFn: () => api.get<AlertSummaryT>('/alerts/summary'), refetchInterval: 30_000 });
  const s = summary.data;
  return (
    <>
      <PageHeader title="Monitoring & alerts" description="Threshold and state alerts on measured port traffic and device reachability, with maintenance windows and notifications. Alerts never act on devices." />
      {s && (
        <dl className="glass mb-5 grid grid-cols-2 gap-x-6 gap-y-4 rounded-2xl p-4 sm:grid-cols-4">
          <Stat label="Firing" value={s.firing} tone={s.firing ? 'crit' : 'ok'} note={s.firing ? `${s.unacknowledged} not acknowledged` : 'All clear'} />
          <Stat label="Critical" value={s.critical} tone={s.critical ? 'crit' : undefined} />
          <Stat label="Warning" value={s.warning} tone={s.warning ? 'warn' : undefined} />
          <Stat label="Info" value={s.info} />
        </dl>
      )}
      <Tabs tabs={TABS} value={tab} label="Monitoring sections" onChange={(k) => setParams(k === 'alerts' ? {} : { tab: k }, { replace: true })} />
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'maintenance' && <MaintenanceTab />}
      {tab === 'channels' && <ChannelsTab />}
      {tab === 'polling' && <PollingTab />}
      {tab === 'retention' && <RetentionTab />}
    </>
  );
}
