import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
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
import { bps, latestLive, useLiveWatchMany, useMonitoringStream, withLive, type AlertSummaryT, type LiveSample, type PortHistoryT, type PortRateT, type TotalsHistoryT, type TotalsT } from '../lib/monitoring';
import { RateChart } from '../components/RateChart';
import { MultiRateChart, uplinkColors, type Series } from '../components/MultiRateChart';
import { formatKwh, formatWattsShort } from '@crapplet/shared';
import type { EnergyT, PowerNowT } from '../lib/power';
import type { AllocationT, OverviewT as ColoOverviewT, TicketT } from '../lib/colocation';
import type { PrefixT } from './Ipam';
import { HealthOverviewPanel, strained, type HealthT } from '../components/DeviceHealth';

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
          No datacenters yet.{' '}
          <Link to="/datacenters" className="text-accent hover:underline">
            Add your first site
          </Link>
          , then its rooms and racks, and import your hardware.
        </p>
      </Panel>
    );
  }
  const pct = s.capacity.totalU ? Math.round((s.capacity.usedU / s.capacity.totalU) * 100) : 0;
  const order: LifecycleState[] = ['active', 'provisioning', 'racked', 'maintenance', 'reserved', 'inventory', 'received', 'planned'];
  return (
    <Panel
      title="Physical infrastructure"
      className="@container"
      actions={
        <Link to="/racks" className="text-[13px] text-accent hover:underline">
          All racks
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 @xl:grid-cols-4">
        <Stat label="Datacenters" value={s.counts.datacenters} note={`${s.counts.rooms} room${s.counts.rooms === 1 ? '' : 's'}`} />
        <Stat label="Racks" value={s.counts.racks} note={`${s.capacity.totalU} rack units`} />
        <Stat label="Devices" value={s.counts.devices} note={`${s.counts.unracked} not in a rack`} />
        <Stat label="Rack units in use" value={`${pct}%`} note={`${s.capacity.freeU} free, ${s.capacity.reservedU} reserved`} tone={pct >= 90 ? 'crit' : pct >= 75 ? 'warn' : undefined} />
      </dl>
      <OccupancyBar rack={{ uHeight: Math.max(1, s.capacity.totalU), usedU: s.capacity.usedU, reservedU: s.capacity.reservedU }} className="mt-4 h-2.5" />
      <div className="mt-5 grid gap-5 @2xl:grid-cols-2">
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
      className="@container"
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
          No uplink or transit ports are counted yet. Enable polling in{' '}
          <Link to="/alerts?tab=polling" className="text-accent hover:underline">
            Monitoring &amp; Alerts
          </Link>{' '}
          and mark uplink ports with <em>Count in totals</em>.
        </p>
      ) : (
        <>
          <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-5 @xl:grid-cols-4">
            <Stat label="Inbound now" value={bps(d.now.inBps)} note={`${d.now.freshPorts} of ${d.now.ports} uplink ports reporting`} tone={d.now.stalePorts ? 'warn' : undefined} />
            <Stat label="Outbound now" value={bps(d.now.outBps)} />
            <Stat label="95th pct in, 24 h" value={bps(d.history.p95.inBps)} note={`${d.history.p95.samples} 5-minute samples`} />
            <Stat label="Alerts firing" value={d.alerts.firing} tone={d.alerts.critical ? 'crit' : d.alerts.firing ? 'warn' : 'ok'} note={d.alerts.firing ? `${d.alerts.critical} critical` : 'All clear'} />
          </dl>
          <LiveUplinks />
          <UplinkHistory total={d.history} now={now} />
        </>
      )}
    </Panel>
  );
}

/**
 * Last 24 hours: each uplink's download and upload in its own colour (same
 * colours as the live rows above), or the total of all uplinks.
 */
function UplinkHistory({ total, now }: { total: TotalsHistoryT; now: number }) {
  const [view, setView] = useState<'each' | 'total'>('each');
  const ports = useQuery({ queryKey: ['monitoring', 'ports', 'uplinks'], queryFn: () => api.get<{ items: PortRateT[] }>('/monitoring/ports?totalsOnly=true&pageSize=50&sort=name'), refetchInterval: 30_000 });
  const items = ports.data?.items ?? [];
  const hist = useQueries({
    queries: items.slice(0, 5).map((p) => ({ queryKey: ['monitoring', 'history', p.interfaceId, { range: '24h' }], queryFn: () => api.get<PortHistoryT>(`/monitoring/ports/${p.interfaceId}/history?range=24h`), refetchInterval: 120_000 })),
  });
  const series: Series[] = items.slice(0, 5).flatMap((p, i) => {
    const h = hist[i]?.data;
    if (!h) return [];
    const c = uplinkColors(i);
    const name = p.description || p.name;
    const pts = h.points.map((x) => ({ t: new Date(x.t).getTime(), in: x.inBps, out: x.outBps }));
    return [
      { key: `${p.interfaceId}-in`, label: `${name} download`, color: c.in, points: pts.map((x) => ({ t: x.t, v: x.in })) },
      { key: `${p.interfaceId}-out`, label: `${name} upload`, color: c.out, points: pts.map((x) => ({ t: x.t, v: x.out })) },
    ];
  });
  const step = hist.find((h) => h.data)?.data?.stepSeconds ?? total.stepSeconds;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium">Last 24 hours</p>
        <span className="inline-flex rounded-lg border border-rule p-0.5 text-[12.5px]" role="group" aria-label="Chart">
          {(
            [
              ['each', 'Each uplink'],
              ['total', 'Total'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)} className={view === k ? 'rounded-md bg-field px-2 py-0.5 font-medium' : 'rounded-md px-2 py-0.5 text-ink-3 hover:text-ink'}>
              {l}
            </button>
          ))}
        </span>
      </div>
      {view === 'each' && series.length > 0 && <MultiRateChart label="Each uplink, last 24 hours" series={series} stepSeconds={step} from={now - 86400_000} to={now} />}
      {view === 'each' && !series.length && <p className="text-[13px] text-ink-3">{hist.some((h) => h.isLoading) ? 'Loading…' : 'No history yet.'}</p>}
      {view === 'total' && total.points.length > 1 && (
        <RateChart label="Total traffic, last 24 hours" points={total.points.map((p) => ({ t: new Date(p.t).getTime(), inBps: p.inBps, outBps: p.outBps }))} stepSeconds={total.stepSeconds} from={now - 86400_000} to={now} p95={total.p95} />
      )}
    </div>
  );
}

/** A tiny in/out line chart of the last two minutes of per-second samples. */
function Sparkline({ samples, max, colors }: { samples: LiveSample[]; max: number; colors: { in: string; out: string } }) {
  const W = 220;
  const H = 56;
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
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" role="img" aria-label="Last two minutes, every second">
      <line x1={0} x2={W} y1={H - 1} y2={H - 1} stroke="var(--rule)" />
      <path d={path('outBps')} fill="none" strokeWidth={1.6} style={{ stroke: colors.out }} />
      <path d={path('inBps')} fill="none" strokeWidth={1.6} style={{ stroke: colors.in }} />
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
        {items.map((raw, idx) => {
          const c = uplinkColors(idx);
          const p = withLive(raw, stream.live);
          const samples = stream.fast.get(p.interfaceId) ?? [];
          const l = latestLive(samples);
          const inBps = l ? l.inBps : p.fresh ? p.inBps : null;
          const outBps = l ? l.outBps : p.fresh ? p.outBps : null;
          const peak = Math.max(1, ...samples.slice(-120).flatMap((s) => [s.inBps ?? 0, s.outBps ?? 0]));
          const pctOf = (v: number | null) => (v !== null && p.speedBps ? `${((v / p.speedBps) * 100).toFixed(v / p.speedBps < 0.1 ? 1 : 0)}%` : null);
          return (
            <li key={p.interfaceId} className="grid grid-cols-2 items-center gap-x-3 gap-y-1.5 px-3 py-2.5 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
              <Link to={`/network-monitoring?port=${p.interfaceId}`} className="col-span-2 min-w-0 hover:underline @2xl:col-span-3">
                <div className="truncate font-medium">{p.description || p.name}</div>
                <div className="truncate text-[12px] text-ink-3">
                  {p.deviceName} · <span className="font-mono">{p.name}</span>
                  {p.speedBps ? ` · ${bps(p.speedBps)}` : ''}
                  {p.operUp === false && <span className="ml-1 text-crit">· down</span>}
                </div>
              </Link>
              <div>
                <div className="text-[11.5px] text-ink-3">Download (in)</div>
                <div className="text-[17px] font-semibold whitespace-nowrap tabular-nums" style={{ color: c.in }}>
                  {bps(inBps)}
                </div>
                {pctOf(inBps) && <div className="text-[11.5px] text-ink-3">{pctOf(inBps)} of link</div>}
              </div>
              <div>
                <div className="text-[11.5px] text-ink-3">Upload (out)</div>
                <div className="text-[17px] font-semibold whitespace-nowrap tabular-nums" style={{ color: c.out }}>
                  {bps(outBps)}
                </div>
                {pctOf(outBps) && <div className="text-[11.5px] text-ink-3">{pctOf(outBps)} of link</div>}
              </div>
              <div className="col-span-2 @2xl:col-span-1">{samples.length > 1 ? <Sparkline samples={samples} max={peak * 1.1} colors={c} /> : <div className="text-[12px] text-ink-3">{l ? '' : 'waiting for live samples…'}</div>}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PowerPanel() {
  const q = useQuery({
    queryKey: ['overview', 'power'],
    queryFn: () => api.get<{ now: PowerNowT; energy: EnergyT | null; byDatacenter: { datacenterCode: string | null; now: PowerNowT }[] } | null>('/overview/power'),
    refetchInterval: 60_000,
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  if (!d) return null;
  return (
    <Panel
      title="Equipment power"
      className="@container"
      actions={
        <Link to="/power" className="text-[13px] text-accent hover:underline">
          Power
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 @3xl:grid-cols-4">
        <Stat label="Measured now" value={formatWattsShort(d.now.measuredW)} note={`${d.now.measuredDevices} devices reporting`} />
        <Stat label="Estimated now" value={<span className="text-est">{formatWattsShort(d.now.estimatedW)}</span>} note={`${d.now.estimatedDevices} from estimates`} />
        <Stat label="Unknown" value={d.now.unknownDevices} tone={d.now.unknownDevices ? 'warn' : undefined} note="No figure, not in totals" />
        <Stat label="Energy, 24 h" value={formatKwh(d.energy ? d.energy.measuredKwh + d.energy.estimatedKwh : 0)} note={d.energy ? `${formatKwh(d.energy.estimatedKwh)} of it estimated` : 'No hourly data yet'} />
      </dl>
      {d.byDatacenter.length > 1 && (
        <ul className="mt-5 divide-y divide-rule border-t border-rule text-[13px]">
          {d.byDatacenter.map((x) => (
            <li key={x.datacenterCode ?? 'none'} className="flex justify-between gap-3 py-1.5">
              <span>{x.datacenterCode ?? 'Not in a rack'}</span>
              <span className="tabular-nums">
                {formatWattsShort(x.now.measuredW + x.now.estimatedW)}
                {x.now.estimatedW > 0 && <span className="text-est"> ({formatWattsShort(x.now.estimatedW)} est.)</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function NetworkPanel() {
  const { can } = useAuth();
  const net = useQuery({
    queryKey: ['network', 'summary'],
    queryFn: () => api.get<{ networkDevices: number; interfaces: number; physicalInterfaces: number; cables: number; vlans: number; activeCircuits: number; committedTransitBps: number }>('/network/summary'),
    enabled: can('network.read'),
  });
  const ipam = useQuery({
    queryKey: ['ipam', 'summary'],
    queryFn: () => api.get<{ prefixes: number; allocated: number; reserved: number; ipv4: { usable: number; used: number; utilization: number }; fullest: { id: string; prefix: string; addressUtilization: number }[] }>('/ipam/summary'),
    enabled: can('ipam.read'),
  });
  if (!can('network.read') && !can('ipam.read')) return null;
  const n = net.data;
  const i = ipam.data;
  return (
    <Panel
      title="Network and IP addresses"
      className="@container"
      actions={
        <span className="flex gap-3 text-[13px]">
          {n && (
            <Link to="/network" className="text-accent hover:underline">
              Network
            </Link>
          )}
          {i && (
            <Link to="/ipam" className="text-accent hover:underline">
              IPAM
            </Link>
          )}
        </span>
      }
    >
      <ErrorNote error={net.error ?? ipam.error} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 @3xl:grid-cols-4">
        {n && <Stat label="Network devices" value={n.networkDevices} note={`${n.physicalInterfaces} physical ports`} />}
        {n && <Stat label="Cables documented" value={n.cables} note={`${n.vlans} VLANs`} />}
        {n && <Stat label="Active circuits" value={n.activeCircuits} note={n.committedTransitBps ? `${formatBps(n.committedTransitBps)} committed transit` : 'No transit commits recorded'} />}
        {i && (
          <Stat
            label="IPv4 in use"
            value={`${i.ipv4.utilization}%`}
            note={`${i.ipv4.used.toLocaleString('en-IN')} of ${i.ipv4.usable.toLocaleString('en-IN')} in active subnets`}
            tone={i.ipv4.utilization >= 90 ? 'crit' : i.ipv4.utilization >= 75 ? 'warn' : undefined}
          />
        )}
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

/** Things that need someone: each row links to where it is handled. */
function AttentionPanel({ o }: { o: Overview }) {
  const { can } = useAuth();
  const dcim = useQuery({ queryKey: ['dcim', 'summary'], queryFn: () => api.get<DcimSummary>('/dcim/summary'), enabled: can('dcim.read'), refetchInterval: 60_000 });
  const bw = useQuery({ queryKey: ['overview', 'bandwidth'], queryFn: () => api.get<{ alerts: AlertSummaryT } | null>('/overview/bandwidth'), enabled: can('monitoring.read'), refetchInterval: 30_000 });
  const colo = useQuery({ queryKey: ['colo', 'overview'], queryFn: () => api.get<ColoOverviewT>('/colocation/overview'), enabled: can('services.read'), refetchInterval: 60_000 });
  const power = useQuery({ queryKey: ['overview', 'power'], queryFn: () => api.get<{ now: PowerNowT } | null>('/overview/power'), enabled: can('power.read'), refetchInterval: 60_000 });
  const health = useQuery({ queryKey: ['monitoring', 'health'], queryFn: () => api.get<HealthT[]>('/monitoring/health'), enabled: can('monitoring.read'), refetchInterval: 30_000 });
  const hot = (health.data ?? []).filter(strained);
  const integrity = useQuery({
    queryKey: ['audit-integrity'],
    queryFn: () => api.get<{ ok: boolean; checked: number; brokenAtId: number | null } | null>('/overview/audit-integrity'),
    enabled: can('audit.read'),
  });
  const a = bw.data?.alerts;
  const c = colo.data;
  const d = dcim.data;
  const rows: { label: string; n: number | null | undefined; to: string; tone: 'crit' | 'warn'; note?: string }[] = [
    { label: 'Alerts firing', n: a?.firing, to: '/alerts', tone: a?.critical ? 'crit' : 'warn', note: a?.critical ? `${a.critical} critical` : undefined },
    { label: 'Open tickets', n: c?.open.tickets, to: '/tickets', tone: 'warn' },
    { label: 'Cross-connect requests', n: c?.open.crossConnects, to: '/colocation?tab=cross-connects', tone: 'warn' },
    { label: 'Shipments and visits expected', n: c ? c.open.shipments + c.open.visits : undefined, to: '/colocation?tab=shipments', tone: 'warn' },
    { label: 'Racks over contracted power', n: c?.overContract.length, to: '/colocation', tone: 'crit', note: c?.mayExceed.length ? `${c.mayExceed.length} may exceed` : undefined },
    { label: 'Warranties expired', n: d?.warranty.expired, to: '/hardware?warranty=0', tone: 'crit', note: d?.warranty.within90Days ? `${d.warranty.within90Days} more within 90 days` : undefined },
    { label: 'Spare parts at reorder level', n: d?.sparePartsLow, to: '/hardware?tab=spares', tone: 'warn' },
    { label: 'Network devices under strain', n: health.data ? hot.length : undefined, to: hot[0] ? `/network/devices/${hot[0].deviceId}` : '/', tone: 'crit', note: hot.length ? hot.slice(0, 3).map((h) => h.deviceName).join(', ') + ' (CPU or memory ≥ 90 %, or ≥ 85 °C)' : undefined },
    { label: 'Devices without a power figure', n: power.data?.now.unknownDevices, to: '/power?tab=collection', tone: 'warn' },
    { label: 'Staff without two-step sign-in', n: o.users?.staffWithoutMfa, to: '/users', tone: 'warn' },
  ];
  const shown = rows.filter((r) => r.n !== undefined && r.n !== null);
  const open = shown.filter((r) => (r.n ?? 0) > 0);
  return (
    <Panel title="Needs attention" flush>
      {open.length === 0 && shown.length > 0 && <p className="px-4 pt-3 text-[13px] text-ok">Nothing waiting. All clear.</p>}
      <ul className="divide-y divide-rule">
        {shown.map((r) => (
          <li key={r.label}>
            <Link to={r.to} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-sunken/50">
              <span className="min-w-0">
                <span className={r.n ? 'font-medium' : 'text-ink-2'}>{r.label}</span>
                {r.note && <span className="block text-[12px] text-ink-3">{r.note}</span>}
              </span>
              {r.n ? <Chip tone={r.tone}>{r.n}</Chip> : <span className="text-[13px] text-ink-3">0</span>}
            </Link>
          </li>
        ))}
      </ul>
      {integrity.data && (
        <p className={`border-t border-rule px-4 py-2.5 text-[12.5px] ${integrity.data.ok ? 'text-ok' : 'font-medium text-crit'}`}>
          {integrity.data.ok ? `Audit trail intact: ${integrity.data.checked.toLocaleString('en-IN')} records verified.` : `Audit trail tampering detected at record #${integrity.data.brokenAtId}. Investigate immediately.`}
        </p>
      )}
    </Panel>
  );
}

function ColocationPanel() {
  const q = useQuery({ queryKey: ['colo', 'overview'], queryFn: () => api.get<ColoOverviewT>('/colocation/overview'), refetchInterval: 60_000 });
  const c = q.data;
  if (!c) return q.error ? <ErrorNote error={q.error} /> : null;
  return (
    <Panel
      title="Colocation and services"
      className="@container h-full"
      actions={
        <Link to="/colocation" className="text-[13px] text-accent hover:underline">
          Colocation
        </Link>
      }
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 @2xl:grid-cols-3">
        <Stat label="Allocated space" value={`${c.units} U`} note={`${c.allocations} allocation${c.allocations === 1 ? '' : 's'}`} />
        <Stat label="Contracted power" value={formatWattsShort(c.contractedPowerW)} note={`${formatWattsShort(c.measuredW + c.estimatedW)} in use`} />
        <Stat label="Active services" value={c.activeServices} />
        <Stat label="Active cross-connects" value={c.activeCrossConnects} />
        <Stat
          label="Customer equipment now"
          value={formatWattsShort(c.equipment.measuredW + c.equipment.estimatedW)}
          note={`${c.equipment.devices} devices${c.equipment.estimatedW ? `, ${formatWattsShort(c.equipment.estimatedW)} estimated` : ''}`}
        />
        <Stat
          label="Customer traffic now"
          value={c.bandwidth?.ports ? `↓ ${bps(c.bandwidth.inBps)}` : '—'}
          note={c.bandwidth?.ports ? `↑ ${bps(c.bandwidth.outBps)} · ${c.bandwidth.ports} port${c.bandwidth.ports === 1 ? '' : 's'}` : 'No monitored customer ports'}
        />
      </dl>
    </Panel>
  );
}

function StaffOverview() {
  const { me, can } = useAuth();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/overview'), refetchInterval: 60_000 });
  const o = q.data;
  return (
    <>
      <PageHeader title="Overview" description={`${me!.organization.name}. Bandwidth and power come from the devices themselves; estimates are labelled. Updated ${o ? formatDateTime(o.generatedAt, me!.organization.timezone) : '…'}.`} />
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {o && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
          {/* Two columns that end level: the last panel of each takes up any difference. */}
          <div className="flex flex-col gap-5 xl:col-span-8 [&>*:last-child]:flex-1">
            {can('monitoring.read') && <BandwidthPanel />}
            {can('monitoring.read') && <HealthOverviewPanel />}
            {can('dcim.read') && <PhysicalPanel />}
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:col-span-4 xl:flex xl:flex-col [&>*:last-child]:flex-1">
            <AttentionPanel o={o} />
            {can('power.read') && <PowerPanel />}
            <NetworkPanel />
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:col-span-12">
            {can('services.read') && <ColocationPanel />}
            <Panel
              title="Customers and access"
              className="@container h-full"
              actions={
                can('customers.read') && (
                  <Link to="/customers" className="text-[13px] text-accent hover:underline">
                    Customers
                  </Link>
                )
              }
            >
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 @2xl:grid-cols-3">
                {o.customers && <Stat label="Active customers" value={o.customers.active} note={`${o.customers.suspended} suspended, ${o.customers.closed} closed`} />}
                {o.users && <Stat label="Portal users" value={o.users.customer} note="Customer accounts" />}
                {o.users && <Stat label="Staff users" value={o.users.staff} note={o.users.disabled ? `${o.users.disabled} disabled` : 'Active accounts'} />}
                {o.activeSessions !== null && <Stat label="Signed-in sessions" value={o.activeSessions} note="Across all users" />}
                {o.audit && <Stat label="Failed sign-ins, 24 h" value={o.audit.failedLogins24h} tone={o.audit.failedLogins24h > 20 ? 'warn' : undefined} note={`${o.audit.events24h} events recorded`} />}
                {o.audit && (
                  <Stat
                    label="Access denied, 24 h"
                    value={o.audit.denied24h}
                    tone={o.audit.denied24h > 0 ? 'warn' : undefined}
                    note={
                      <Link to="/audit" className="text-accent hover:underline">
                        Audit log
                      </Link>
                    }
                  />
                )}
              </dl>
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

function CustomerOverview() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['my-customer'], queryFn: () => api.get<Customer>('/customers/me') });
  const colo = useQuery({ queryKey: ['colo', 'overview'], queryFn: () => api.get<ColoOverviewT>('/colocation/overview'), enabled: can('services.read'), refetchInterval: 60_000 });
  const c = q.data;
  const k = colo.data;
  return (
    <>
      <PageHeader title="Your account" description="Your equipment, space, power and bandwidth at a glance." />
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {c && (
          <Panel title={c.name} className="h-full xl:col-span-4" actions={<Chip tone={c.status === 'active' ? 'ok' : 'warn'}>{c.status === 'active' ? 'Active' : c.status === 'suspended' ? 'Suspended' : 'Closed'}</Chip>}>
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-[13px] text-ink-2">Account code</dt>
                <dd className="font-mono">{c.code}</dd>
              </div>
              <div>
                <dt className="text-[13px] text-ink-2">Phone</dt>
                <dd>{c.phone ?? '—'}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-[13px] text-ink-2">Contact email</dt>
                <dd className="truncate">{c.contactEmail ?? '—'}</dd>
              </div>
            </dl>
            <p className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              <Link to="/ipam" className="text-accent hover:underline">
                IP addresses
              </Link>
              <Link to="/network-monitoring" className="text-accent hover:underline">
                Bandwidth
              </Link>
              <Link to="/power" className="text-accent hover:underline">
                Power
              </Link>
              <Link to="/tickets" className="text-accent hover:underline">
                Tickets
              </Link>
            </p>
          </Panel>
        )}
        {k && (
          <Panel title="At a glance" className="@container h-full xl:col-span-8">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-5 @2xl:grid-cols-4">
              <Stat label="Equipment" value={k.equipment.devices} note={k.units ? `${k.units} U of rack space` : 'No rack space contracted'} />
              <Stat label="Power now" value={formatWattsShort(k.equipment.measuredW + k.equipment.estimatedW)} note={k.equipment.estimatedW ? `${formatWattsShort(k.equipment.estimatedW)} estimated` : 'All measured'} />
              <Stat
                label="Bandwidth now"
                value={k.bandwidth && k.bandwidth.ports ? `↓ ${bps(k.bandwidth.inBps)}` : '—'}
                note={k.bandwidth && k.bandwidth.ports ? `↑ ${bps(k.bandwidth.outBps)} · ${k.bandwidth.ports} port${k.bandwidth.ports === 1 ? '' : 's'}` : 'No monitored ports'}
              />
              <Stat label="Open requests" value={k.open.tickets + k.open.crossConnects + k.open.shipments + k.open.visits} note={`${k.open.tickets} tickets, ${k.activeServices} active services`} />
            </dl>
          </Panel>
        )}
        <CustomerSpace />
        <CustomerTickets />
        <CustomerSubnets />
        <div className="xl:col-span-12">
          <CustomerEquipment embedded />
        </div>
      </div>
    </>
  );
}

function CustomerSpace() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['colo', 'allocations', 'mine'], queryFn: () => api.get<AllocationT[]>('/colocation/allocations'), enabled: can('services.read') });
  if (!can('services.read')) return null;
  const rows = (q.data ?? []).filter((a) => a.active);
  return (
    <Panel
      title="Your rack space"
      className="h-full xl:col-span-4"
      flush
      actions={
        <Link to="/colocation" className="text-[13px] text-accent hover:underline">
          Colocation
        </Link>
      }
    >
      {q.isLoading && <Loading />}
      {q.data && !rows.length && <p className="px-4 py-3 text-[13px] text-ink-2">No rack space is contracted.</p>}
      <ul className="divide-y divide-rule">
        {rows.map((a) => {
          const used = a.power ? a.power.measuredW + a.power.estimatedW : null;
          const pct = used !== null && a.contractedPowerW ? Math.min(100, (used / a.contractedPowerW) * 100) : null;
          return (
            <li key={a.id} className="px-4 py-3">
              <div className="flex justify-between gap-3">
                <span className="font-medium">
                  {a.datacenterCode} · rack {a.rackName}
                </span>
                <span className="text-[13px] text-ink-2">
                  U{a.startU}–{a.endU} ({a.units} U)
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-3 text-[12.5px] text-ink-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                  <span className={`block h-full rounded-full ${a.power?.overContract ? 'bg-crit' : 'bg-accent'}`} style={{ width: `${pct ?? 0}%` }} />
                </span>
                <span className="whitespace-nowrap tabular-nums">
                  {used !== null ? formatWattsShort(used) : '—'} of {formatWattsShort(a.contractedPowerW)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function CustomerTickets() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['tickets', 'open', 'mine'], queryFn: () => api.get<{ items: TicketT[]; total: number }>('/tickets?status=open&pageSize=6'), enabled: can('tickets.read') });
  if (!can('tickets.read')) return null;
  const rows = q.data?.items ?? [];
  return (
    <Panel
      title={`Open tickets${q.data ? ` (${q.data.total})` : ''}`}
      className="h-full xl:col-span-4"
      flush
      actions={
        <Link to="/tickets" className="text-[13px] text-accent hover:underline">
          All tickets
        </Link>
      }
    >
      {q.isLoading && <Loading />}
      {q.data && !rows.length && <p className="px-4 py-3 text-[13px] text-ink-2">No open tickets.</p>}
      <ul className="divide-y divide-rule">
        {rows.map((t) => (
          <li key={t.id}>
            <Link to={`/tickets/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-sunken/50">
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  #{t.number} {t.subject}
                </span>
                <span className="text-[12px] text-ink-3">{formatDateTime(t.updatedAt)}</span>
              </span>
              <Chip tone={t.status === 'waiting_customer' ? 'warn' : 'neutral'}>{t.status === 'waiting_customer' ? 'Waiting for you' : t.status === 'in_progress' ? 'In progress' : 'Open'}</Chip>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function CustomerSubnets() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['ipam', 'prefixes', 'mine'], queryFn: () => api.get<PrefixT[]>('/ipam/prefixes'), enabled: can('ipam.read') });
  if (!can('ipam.read')) return null;
  const rows = q.data ?? [];
  return (
    <Panel
      title="Your IP subnets"
      className="h-full xl:col-span-4"
      flush
      actions={
        <Link to="/ipam" className="text-[13px] text-accent hover:underline">
          IP addresses
        </Link>
      }
    >
      {q.isLoading && <Loading />}
      {q.data && !rows.length && <p className="px-4 py-3 text-[13px] text-ink-2">No subnets are assigned to you.</p>}
      <ul className="divide-y divide-rule">
        {rows.slice(0, 8).map((p) => (
          <li key={p.id} className="px-4 py-2.5">
            <div className="flex justify-between gap-3">
              <span className="font-mono text-[13px]">{p.prefix}</span>
              <span className="text-[12.5px] text-ink-2 tabular-nums">
                {p.usedAddresses} / {p.usable} used
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, p.addressUtilization)}%` }} />
            </div>
            {p.gateway && <p className="mt-1 text-[12px] text-ink-3">Gateway {p.gateway}</p>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function OverviewPage() {
  const { me } = useAuth();
  return me?.user.userType === 'customer' ? <CustomerOverview /> : <StaffOverview />;
}
