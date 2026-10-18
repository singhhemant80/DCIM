import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { FLOW_RANGE_LABELS, GUEST_ACTION_LABELS, type FlowRange, type GuestAction } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { relativeTime } from '../lib/format';
import { bps } from '../lib/monitoring';
import { bytes, jobKindLabel, type JobT, type VirtGuestT } from '../lib/provisioning';
import { JobModal, JobStatusChip } from '../components/Jobs';
import { VncViewer } from '../components/Console';
import { RateChart } from '../components/RateChart';
import { volume } from '../components/TopIps';
import { OsIcon, osInfo } from '../components/OsIcon';
import { Button, Chip, EmptyState, ErrorNote, Loading, PageHeader, Panel, Select, Stat, Table, cx } from '../components/ui';
import { AccessBadge, GuestActionDialog, ReinstallDialog, UsageBar, guestStatusLabel, statusTone, type AccessT } from './Virtualization';

/** A VM as its manage page gets it: the list row, plus live use and what can be done from here. */
interface GuestDetailT extends VirtGuestT {
  bandwidth: { usedGb: number | null; limitGb: number | null } | null;
  traffic: { inBytes: number; outBytes: number };
  access: AccessT | null;
  live: {
    at: string;
    error?: string;
    status?: string;
    cpuPct?: number | null;
    memUsed?: number | null;
    memTotal?: number | null;
    diskUsed?: number | null;
    diskTotal?: number | null;
    bwUsedGb?: number | null;
    bwLimitGb?: number | null;
  } | null;
  can: { power: boolean; reinstall: boolean; console: boolean };
}
interface HistoryT {
  stepSeconds: number;
  range: { from: string; to: string };
  totals: { inBytes: number; outBytes: number; inBps: number; outBps: number };
  points: { t: string; inBps: number; outBps: number }[];
}

const NAME = { proxmox: 'Proxmox', virtualizor: 'Virtualizor' } as const;
const CHART_RANGES = ['1h', '24h', '7d', '30d'] as const satisfies readonly FlowRange[];

/** Power actions as quick buttons; each still goes through the confirm dialog and runs as a verified job. */
const POWER: { action: GuestAction; when: (status: string | null) => boolean; danger?: boolean }[] = [
  { action: 'start', when: (s) => s !== 'running' },
  { action: 'shutdown', when: (s) => s === 'running' },
  { action: 'reboot', when: (s) => s === 'running' },
  { action: 'stop', when: (s) => s === 'running', danger: true },
];

function Usage({ label, used, total, pct, note, format = bytes }: { label: string; used?: number | null; total?: number | null; pct?: number | null; note?: string; format?: (n: number) => string }) {
  const p = pct ?? (used !== null && used !== undefined && total ? (used / total) * 100 : null);
  return (
    <div>
      <div className="mb-1 text-[12.5px] text-ink-3">{label}</div>
      {p !== null ? (
        <UsageBar pct={p} text={used !== null && used !== undefined && total ? `${format(used)} of ${format(total)}` : `${p.toFixed(1)}%`} />
      ) : (
        <div className="text-[15px] text-ink-3">{total ? `${format(total)} total` : 'Not reported'}</div>
      )}
      {note && <div className="mt-1 text-[12px] text-ink-3">{note}</div>}
    </div>
  );
}

function TrafficChart({ ip }: { ip: string }) {
  const [range, setRange] = useState<(typeof CHART_RANGES)[number]>('24h');
  const h = useQuery({
    queryKey: ['flows', 'history', ip, { range }],
    queryFn: () => api.get<HistoryT>(`/monitoring/flows/ips/${encodeURIComponent(ip)}/history${qs({ range })}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const d = h.data;
  return (
    <Panel
      title={
        <span>
          Traffic <span className="font-mono font-normal text-ink-3">{ip}</span>
        </span>
      }
      actions={
        <Select className="w-36" aria-label="Period" value={range} onChange={(e) => setRange(e.target.value as (typeof CHART_RANGES)[number])}>
          {CHART_RANGES.map((r) => (
            <option key={r} value={r}>
              {FLOW_RANGE_LABELS[r]}
            </option>
          ))}
        </Select>
      }
    >
      <ErrorNote error={h.error} />
      {h.isLoading && <Loading />}
      {d && (
        <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Stat label="Download" value={volume(d.totals.inBytes)} note={`average ${bps(d.totals.inBps)}`} />
          <Stat label="Upload" value={volume(d.totals.outBytes)} note={`average ${bps(d.totals.outBps)}`} />
        </dl>
      )}
      {d && d.points.length > 0 ? (
        <RateChart
          label={`Traffic of ${ip}`}
          points={d.points.map((p) => ({ t: new Date(p.t).getTime(), inBps: p.inBps, outBps: p.outBps }))}
          stepSeconds={d.stepSeconds}
          from={new Date(d.range.from).getTime()}
          to={new Date(d.range.to).getTime()}
        />
      ) : (
        d && <p className="text-[13px] text-ink-3">No flows recorded for this address in this period. Traffic is measured from the routers' flow records for addresses inside your IPAM prefixes.</p>
      )}
    </Panel>
  );
}

export function VirtualMachinePage({ kind }: { kind: 'proxmox' | 'virtualizor' }) {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [action, setAction] = useState<GuestAction | null>(null);
  const [reinstall, setReinstall] = useState(false);
  const [console, setConsole] = useState(false);
  const [job, setJob] = useState<string | null>(null);
  // While this page is open the worker reads the VM's use every 5 s (and, for staff, the RDP / SSH check).
  useEffect(() => {
    const beat = () => void api.post(`/virtualization/guests/${id}/live/watch`).catch(() => undefined);
    beat();
    const t = setInterval(beat, 10_000);
    return () => clearInterval(t);
  }, [id]);
  const q = useQuery({ queryKey: ['virt', 'guest', id], queryFn: () => api.get<GuestDetailT>(`/virtualization/guests/${id}`), refetchInterval: 5_000, refetchIntervalInBackground: false, placeholderData: keepPreviousData });
  const jobs = useQuery({ queryKey: ['provisioning', 'jobs', 'guest', id], queryFn: () => api.get<Paginated<JobT>>(`/provisioning/jobs${qs({ guestId: id, pageSize: 10 })}`), refetchInterval: 10_000 });
  const g = q.data;
  const back = `/integrations/${kind}`;
  if (q.isLoading) return <Loading />;
  if (!g) return <ErrorNote error={q.error ?? new Error('VM not found')} />;
  const live = g.live && !g.live.error ? g.live : null;
  const status = live?.status ?? g.status;
  const busy = !!g.activeJob;
  const queued = (jid: string) => {
    setAction(null);
    setReinstall(false);
    setJob(jid);
    void qc.invalidateQueries({ queryKey: ['virt'] });
    void qc.invalidateQueries({ queryKey: ['provisioning', 'jobs', 'guest', id] });
  };
  const bw = live && (live.bwUsedGb !== null || live.bwLimitGb !== null) && live.bwUsedGb !== undefined ? { usedGb: live.bwUsedGb ?? null, limitGb: live.bwLimitGb ?? null } : g.bandwidth;
  return (
    <>
      <div className="mb-2 text-[13px]">
        <Link to={back} className="text-accent hover:underline">
          ← {NAME[kind]}
        </Link>
      </div>
      <PageHeader
        icon={<OsIcon osName={g.osName} size={32} className="rounded-xl" />}
        title={g.name}
        description={[`#${g.externalId}`, g.virtType, g.hostName && `on ${g.hostName}`, g.osName].filter(Boolean).join(' · ')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {g.can.power &&
              POWER.filter((x) => x.when(status)).map((x) => (
                <Button key={x.action} size="sm" variant={x.danger ? 'danger' : x.action === 'start' ? 'primary' : 'secondary'} disabled={busy} onClick={() => setAction(x.action)}>
                  {GUEST_ACTION_LABELS[x.action]}
                </Button>
              ))}
            {g.can.console && (
              <Button size="sm" disabled={status !== 'running'} title={status !== 'running' ? 'The VM is not running' : undefined} onClick={() => setConsole(true)}>
                Console
              </Button>
            )}
            {g.can.reinstall && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setReinstall(true)}>
                Reinstall OS
              </Button>
            )}
          </div>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <Panel
          title="Overview"
          actions={
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3" title={g.live?.error}>
              <span className={cx('size-1.5 rounded-full', live ? 'animate-pulse bg-ok' : 'bg-ink-3')} aria-hidden />
              {live ? `Live · every 5 s · ${relativeTime(live.at)}` : g.live?.error ? `Live reading failed: ${g.live.error}` : 'Values from the last sync'}
            </span>
          }
        >
          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="mb-1 text-[12.5px] text-ink-3">Status</div>
              {g.missingSince ? <Chip tone="warn">Missing since {relativeTime(g.missingSince)}</Chip> : <Chip tone={statusTone(status)}>{guestStatusLabel(status)}</Chip>}
              {busy && <div className="mt-1 text-[12px] text-accent">Action in progress</div>}
              <AccessBadge a={g.access} />
            </div>
            <Usage label={`CPU${g.cpus ? ` · ${g.cpus} vCPU` : ''}`} pct={live?.cpuPct ?? null} note={live?.cpuPct === undefined || live?.cpuPct === null ? undefined : 'as the hypervisor reports it'} />
            <Usage label="Memory" used={live?.memUsed ?? null} total={live?.memTotal ?? g.memBytes} />
            <Usage label="Disk" used={live?.diskUsed ?? null} total={live?.diskTotal ?? g.diskBytes} />
          </div>
          {kind === 'virtualizor' && bw && bw.usedGb !== null && (
            <div className="mt-5 max-w-md">
              {bw.limitGb ? (
                <Usage label="Bandwidth this month (Virtualizor)" pct={(bw.usedGb / bw.limitGb) * 100} used={bw.usedGb} total={bw.limitGb} format={(n) => `${n.toFixed(n < 10 ? 2 : 1)} GB`} />
              ) : (
                <>
                  <div className="mb-1 text-[12.5px] text-ink-3">Bandwidth this month (Virtualizor)</div>
                  <div className="text-[15px] tabular-nums">{bw.usedGb.toFixed(bw.usedGb < 10 ? 2 : 1)} GB · no limit</div>
                </>
              )}
            </div>
          )}
        </Panel>

        {console && (
          <Panel title="Console" actions={<span className="text-[12.5px] text-ink-3">Through {NAME[kind]}; every session is logged</span>}>
            <VncViewer guestId={g.id} onClose={() => setConsole(false)} />
          </Panel>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Panel title="Details">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[13px]">
              <dt className="text-ink-3">{kind === 'virtualizor' ? 'VPS ID' : 'VM ID'}</dt>
              <dd className="font-mono">{g.externalId}</dd>
              <dt className="text-ink-3">{kind === 'proxmox' ? 'Node' : 'Server'}</dt>
              <dd>{g.hostName ?? '—'}</dd>
              <dt className="text-ink-3">Type</dt>
              <dd>{g.virtType ?? '—'}</dd>
              <dt className="text-ink-3">Operating system</dt>
              <dd className="flex items-center gap-2">
                <OsIcon osName={g.osName} size={14} />
                <span>
                  {g.osName ?? '—'}
                  {osInfo(g.osName) && <span className="text-ink-3"> · {osInfo(g.osName)!.label}</span>}
                </span>
              </dd>
              <dt className="text-ink-3">Resources</dt>
              <dd>
                {g.cpus ?? '—'} vCPU · {bytes(g.memBytes)} RAM{g.diskBytes ? ` · ${bytes(g.diskBytes)} disk` : ''}
              </dd>
              <dt className="text-ink-3">IP addresses</dt>
              <dd className="font-mono text-[12.5px]">{g.ipAddresses.length ? g.ipAddresses.join(', ') : <span className="font-sans text-ink-3">Not reported</span>}</dd>
              {g.integrationName && (
                <>
                  <dt className="text-ink-3">Connection</dt>
                  <dd>{g.integrationName}</dd>
                </>
              )}
              {g.customerName !== undefined && (
                <>
                  <dt className="text-ink-3">Customer</dt>
                  <dd>{g.customerName ?? 'Own'}</dd>
                </>
              )}
              <dt className="text-ink-3">Last synced</dt>
              <dd>{g.lastSeenAt ? relativeTime(g.lastSeenAt) : '—'}</dd>
            </dl>
          </Panel>
          <Panel flush title="Recent actions">
            <ErrorNote error={jobs.error} className="m-4" />
            {jobs.data && !jobs.data.items.length && <EmptyState title="No actions yet">Power actions and reinstalls run as jobs and appear here.</EmptyState>}
            {jobs.data && jobs.data.items.length > 0 && (
              <Table label="Recent actions">
                <tbody>
                  {jobs.data.items.map((j) => (
                    <tr key={j.id} className="cursor-pointer hover:bg-sunken/60" onClick={() => setJob(j.id)}>
                      <td className="text-[13px]">
                        {jobKindLabel(j.kind)}
                        <span className="block text-[12px] text-ink-3">{j.kind === 'guest_reinstall' ? `with ${String(j.params.osName ?? 'a new OS')}` : String(j.params.action ?? '')}</span>
                      </td>
                      <td>
                        <JobStatusChip status={j.status} cancelRequested={j.cancelRequested} verified={j.verified} />
                      </td>
                      <td className="text-right text-[12.5px] text-ink-3">{relativeTime(j.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>

        {g.ipAddresses
          .filter((ip) => /^[\d.]+$/.test(ip) || ip.includes(':'))
          .slice(0, 4)
          .map((ip) => (
            <TrafficChart key={ip} ip={ip} />
          ))}
      </div>
      {action && <GuestActionDialog guest={g} initial={action} onClose={() => setAction(null)} onQueued={queued} />}
      {reinstall && <ReinstallDialog guest={g} onClose={() => setReinstall(false)} onQueued={queued} />}
      <JobModal id={job} onClose={() => setJob(null)} />
    </>
  );
}
