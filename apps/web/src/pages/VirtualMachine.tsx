import { useEffect, useState } from 'react';
import { AdoptVpsModal } from './Wallet';
import { IpList } from '../components/IpList';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { FLOW_RANGE_LABELS, GUEST_ACTION_LABELS, type FlowRange, type GuestAction } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { dueIn, formatDate, relativeTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import { bps } from '../lib/monitoring';
import { bytes, jobKindLabel, type JobT, type VirtGuestT } from '../lib/provisioning';
import { JobModal, JobStatusChip } from '../components/Jobs';
import { VncViewer } from '../components/Console';
import { RateChart } from '../components/RateChart';
import { volume } from '../components/TopIps';
import { OsIcon, osInfo } from '../components/OsIcon';
import { Button, Chip, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Stat, Table, cx } from '../components/ui';
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
  can: { power: boolean; reinstall: boolean; console: boolean; password?: boolean };
  billing: { subscriptionId: string; name: string; status: string; nextDueAt: string; pricePaise: number; cancelAt: string | null } | null;
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
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  const [adopt, setAdopt] = useState(false);
  const qc = useQueryClient();
  const [action, setAction] = useState<GuestAction | null>(null);
  const [reinstall, setReinstall] = useState(false);
  const [pw, setPw] = useState(false);
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
    setPw(false);
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
            {g.can.password && (
              <Button size="sm" disabled={busy} onClick={() => setPw(true)}>
                Change password
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
      <div className="-mt-2 mb-5 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink-3">IP address{g.ipAddresses.length === 1 ? '' : 'es'}</span>
        <IpList ips={g.ipAddresses} size="lg" />
      </div>
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

        {adopt && <AdoptVpsModal guest={{ id: g.id, name: g.name, customerName: g.customerName }} onClose={() => setAdopt(false)} />}
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
              {g.hostName !== null && (
                <>
                  <dt className="text-ink-3">{kind === 'proxmox' ? 'Node' : 'Server'}</dt>
                  <dd>{g.hostName}</dd>
                </>
              )}
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
              <dd>
                <IpList ips={g.ipAddresses} size="sm" />
              </dd>
              {g.integrationName && (
                <>
                  <dt className="text-ink-3">Connection</dt>
                  <dd>{g.integrationName}</dd>
                </>
              )}
              {g.billing && (
                <>
                  <dt className="text-ink-3">{g.billing.status === 'cancelled' ? 'Billing' : g.billing.cancelAt ? 'Ends' : 'Renews (expiry)'}</dt>
                  <dd>
                    {g.billing.status === 'cancelled' ? (
                      'Cancelled'
                    ) : (
                      <>
                        <span className="font-medium text-crit">
                          {formatDate(g.billing.cancelAt ?? g.billing.nextDueAt)} ({dueIn(g.billing.cancelAt ?? g.billing.nextDueAt)})
                        </span>
                        {g.billing.status === 'overdue' && <span className="text-crit"> · overdue</span>}
                        {g.billing.status === 'suspended' && <span className="text-crit"> · suspended for non-payment</span>}{' '}
                        <Link to="/wallet" className="text-accent hover:underline">
                          Billing
                        </Link>
                      </>
                    )}
                  </dd>
                </>
              )}
              {staff && !g.billing && g.customerId && can('billing.write') && (
                <>
                  <dt className="text-ink-3">Billing</dt>
                  <dd>
                    <span className="text-ink-3">Not billed here. </span>
                    <button className="text-accent hover:underline" onClick={() => setAdopt(true)}>
                      Start billing here (set the next renewal)
                    </button>
                  </dd>
                </>
              )}
              {staff && g.owner && (
                <>
                  <dt className="text-ink-3">Owner in Virtualizor</dt>
                  <dd>
                    {g.owner.name ? `${g.owner.name} · ` : ''}
                    <span className="text-ink-2">{g.owner.email}</span>
                  </dd>
                </>
              )}
              {staff && g.customerName !== undefined && (
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
      {pw && <PasswordDialog guestId={g.id} name={g.name} windows={/win/i.test(g.osName ?? '')} onClose={() => setPw(false)} onQueued={queued} />}
      <JobModal id={job} onClose={() => setJob(null)} />
    </>
  );
}

/** New root (Linux) or Administrator (Windows) password, sent once to Virtualizor and not kept. */
function PasswordDialog({ guestId, name, windows, onClose, onQueued }: { guestId: string; name: string; windows: boolean; onClose: () => void; onQueued: (id: string) => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [key] = useState(() => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));
  const strong = password.length >= 10 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password);
  const m = useMutation({ mutationFn: () => api.post<{ id: string }>(`/virtualization/guests/${guestId}/password`, { password }, { 'Idempotency-Key': key }), onSuccess: (j) => onQueued(j.id) });
  const gen = () => {
    const a = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const r = crypto.getRandomValues(new Uint32Array(14));
    const p = `${Array.from(r, (x) => a[x % a.length]).join('')}a7K`;
    setPassword(p);
    setAgain(p);
    setShow(true);
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Change password of ${name}`} description={`Sets a new ${windows ? 'Administrator' : 'root'} password through Virtualizor. It is sent once and not stored. ${windows ? 'Windows' : 'KVM'} VPSs may need a restart before it applies.`}>
      <div className="grid gap-3">
        <Field label="New password" hint="At least 10 characters with a capital letter, a small letter and a digit." error={password && !strong ? 'Too weak' : undefined}>
          {(id) => (
            <div className="flex gap-2">
              <Input id={id} type={show ? 'text' : 'password'} className="font-mono" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
              <Button onClick={gen}>Generate</Button>
            </div>
          )}
        </Field>
        <Field label="Repeat it" error={again && again !== password ? 'The two passwords differ' : undefined}>
          {(id) => <Input id={id} type={show ? 'text' : 'password'} className="font-mono" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />}
        </Field>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
        </label>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={m.isPending} disabled={!strong || again !== password} onClick={() => m.mutate()}>
            Change password
          </Button>
        </div>
      </div>
    </Modal>
  );
}
