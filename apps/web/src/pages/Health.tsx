import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { uptime } from '../components/DeviceHealth';
import { Button, Chip, EmptyState, ErrorNote, Input, Loading, PageHeader, Panel, Select, Table, cx } from '../components/ui';

type Status = 'critical' | 'warning' | 'ok' | 'unknown';
interface PingT {
  up: boolean;
  rttMs: number | null;
  target: string;
  since: string;
  checkedAt: string;
}
interface FleetItemT {
  id: string;
  name: string;
  assetTag: string;
  category: string;
  lifecycleState: string;
  customerName: string | null;
  location: string | null;
  status: Status;
  reasons: { level: 'critical' | 'warning'; text: string }[];
  ping: { mgmt: PingT | null; server: PingT | null };
  metrics: { at: string | null; fresh: boolean; cpuPct: number | null; memoryPct: number | null; diskPct: number | null; temperatureC: number | null; uptimeSeconds: number | null; error: string | null } | null;
  hardware: { at: string | null; health: string | null; powerState: string | null; psuCount: number | null; maxTempC: number | null; problems: { part: string; name: string; health: string }[]; error: string | null } | null;
  alerts: number;
}
interface FleetT {
  at: string;
  totals: { all: number; critical: number; warning: number; ok: number; unknown: number };
  items: FleetItemT[];
}

const SERVER = ['server', 'gpu_server', 'storage'];
const NETWORK = ['switch', 'router', 'firewall', 'load_balancer', 'optical'];
const KINDS = { all: 'All devices', servers: 'Servers', network: 'Network devices', other: 'Power & other' } as const;
type Kind = keyof typeof KINDS;
const kindOf = (c: string): Exclude<Kind, 'all'> => (SERVER.includes(c) ? 'servers' : NETWORK.includes(c) ? 'network' : 'other');
const STATUS_LABEL: Record<Status, string> = { critical: 'Critical', warning: 'Warning', ok: 'Healthy', unknown: 'Not checked' };
const STATUS_TONE: Record<Status, 'crit' | 'warn' | 'ok' | 'neutral'> = { critical: 'crit', warning: 'warn', ok: 'ok', unknown: 'neutral' };
const STATUS_DOT: Record<Status, string> = { critical: 'bg-crit', warning: 'bg-warn', ok: 'bg-ok', unknown: 'bg-ink-3' };
const CATEGORY_LABEL: Record<string, string> = {
  server: 'Server',
  gpu_server: 'GPU server',
  storage: 'Storage',
  switch: 'Switch',
  router: 'Router',
  firewall: 'Firewall',
  load_balancer: 'Load balancer',
  optical: 'Optical',
  pdu: 'PDU',
  kvm: 'KVM',
  ups: 'UPS',
  other: 'Other',
};

const deviceLink = (d: FleetItemT) => (NETWORK.includes(d.category) ? `/network/devices/${d.id}` : `/hardware/${d.id}`);
const pctTone = (v: number | null, warn = 75, crit = 90) => (v === null ? '' : v >= crit ? 'text-crit font-medium' : v >= warn ? 'text-warn font-medium' : '');

function Ping({ label, p }: { label: string; p: PingT | null }) {
  if (!p) return null;
  return (
    <div
      className={cx('flex items-center gap-1.5 text-[12.5px] whitespace-nowrap', p.up ? '' : 'text-crit')}
      title={`${p.target}: ${p.up ? 'answering' : 'not answering'} since ${relativeTime(p.since)}; checked ${relativeTime(p.checkedAt)}`}
    >
      <span className={cx('size-1.5 rounded-full', p.up ? 'bg-ok' : 'bg-crit')} aria-hidden />
      {label} {p.up ? (p.rttMs !== null ? `${p.rttMs.toFixed(p.rttMs < 10 ? 1 : 0)} ms` : 'up') : `down ${relativeTime(p.since).replace(' ago', '')}`}
    </div>
  );
}

function Load({ m }: { m: FleetItemT['metrics'] }) {
  if (!m) return <span className="text-[12.5px] text-ink-3">—</span>;
  if (!m.fresh)
    return (
      <span className="text-[12.5px] text-warn" title={m.error ?? undefined}>
        {m.error ? 'Read failed' : m.at ? `Stale (${relativeTime(m.at)})` : 'Not read yet'}
      </span>
    );
  return (
    <div className="text-[12.5px] whitespace-nowrap tabular-nums">
      {m.cpuPct !== null && (
        <div>
          CPU <span className={pctTone(m.cpuPct)}>{m.cpuPct.toFixed(0)}%</span>
        </div>
      )}
      {m.memoryPct !== null && (
        <div>
          Memory <span className={pctTone(m.memoryPct)}>{m.memoryPct.toFixed(0)}%</span>
        </div>
      )}
      {m.temperatureC !== null && (
        <div>
          Temp <span className={pctTone(m.temperatureC, 70, 85)}>{m.temperatureC.toFixed(0)} °C</span>
        </div>
      )}
      {m.uptimeSeconds !== null && <div className="text-ink-3">up {uptime(m.uptimeSeconds)}</div>}
    </div>
  );
}

function Hardware({ d, canRefresh }: { d: FleetItemT; canRefresh: boolean }) {
  const qc = useQueryClient();
  const refresh = useMutation({ mutationFn: () => api.post(`/dcim/devices/${d.id}/hardware/refresh`), onSuccess: () => setTimeout(() => void qc.invalidateQueries({ queryKey: ['fleet-health'] }), 3000) });
  const h = d.hardware;
  if (!h) return <span className="text-[12.5px] text-ink-3">{SERVER.includes(d.category) ? 'No BMC read' : '—'}</span>;
  const tone = h.health === 'Critical' || h.problems.some((x) => x.health === 'Critical') ? 'crit' : h.health === 'Warning' || h.problems.length ? 'warn' : h.health === 'OK' ? 'ok' : 'neutral';
  return (
    <div className="text-[12.5px]">
      <div className="flex flex-wrap items-center gap-1.5">
        {h.health || h.at ? <Chip tone={tone}>{h.problems.length ? `${h.problems.length} part${h.problems.length === 1 ? '' : 's'} not OK` : (h.health ?? 'Read')}</Chip> : null}
        {h.error && (
          <span className="text-warn" title={h.error}>
            Read failed
          </span>
        )}
      </div>
      <div className="mt-0.5 text-ink-3 whitespace-nowrap">
        {[h.powerState && `Power ${h.powerState}`, h.psuCount ? `${h.psuCount} PSU` : null, h.maxTempC !== null ? `max ${h.maxTempC.toFixed(0)} °C` : null].filter(Boolean).join(' · ')}
      </div>
      <div className="text-ink-3 whitespace-nowrap">
        {h.at ? `read ${relativeTime(h.at)}` : 'not read yet'}
        {canRefresh && (
          <button type="button" className="ml-2 text-accent hover:underline disabled:opacity-50" disabled={refresh.isPending || refresh.isSuccess} onClick={() => refresh.mutate()}>
            {refresh.isSuccess ? 'requested' : 're-read'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Health: every server and network device in service on one page, worst
 * first. One status per device from what NexoraDC measures: ping of the
 * management / BMC and server addresses, polled CPU / memory / temperature,
 * the BMC's hardware health, and firing alerts.
 */
export function HealthPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState<Status | ''>('');
  const [kind, setKind] = useState<Kind>('all');
  const [q, setQ] = useState('');
  const fleet = useQuery({ queryKey: ['fleet-health'], queryFn: () => api.get<FleetT>('/monitoring/fleet-health'), refetchInterval: 15_000, refetchIntervalInBackground: false, placeholderData: keepPreviousData });
  const all = fleet.data?.items ?? [];
  const ofKind = useMemo(() => all.filter((d) => kind === 'all' || kindOf(d.category) === kind), [all, kind]);
  const term = q.trim().toLowerCase();
  const rows = ofKind.filter(
    (d) =>
      (!status || d.status === status) &&
      (!term || [d.name, d.assetTag, d.customerName, d.location, d.ping.mgmt?.target, d.ping.server?.target].some((x) => x?.toLowerCase().includes(term)) || d.reasons.some((r) => r.text.toLowerCase().includes(term))),
  );
  const count = (s: Status) => ofKind.filter((d) => d.status === s).length;
  const unreachable = ofKind.filter((d) => d.ping.mgmt?.up === false || d.ping.server?.up === false).length;
  const hwFaults = ofKind.filter((d) => d.hardware && (d.hardware.problems.length || d.hardware.health === 'Critical' || d.hardware.health === 'Warning')).length;
  const strained = ofKind.filter((d) => d.metrics?.fresh && ((d.metrics.cpuPct ?? 0) >= 90 || (d.metrics.memoryPct ?? 0) >= 90 || (d.metrics.temperatureC ?? 0) >= 85)).length;
  const canRefresh = can('dcim.write');

  return (
    <>
      <PageHeader title="Health" description="Every server and network device in service, worst first: ping, CPU / memory / temperature, the BMC's hardware health and firing alerts. Updates every 15 seconds." />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {(['critical', 'warning', 'ok', 'unknown'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(status === s ? '' : s)}
              className={cx('rounded-xl border bg-panel px-4 py-3 text-left transition-colors', status === s ? 'border-accent ring-2 ring-accent/30' : 'border-rule hover:border-accent/50')}
            >
              <div className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
                <span className={cx('size-2 rounded-full', STATUS_DOT[s])} aria-hidden />
                {STATUS_LABEL[s]}
              </div>
              <div className={cx('mt-1 text-[26px] leading-none font-semibold tabular-nums', s === 'critical' && count(s) ? 'text-crit' : s === 'warning' && count(s) ? 'text-warn' : '')}>{fleet.data ? count(s) : '—'}</div>
            </button>
          ))}
          <div className="rounded-xl border border-rule bg-panel px-4 py-3">
            <div className="text-[12.5px] text-ink-3">Not answering ping</div>
            <div className={cx('mt-1 text-[26px] leading-none font-semibold tabular-nums', unreachable ? 'text-crit' : '')}>{fleet.data ? unreachable : '—'}</div>
          </div>
          <div className="rounded-xl border border-rule bg-panel px-4 py-3">
            <div className="text-[12.5px] text-ink-3">Hardware faults (BMC)</div>
            <div className={cx('mt-1 text-[26px] leading-none font-semibold tabular-nums', hwFaults ? 'text-warn' : '')}>{fleet.data ? hwFaults : '—'}</div>
          </div>
          <div className="rounded-xl border border-rule bg-panel px-4 py-3">
            <div className="text-[12.5px] text-ink-3">Under strain</div>
            <div className={cx('mt-1 text-[26px] leading-none font-semibold tabular-nums', strained ? 'text-crit' : '')}>{fleet.data ? strained : '—'}</div>
          </div>
        </div>

        <Panel
          flush
          title={status ? `${STATUS_LABEL[status]} devices` : 'Devices'}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Select className="w-44" aria-label="Type" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                {Object.entries(KINDS).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
              <Input className="w-56" aria-label="Search" placeholder="Name, address, customer, problem" value={q} onChange={(e) => setQ(e.target.value)} />
              {(status || kind !== 'all' || q) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setStatus('');
                    setKind('all');
                    setQ('');
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          }
        >
          <ErrorNote error={fleet.error} className="m-4" />
          {fleet.isLoading && <Loading />}
          {fleet.data && !rows.length && (
            <EmptyState title={all.length ? 'No matching devices' : 'No devices in service'}>{all.length ? 'Change or clear the filters.' : 'Devices appear here once they are racked, provisioning, active or in maintenance.'}</EmptyState>
          )}
          {rows.length > 0 && (
            <Table label="Device health">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Status</th>
                  <th>Ping</th>
                  <th>Load</th>
                  <th>Hardware (BMC)</th>
                  <th className="text-right">Alerts</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="min-w-52">
                      <Link to={deviceLink(d)} className="font-medium hover:text-accent hover:underline">
                        {d.name}
                      </Link>
                      <div className="text-[12.5px] text-ink-3">
                        {CATEGORY_LABEL[d.category] ?? d.category}
                        {d.location ? ` · ${d.location}` : ''}
                      </div>
                      {d.customerName && <div className="text-[12.5px] text-ink-2">{d.customerName}</div>}
                    </td>
                    <td className="max-w-[34ch]">
                      <Chip tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status]}</Chip>
                      {d.reasons.slice(0, 3).map((r, i) => (
                        <div key={i} className={cx('mt-1 text-[12.5px] leading-snug', r.level === 'critical' ? 'text-crit' : 'text-warn')}>
                          {r.text}
                        </div>
                      ))}
                      {d.reasons.length > 3 && (
                        <div
                          className="mt-0.5 text-[12px] text-ink-3"
                          title={d.reasons
                            .slice(3)
                            .map((r) => r.text)
                            .join('\n')}
                        >
                          +{d.reasons.length - 3} more
                        </div>
                      )}
                      {d.status === 'unknown' && <div className="mt-1 text-[12px] text-ink-3">No management address, monitoring or BMC set up</div>}
                    </td>
                    <td>
                      <Ping label={SERVER.includes(d.category) ? 'BMC' : 'Mgmt'} p={d.ping.mgmt} />
                      <Ping label="Server" p={d.ping.server} />
                      {!d.ping.mgmt && !d.ping.server && <span className="text-[12.5px] text-ink-3">—</span>}
                    </td>
                    <td>
                      <Load m={d.metrics} />
                    </td>
                    <td>
                      <Hardware d={d} canRefresh={canRefresh && SERVER.includes(d.category)} />
                    </td>
                    <td className="text-right tabular-nums">
                      {d.alerts ? (
                        <Link to="/alerts" className="font-medium text-crit hover:underline">
                          {d.alerts}
                        </Link>
                      ) : (
                        <span className="text-ink-3">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {fleet.data && (
            <p className="border-t border-rule px-4 py-2.5 text-[12px] text-ink-3">
              Ping every minute; CPU / memory / temperature with each monitoring poll; the BMC's hardware health (PSUs, fans, temperatures, drives, memory, CPUs) is read daily or on "re-read". Amber from 75 % (70 °C), red from 90 % (85 °C).
              Devices with nothing set up to check are "Not checked", never "Healthy". Updated {relativeTime(fleet.data.at)}.
            </p>
          )}
        </Panel>
      </div>
    </>
  );
}
