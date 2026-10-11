import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { NAV_SECTIONS } from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { Customer } from '../lib/types';
import { Chip, ErrorNote, Loading, PageHeader, Panel, Stat } from '../components/ui';
import { CATEGORY_LABELS, LIFECYCLE_LABELS, type LifecycleState } from '@crapplet/shared';
import { STATE_TONE, daysUntil } from '../lib/dcim';
import { CustomerEquipment } from './Hardware';
import { OccupancyBar } from './Racks';
import { formatBps } from '../lib/network';
import { useEffect, useMemo, useState } from 'react';
import { bps, latestLive, useLiveWatchMany, useMonitoringStream, withLive, type AlertSummaryT, type LiveSample, type PortRateT, type TotalsHistoryT, type TotalsT } from '../lib/monitoring';
import { RateChart } from '../components/RateChart';
import { formatKwh, formatWattsShort } from '@crapplet/shared';
import type { EnergyT, PowerNowT } from '../lib/power';

interface DcimSummary {
  counts: { datacenters: number; rooms: number; racks: number; devices: number; unracked: number };
  capacity: { totalU: number; usedU: number; reservedU: number; freeU: number };
  devicesByState: Record<LifecycleState, number>;
  devicesByCategory: Record<string, number>;
  warranty: { expired: number; within90Days: number; soonest: { id: string; assetTag: string; hostname: string | null; warrantyExpires: string; model: string; manufacturer: string }[] };
  sparePartsLow: number;
}

function PhysicalPanel() {
  const q = useQuery({ queryKey: ['dcim', 'summary'], queryFn: () => api.get<DcimSummary>('/dcim/summary'), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data!;
  if (s.counts.datacenters === 0) {
    return (
      <Panel title="Physical infrastructure">
        <p className="text-ink-2">
          No datacenters yet. <Link to="/datacenters" className="text-accent hover:underline">Add your first site</Link>, then its rooms and racks, and import your hardware.
        </p>
      </Panel>
    );
  }
  const pct = s.capacity.totalU ? Math.round((s.capacity.usedU / s.capacity.totalU) * 100) : 0;
  const order: LifecycleState[] = ['active', 'provisioning', 'racked', 'maintenance', 'reserved', 'inventory', 'received', 'planned'];
  return (
    <Panel title="Physical infrastructure" actions={<Link to="/racks" className="text-[13px] text-accent hover:underline">All racks</Link>}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Stat label="Datacenters" value={s.counts.datacenters} note={`${s.counts.rooms} room${s.counts.rooms === 1 ? '' : 's'}`} />
        <Stat label="Racks" value={s.counts.racks} note={`${s.capacity.totalU} rack units`} />
        <Stat label="Devices" value={s.counts.devices} note={`${s.counts.unracked} not in a rack`} />
        <Stat label="Rack units in use" value={`${pct}%`} note={`${s.capacity.freeU} free, ${s.capacity.reservedU} reserved`} tone={pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : undefined} />
      </dl>
      <OccupancyBar rack={{ uHeight: Math.max(1, s.capacity.totalU), usedU: s.capacity.usedU, reservedU: s.capacity.reservedU }} className="mt-4 h-2.5" />
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-[13px] font-semibold">Devices by state</p>
          <ul className="flex flex-wrap gap-1.5">
            {order
              .filter((st) => s.devicesByState[st] > 0)
              .map((st) => (
                <li key={st}>
                  <Link to={`/hardware?state=${st}`}>
                    <Chip tone={STATE_TONE[st]}>
                      {LIFECYCLE_LABELS[st]} {s.devicesByState[st]}
                    </Chip>
                  </Link>
                </li>
              ))}
          </ul>
          <p className="mt-4 mb-2 text-[13px] font-semibold">By category</p>
          <p className="text-[13px] text-ink-2">
            {Object.entries(s.devicesByCategory)
              .sort((a, b) => b[1] - a[1])
              .map(([c, n]) => `${CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c} ${n}`)
              .join(', ') || '—'}
          </p>
          {s.sparePartsLow > 0 && (
            <p className="mt-4 text-[13px]">
              <Link to="/hardware?tab=spares" className="text-warn hover:underline">
                {s.sparePartsLow} spare part{s.sparePartsLow === 1 ? ' is' : 's are'} at or below the reorder level
              </Link>
            </p>
          )}
        </div>
        <div>
          <p className="mb-2 text-[13px] font-semibold">
            Warranty: {s.warranty.expired} expired, {s.warranty.within90Days} ending within 90 days
          </p>
          {s.warranty.soonest.length === 0 ? (
            <p className="text-[13px] text-ink-3">Nothing expiring soon.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {s.warranty.soonest.map((d) => {
                const days = daysUntil(d.warrantyExpires)!;
                return (
                  <li key={d.id} className="flex justify-between gap-3">
                    <Link to={`/hardware/${d.id}`} className="truncate text-accent hover:underline">
                      {d.hostname || d.assetTag}
                    </Link>
                    <span className={days < 0 ? 'text-crit' : 'text-warn'}>{days < 0 ? `expired ${-days} d ago` : `${days} d left`}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

function BandwidthPanel() {
  const q = useQuery({ queryKey: ['overview', 'bandwidth'], queryFn: () => api.get<{ now: TotalsT; history: TotalsHistoryT; alerts: AlertSummaryT } | null>('/overview/bandwidth'), refetchInterval: 30_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  if (!d) return null;
  const now = Date.now();
  return (
    <Panel
      title="Bandwidth (measured)"
      actions={
        <span className="flex gap-3 text-[13px]">
          <Link to="/network-monitoring" className="text-accent hover:underline">
            Ports
          </Link>
          <Link to="/alerts" className="text-accent hover:underline">
            Alerts
          </Link>
        </span>
      }
    >
      {d.now.ports === 0 ? (
        <p className="text-[13px] text-ink-2">
          No uplink or transit ports are counted yet. Enable polling in <Link to="/alerts?tab=polling" className="text-accent hover:underline">Monitoring &amp; Alerts</Link> and mark uplink ports with <em>Count in totals</em>.
        </p>
      ) : (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            <Stat label="Inbound now" value={bps(d.now.inBps)} note={`${d.now.freshPorts} of ${d.now.ports} uplink ports reporting`} tone={d.now.stalePorts ? 'warn' : undefined} />
            <Stat label="Outbound now" value={bps(d.now.outBps)} />
            <Stat label="95th pct in, 24 h" value={bps(d.history.p95.inBps)} note={`${d.history.p95.samples} 5-minute samples`} />
            <Stat label="Alerts firing" value={d.alerts.firing} tone={d.alerts.critical ? 'crit' : d.alerts.firing ? 'warn' : 'ok'} note={d.alerts.firing ? `${d.alerts.critical} critical` : 'All clear'} />
          </dl>
          <LiveUplinks />
          {d.history.points.length > 1 && <RateChart label="Total traffic, last 24 hours" points={d.history.points.map((p) => ({ t: new Date(p.t).getTime(), inBps: p.inBps, outBps: p.outBps }))} stepSeconds={d.history.stepSeconds} from={now - 86400_000} to={now} p95={d.history.p95} />}
        </>
      )}
    </Panel>
  );
}

/** A tiny in/out line chart of the last two minutes of per-second samples. */
function Sparkline({ samples, max }: { samples: LiveSample[]; max: number }) {
  const W = 220;
  const H = 44;
  const now = Date.now();
  const from = now - 120_000;
  const pts = samples.filter((s) => s.t >= from);
  const path = (k: 'inBps' | 'outBps') => {
    let d = '';
    let prev: number | null = null;
    for (const s of pts) {
      const v = s[k];
      if (v === null) {
        prev = null;
        continue;
      }
      const x = ((s.t - from) / 120_000) * W;
      const y = H - 2 - (Math.min(v, max) / max) * (H - 4);
      d += `${prev === null || s.t - prev > 3000 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      prev = s.t;
    }
    return d;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-11 w-full" role="img" aria-label="Last two minutes, every second">
      <line x1={0} x2={W} y1={H - 1} y2={H - 1} stroke="var(--rule)" />
      <path d={path('outBps')} fill="none" strokeWidth={1.5} style={{ stroke: 'var(--tx)' }} />
      <path d={path('inBps')} fill="none" strokeWidth={1.5} style={{ stroke: 'var(--rx)' }} />
    </svg>
  );
}

/**
 * Each uplink / transit port on its own, live: while the overview is open the
 * worker reads those devices once a second (nothing stored).
 */
function LiveUplinks() {
  const q = useQuery({ queryKey: ['monitoring', 'ports', 'uplinks'], queryFn: () => api.get<{ items: PortRateT[] }>('/monitoring/ports?totalsOnly=true&pageSize=50&sort=name'), refetchInterval: 30_000 });
  const items = q.data?.items ?? [];
  const stream = useMonitoringStream(items.length > 0);
  // One watched port per device is enough to read the whole device.
  const perDevice = useMemo(() => [...new Map(items.map((p) => [p.deviceId, p.interfaceId])).values()], [items]);
  const watch = useLiveWatchMany(perDevice);
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(h);
  }, []);
  if (!items.length) return null;
  return (
    <div className="mb-4 rounded-xl border border-rule">
      <div className="flex items-center justify-between border-b border-rule px-3 py-2 text-[13px]">
        <span className="font-medium">Uplinks</span>
        <span className="flex items-center gap-1.5 text-ink-3">
          {watch?.live && stream.fast.size ? (
            <>
              <span className="size-1.5 animate-pulse rounded-full bg-ok" aria-hidden /> live, every second (not stored)
            </>
          ) : (
            (watch?.reason ?? 'starting live view…')
          )}
        </span>
      </div>
      <ul className="divide-y divide-rule">
        {items.map((raw) => {
          const p = withLive(raw, stream.live);
          const samples = stream.fast.get(p.interfaceId) ?? [];
          const l = latestLive(samples);
          const inBps = l ? l.inBps : p.fresh ? p.inBps : null;
          const outBps = l ? l.outBps : p.fresh ? p.outBps : null;
          const peak = Math.max(1, ...samples.slice(-120).flatMap((s) => [s.inBps ?? 0, s.outBps ?? 0]));
          const pctOf = (v: number | null) => (v !== null && p.speedBps ? `${((v / p.speedBps) * 100).toFixed(v / p.speedBps < 0.1 ? 1 : 0)}%` : null);
          return (
            <li key={p.interfaceId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
              <Link to={`/network-monitoring?port=${p.interfaceId}`} className="col-span-3 min-w-0 hover:underline">
                <div className="truncate font-medium">
                  {p.description || p.name}
                </div>
                <div className="truncate text-[12px] text-ink-3">
                  {p.deviceName} · <span className="font-mono">{p.name}</span>
                  {p.speedBps ? ` · ${bps(p.speedBps)}` : ''}
                  {p.operUp === false && <span className="ml-1 text-crit">· down</span>}
                </div>
              </Link>
              <div>
                <div className="text-[11.5px] text-ink-3">In</div>
                <div className="text-[17px] font-semibold whitespace-nowrap tabular-nums" style={{ color: 'var(--rx)' }}>
                  {bps(inBps)}
                </div>
                {pctOf(inBps) && <div className="text-[11.5px] text-ink-3">{pctOf(inBps)} of link</div>}
              </div>
              <div>
                <div className="text-[11.5px] text-ink-3">Out</div>
                <div className="text-[17px] font-semibold whitespace-nowrap tabular-nums" style={{ color: 'var(--tx)' }}>
                  {bps(outBps)}
                </div>
                {pctOf(outBps) && <div className="text-[11.5px] text-ink-3">{pctOf(outBps)} of link</div>}
              </div>
              {samples.length > 1 ? <Sparkline samples={samples} max={peak * 1.1} /> : <div className="text-[12px] text-ink-3">{l ? '' : 'waiting for live samples…'}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PowerPanel() {
  const q = useQuery({ queryKey: ['overview', 'power'], queryFn: () => api.get<{ now: PowerNowT; energy: EnergyT | null; byDatacenter: { datacenterCode: string | null; now: PowerNowT }[] } | null>('/overview/power'), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  if (!d) return null;
  return (
    <Panel title="Equipment power" actions={<Link to="/power" className="text-[13px] text-accent hover:underline">Power</Link>}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Stat label="Measured now" value={formatWattsShort(d.now.measuredW)} note={`${d.now.measuredDevices} devices reporting`} />
        <Stat label="Estimated now" value={<span className="text-est">{formatWattsShort(d.now.estimatedW)}</span>} note={`${d.now.estimatedDevices} from estimates`} />
        <Stat label="Unknown" value={d.now.unknownDevices} tone={d.now.unknownDevices ? 'warn' : undefined} note="No figure, not in totals" />
        <Stat label="Energy, 24 h" value={formatKwh(d.energy ? d.energy.measuredKwh + d.energy.estimatedKwh : 0)} note={d.energy ? `${formatKwh(d.energy.estimatedKwh)} of it estimated` : 'No hourly data yet'} />
      </dl>
    </Panel>
  );
}

function NetworkPanel() {
  const { can } = useAuth();
  const net = useQuery({ queryKey: ['network', 'summary'], queryFn: () => api.get<{ networkDevices: number; interfaces: number; physicalInterfaces: number; cables: number; vlans: number; activeCircuits: number; committedTransitBps: number }>('/network/summary'), enabled: can('network.read') });
  const ipam = useQuery({ queryKey: ['ipam', 'summary'], queryFn: () => api.get<{ prefixes: number; allocated: number; reserved: number; ipv4: { usable: number; used: number; utilization: number }; fullest: { id: string; prefix: string; addressUtilization: number }[] }>('/ipam/summary'), enabled: can('ipam.read') });
  if (!can('network.read') && !can('ipam.read')) return null;
  const n = net.data;
  const i = ipam.data;
  return (
    <Panel title="Network and IP addresses" actions={<span className="flex gap-3 text-[13px]">{n && <Link to="/network" className="text-accent hover:underline">Network</Link>}{i && <Link to="/ipam" className="text-accent hover:underline">IPAM</Link>}</span>}>
      <ErrorNote error={net.error ?? ipam.error} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        {n && <Stat label="Network devices" value={n.networkDevices} note={`${n.physicalInterfaces} physical ports`} />}
        {n && <Stat label="Cables documented" value={n.cables} note={`${n.vlans} VLANs`} />}
        {n && <Stat label="Active circuits" value={n.activeCircuits} note={n.committedTransitBps ? `${formatBps(n.committedTransitBps)} committed transit` : 'No transit commits recorded'} />}
        {i && <Stat label="IPv4 in use" value={`${i.ipv4.utilization}%`} note={`${i.ipv4.used.toLocaleString('en-IN')} of ${i.ipv4.usable.toLocaleString('en-IN')} in active subnets`} tone={i.ipv4.utilization >= 90 ? 'crit' : i.ipv4.utilization >= 75 ? 'warn' : undefined} />}
      </dl>
      {i && i.fullest.filter((f) => f.addressUtilization >= 75).length > 0 && (
        <p className="mt-4 text-[13px]">
          Nearly full:{' '}
          {i.fullest
            .filter((f) => f.addressUtilization >= 75)
            .map((f, k) => (
              <span key={f.id}>
                {k > 0 && ', '}
                <Link to={`/ipam/prefixes/${f.id}`} className="font-mono text-warn hover:underline">
                  {f.prefix}
                </Link>{' '}
                ({Math.round(f.addressUtilization)}%)
              </span>
            ))}
        </p>
      )}
      <p className="mt-4 text-[12.5px] text-ink-3">Live port traffic arrives with Phase 4 (network monitoring); these are inventory figures.</p>
    </Panel>
  );
}

interface Overview {
  generatedAt: string;
  customers: { total: number; active: number; suspended: number; closed: number } | null;
  users: { staff: number; customer: number; disabled: number; staffWithoutMfa: number } | null;
  roles: number | null;
  activeSessions: number | null;
  audit: { events24h: number; failedLogins24h: number; denied24h: number } | null;
}

const PHASES = [
  { n: 1, name: 'Foundation', scope: 'Sign-in, roles, tenants, audit log' },
  { n: 2, name: 'Physical DCIM', scope: 'Datacenters, rooms, racks, hardware lifecycle' },
  { n: 3, name: 'Network and IPAM', scope: 'Devices, interfaces, VLANs, IPv4/IPv6' },
  { n: 4, name: 'Network monitoring', scope: 'Live per-port RX/TX and alerts' },
  { n: 5, name: 'Equipment power', scope: 'Measured and estimated watts, kWh, cost' },
  { n: 6, name: 'Provisioning', scope: 'OS installs, Proxmox, Virtualizor' },
  { n: 7, name: 'Colocation and portal', scope: 'Customer self-service, remote hands' },
  { n: 8, name: 'Billing and automation', scope: 'WHMCS, workflows, reports' },
  { n: 9, name: 'Production readiness', scope: 'Hardening, install validation, acceptance' },
];

function Roadmap() {
  const done = new Set(NAV_SECTIONS.filter((s) => s.status === 'available').map((s) => s.phase));
  const pending = new Set(NAV_SECTIONS.filter((s) => s.status === 'planned').map((s) => s.phase));
  return (
    <ol className="divide-y divide-rule">
      {PHASES.map((p) => {
        const live = done.has(p.n) && !pending.has(p.n);
        return (
          <li key={p.n} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-14 flex-none text-[12.5px] text-ink-3">Phase {p.n}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{p.name}</span>
              <span className="block truncate text-[12.5px] text-ink-3">{p.scope}</span>
            </span>
            {live ? <Chip tone="ok">Live</Chip> : <Chip>Not started</Chip>}
          </li>
        );
      })}
    </ol>
  );
}

function StaffOverview() {
  const { me, can } = useAuth();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/overview'), refetchInterval: 60_000 });
  const integrity = useQuery({
    queryKey: ['audit-integrity'],
    queryFn: () => api.get<{ ok: boolean; checked: number; brokenAtId: number | null } | null>('/overview/audit-integrity'),
    enabled: can('audit.read'),
  });
  const o = q.data;
  return (
    <>
      <PageHeader
        title="Overview"
        description={`${me!.organization.name}. Bandwidth and power come from the devices themselves; power estimates are labelled as estimates. Nothing on this page is sample data.`}
      />
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {o && (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-5">
            {can('monitoring.read') && <BandwidthPanel />}
            {can('power.read') && <PowerPanel />}
            {can('dcim.read') && <PhysicalPanel />}
            <NetworkPanel />
            <Panel title="Customers and access">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                {o.customers && <Stat label="Active customers" value={o.customers.active} note={`${o.customers.suspended} suspended, ${o.customers.closed} closed`} />}
                {o.users && <Stat label="Staff users" value={o.users.staff} note={o.users.disabled ? `${o.users.disabled} disabled` : 'Active accounts'} />}
                {o.users && <Stat label="Portal users" value={o.users.customer} note="Customer accounts" />}
                {o.activeSessions !== null && <Stat label="Signed-in sessions" value={o.activeSessions} note="Across all users" />}
              </dl>
              {o.users && o.users.staffWithoutMfa > 0 && (
                <p className="mt-4 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
                  {o.users.staffWithoutMfa} staff account{o.users.staffWithoutMfa === 1 ? ' has' : 's have'} no two-step sign-in.{' '}
                  {can('settings.write') ? (
                    <Link to="/settings" className="font-medium underline">
                      Require it for all staff
                    </Link>
                  ) : (
                    'Ask an administrator to require it.'
                  )}
                </p>
              )}
            </Panel>
            {o.audit && (
              <Panel
                title="Security activity, last 24 hours"
                actions={
                  <Link to="/audit" className="text-[13px] text-accent hover:underline">
                    Open audit log
                  </Link>
                }
              >
                <dl className="grid grid-cols-3 gap-6">
                  <Stat label="Recorded events" value={o.audit.events24h} />
                  <Stat label="Failed sign-ins" value={o.audit.failedLogins24h} tone={o.audit.failedLogins24h > 20 ? 'warn' : undefined} />
                  <Stat label="Access denied" value={o.audit.denied24h} tone={o.audit.denied24h > 0 ? 'warn' : undefined} />
                </dl>
                {integrity.data && (
                  <p className={`mt-4 text-[13px] ${integrity.data.ok ? 'text-ok' : 'text-crit'}`}>
                    {integrity.data.ok
                      ? `Audit trail intact: all ${integrity.data.checked} records verified.`
                      : `Audit trail tampering detected at record #${integrity.data.brokenAtId}. Investigate immediately.`}
                  </p>
                )}
                <ErrorNote error={integrity.error} className="mt-3" />
              </Panel>
            )}
            <p className="text-[12.5px] text-ink-3">Updated {formatDateTime(o.generatedAt, me!.organization.timezone)}</p>
          </div>
          <Panel title="Build progress" flush>
            <Roadmap />
          </Panel>
        </div>
      )}
    </>
  );
}

function CustomerOverview() {
  const q = useQuery({ queryKey: ['my-customer'], queryFn: () => api.get<Customer>('/customers/me') });
  const c = q.data;
  return (
    <>
      <PageHeader title="Your account" description="Bandwidth is on the Network Monitoring page and power on the Power page." />
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {c && (
        <Panel title={c.name} actions={<Chip tone={c.status === 'active' ? 'ok' : 'warn'}>{c.status === 'active' ? 'Active' : c.status === 'suspended' ? 'Suspended' : 'Closed'}</Chip>}>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-[13px] text-ink-2">Account code</dt>
              <dd className="font-mono">{c.code}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-ink-2">Contact email</dt>
              <dd>{c.contactEmail ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-ink-2">Phone</dt>
              <dd>{c.phone ?? '—'}</dd>
            </div>
          </dl>
        </Panel>
      )}
      <div className="mt-5">
        <CustomerEquipment embedded />
      </div>
      <p className="mt-5 text-[13px]">
        <Link to="/ipam" className="text-accent hover:underline">
          View your IP addresses
        </Link>
        {' · '}
        <Link to="/network-monitoring" className="text-accent hover:underline">
          View your bandwidth
        </Link>
        {' · '}
        <Link to="/power" className="text-accent hover:underline">
          View your power
        </Link>
      </p>
    </>
  );
}

export function OverviewPage() {
  const { me } = useAuth();
  return me?.user.userType === 'customer' ? <CustomerOverview /> : <StaffOverview />;
}
