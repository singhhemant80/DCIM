import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { RATE_RANGES, type RateRange } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { SKIP_LABELS, bps, pct, perSec, useMonitoringStream, withLive, type PortHistoryT, type PortRateT, type TotalsHistoryT, type TotalsT } from '../lib/monitoring';
import { RateChart } from '../components/RateChart';
import { Chip, EmptyState, ErrorNote, Input, Loading, PageHeader, Pagination, Panel, Select, Stat, Table, cx } from '../components/ui';

const RANGE_LABELS: Record<RateRange, string> = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days' };
const RANGE_MS: Record<RateRange, number> = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };

export function LiveBadge({ connected, feed }: { connected: boolean; feed: boolean | null }) {
  if (!connected) return <Chip tone="warn" title="Reconnecting to the live feed; figures still refresh every 30 s">Reconnecting…</Chip>;
  if (feed === false) return <Chip tone="warn" title="The server could not reach Redis; figures refresh every 30 s instead">Live feed unavailable</Chip>;
  return (
    <Chip tone="ok" title="Rates update as soon as each device is polled">
      <span className="size-1.5 animate-pulse rounded-full bg-ok" aria-hidden /> Live
    </Chip>
  );
}

/** Utilization bar: the busier direction, coloured by level. */
export function UtilBar({ p }: { p: PortRateT }) {
  const v = p.utilIn === null && p.utilOut === null ? null : Math.max(p.utilIn ?? 0, p.utilOut ?? 0);
  if (v === null) return <span className="text-ink-3" title={p.speedBps ? 'No measurement' : 'Port speed unknown, so utilization is not computed'}>—</span>;
  const tone = v >= 90 ? 'bg-crit' : v >= 70 ? 'bg-warn' : 'bg-ok';
  return (
    <span className="flex items-center gap-2" title={`In ${pct(p.utilIn)}, out ${pct(p.utilOut)}`}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-sunken">
        <span className={cx('block h-full rounded-full', tone)} style={{ width: `${Math.min(100, v)}%` }} />
      </span>
      <span className="tabular-nums">{pct(v)}</span>
    </span>
  );
}

function StatusCell({ p }: { p: PortRateT }) {
  if (p.operUp === null) return <span className="text-ink-3">—</span>;
  if (!p.enabled) return <Chip>Disabled</Chip>;
  return p.operUp ? <Chip tone="ok">Up</Chip> : <Chip tone="crit">Down</Chip>;
}

function UpdatedCell({ p }: { p: PortRateT }) {
  if (!p.sampledAt) return <span className="text-ink-3">{p.pollingEnabled ? 'Waiting for first poll' : 'Polling off'}</span>;
  if (p.lastSkip) return <span className="text-ink-3" title={SKIP_LABELS[p.lastSkip] ?? p.lastSkip}>{relativeTime(p.sampledAt)} · no rate</span>;
  if (!p.fresh) return <span className="text-warn" title="No recent measurement; the last rate is not shown">Stale ({relativeTime(p.lastRateAt)})</span>;
  return <span className="text-ink-3">{relativeTime(p.sampledAt)}</span>;
}

function TotalsPanel() {
  const [range, setRange] = useState<RateRange>('24h');
  const totals = useQuery({ queryKey: ['monitoring', 'totals'], queryFn: () => api.get<TotalsT>('/monitoring/totals'), refetchInterval: 30_000 });
  const hist = useQuery({ queryKey: ['monitoring', 'totals', 'history', range], queryFn: () => api.get<TotalsHistoryT>(`/monitoring/totals/history${qs({ range })}`), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const t = totals.data;
  if (totals.isLoading) return <Loading />;
  if (totals.error) return <ErrorNote error={totals.error} />;
  if (!t || t.ports === 0) {
    return (
      <Panel title="Total traffic">
        <p className="text-[13px] text-ink-2">
          No ports count towards totals yet. Mark your uplink and transit ports with <em>Count in totals</em> on the port (Network → device → Ports). A LAG and its member ports are counted once.
        </p>
      </Panel>
    );
  }
  const now = Date.now();
  return (
    <Panel
      title="Total traffic (uplinks and transit)"
      actions={
        <Select className="w-32" value={range} onChange={(e) => setRange(e.target.value as RateRange)} aria-label="Chart range">
          {RATE_RANGES.filter((r) => r !== '1h' && r !== '6h').map((r) => (
            <option key={r} value={r}>
              {RANGE_LABELS[r]}
            </option>
          ))}
        </Select>
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat label="Inbound now" value={bps(t.inBps)} />
        <Stat label="Outbound now" value={bps(t.outBps)} />
        <Stat label="Ports counted" value={t.ports} note={t.excludedLagMembers ? `${t.excludedLagMembers} LAG member port(s) not double counted` : undefined} />
        <Stat label="Without a recent reading" value={t.stalePorts} tone={t.stalePorts ? 'warn' : undefined} note={t.stalePorts ? 'Not included in the sum' : 'All measured'} />
      </dl>
      {hist.data && hist.data.points.length > 0 ? (
        <>
          <RateChart label="Total traffic" points={hist.data.points.map((p) => ({ t: new Date(p.t).getTime(), inBps: p.inBps, outBps: p.outBps }))} stepSeconds={hist.data.stepSeconds} from={now - RANGE_MS[range]} to={now} p95={hist.data.p95} />
          <p className="mt-2 text-[12.5px] text-ink-3">
            95th percentile over {RANGE_LABELS[range].toLowerCase()}: in {bps(hist.data.p95.inBps)}, out {bps(hist.data.p95.outBps)} ({hist.data.p95.samples} {hist.data.stepSeconds === 300 ? '5-minute' : 'hourly'} samples). Sums cover the ports that had data in each interval.
          </p>
        </>
      ) : (
        <p className="text-[13px] text-ink-3">History appears after the first few minutes of polling (5-minute aggregates).</p>
      )}
    </Panel>
  );
}

function PortDetail({ port, onClose }: { port: PortRateT; onClose: () => void }) {
  const [range, setRange] = useState<RateRange>('1h');
  const h = useQuery({ queryKey: ['monitoring', 'history', port.interfaceId, range], queryFn: () => api.get<PortHistoryT>(`/monitoring/ports/${port.interfaceId}/history${qs({ range })}`), refetchInterval: range === '1h' ? 30_000 : 120_000, placeholderData: keepPreviousData });
  const now = Date.now();
  const d = h.data;
  return (
    <Panel
      title={
        <span>
          {port.deviceName} <span className="font-mono">{port.name}</span>
          {port.description && <span className="ml-2 font-normal text-ink-3">{port.description}</span>}
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          <Select className="w-32" value={range} onChange={(e) => setRange(e.target.value as RateRange)} aria-label="Chart range">
            {RATE_RANGES.map((r) => (
              <option key={r} value={r}>
                {RANGE_LABELS[r]}
              </option>
            ))}
          </Select>
          <button className="rounded-md px-2 py-1 text-[13px] text-ink-2 hover:bg-sunken" onClick={onClose} aria-label="Close chart">
            ✕
          </button>
        </div>
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-5">
        <Stat label="In now" value={bps(port.inBps)} note={port.utilIn !== null ? `${pct(port.utilIn)} of ${bps(port.speedBps)}` : port.speedBps ? undefined : 'Speed unknown'} />
        <Stat label="Out now" value={bps(port.outBps)} note={port.utilOut !== null ? `${pct(port.utilOut)} of ${bps(port.speedBps)}` : undefined} />
        <Stat label="95th pct in" value={bps(d?.p95.inBps)} note={d ? `${d.p95.samples} × 5-min averages` : undefined} />
        <Stat label="95th pct out" value={bps(d?.p95.outBps)} />
        <Stat label="Errors / discards" value={`${perSec(port.errorsPs)} · ${perSec(port.discardsPs)}`} tone={(port.errorsPs ?? 0) > 0 ? 'warn' : undefined} />
      </dl>
      <ErrorNote error={h.error} />
      {h.isLoading && <Loading />}
      {d && d.points.length === 0 && <EmptyState title="No measurements in this range">{range === '1h' || range === '6h' ? 'Rates appear after two polls of the device.' : 'Longer ranges use 5-minute and hourly aggregates, built every minute from the raw readings.'}</EmptyState>}
      {d && d.points.length > 0 && (
        <>
          <RateChart
            label={`Traffic on ${port.deviceName} ${port.name}`}
            points={d.points.map((p) => ({ t: new Date(p.t).getTime(), inBps: p.inBps, outBps: p.outBps, inMax: p.inMax, outMax: p.outMax }))}
            stepSeconds={d.stepSeconds}
            from={now - RANGE_MS[range]}
            to={now}
            p95={d.p95}
          />
          <p className="mt-2 text-[12.5px] text-ink-3">
            {d.resolution === 'raw' ? `Every poll (${d.stepSeconds} s).` : d.resolution === '5m' ? '5-minute averages (hover for the peak in each).' : 'Hourly averages (hover for the peak in each).'} All values are measured from interface counters. 95th percentile by nearest rank over 5-minute averages.
            {d.points.some((p) => p.flags.includes('wrap')) && ' Some readings crossed a 32-bit counter wrap and were corrected.'}
          </p>
        </>
      )}
    </Panel>
  );
}

export function NetworkMonitoringPage() {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<'traffic' | 'utilization' | 'errors' | 'name'>('traffic');
  const [totalsOnly, setTotalsOnly] = useState(false);
  const [page, setPage] = useState(1);
  const deviceId = params.get('device') ?? undefined;
  const selectedId = params.get('port');
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(h);
  }, [q]);
  const stream = useMonitoringStream();
  const ports = useQuery({
    queryKey: ['monitoring', 'ports', debounced, sort, totalsOnly, page, deviceId],
    queryFn: () => api.get<Paginated<PortRateT>>(`/monitoring/ports${qs({ q: debounced, sort, totalsOnly: totalsOnly ? 'true' : undefined, page, pageSize: 50, deviceId })}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => (ports.data?.items ?? []).map((p) => withLive(p, stream.live)), [ports.data, stream.live]);
  const selected = rows.find((r) => r.interfaceId === selectedId);
  const extra = useQuery({ queryKey: ['monitoring', 'port', selectedId], queryFn: () => api.get<PortRateT>(`/monitoring/ports/${selectedId}`), enabled: !!selectedId && !selected });
  const detail = selected ?? (extra.data ? withLive(extra.data, stream.live) : undefined);
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('port', id);
    else next.delete('port');
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Network monitoring"
        description={
          staff
            ? 'Live per-port traffic measured from interface counters. Polling is read-only and runs in the background whether or not this page is open. Ports without a recent reading show no value rather than a guess.'
            : 'Traffic on your ports, measured from the switch and router interface counters.'
        }
        actions={<LiveBadge connected={stream.connected} feed={stream.feed} />}
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        {staff && !deviceId && <TotalsPanel />}
        {detail && <PortDetail key={detail.interfaceId} port={detail} onClose={() => select(null)} />}
        <Panel
          flush
          title={deviceId && rows[0] ? `Ports on ${rows[0].deviceName}` : 'Ports'}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {deviceId && (
                <button className="text-[13px] text-accent hover:underline" onClick={() => setParams({}, { replace: true })}>
                  All devices
                </button>
              )}
              <Input className="w-48" placeholder="Search port or device" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} aria-label="Search ports" />
              <Select className="w-40" value={sort} onChange={(e) => (setSort(e.target.value as typeof sort), setPage(1))} aria-label="Sort">
                <option value="traffic">Most traffic</option>
                <option value="utilization">Highest utilization</option>
                <option value="errors">Most errors</option>
                <option value="name">Device and port</option>
              </Select>
              {staff && (
                <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  <input type="checkbox" checked={totalsOnly} onChange={(e) => (setTotalsOnly(e.target.checked), setPage(1))} /> Uplinks only
                </label>
              )}
            </div>
          }
        >
          <ErrorNote error={ports.error} className="m-4" />
          {ports.isLoading && <Loading />}
          {ports.data && ports.data.total === 0 && (
            <EmptyState title={debounced || totalsOnly ? 'No matching ports' : 'No monitored ports yet'}>
              {staff ? (
                <>
                  Turn on polling for a router or switch in <Link to="/alerts?tab=polling" className="text-accent hover:underline">Monitoring &amp; Alerts → Polling</Link>. It uses the device's stored read-only credential (SNMP, RouterOS, FortiOS or NX-API) and matches counters to the ports in inventory by name.
                </>
              ) : (
                'Traffic will appear here once the ports connected to your equipment are monitored.'
              )}
            </EmptyState>
          )}
          {rows.length > 0 && (
            <Table label="Monitored ports">
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Port</th>
                  <th>Status</th>
                  <th className="text-right">In</th>
                  <th className="text-right">Out</th>
                  <th>Utilization</th>
                  <th className="text-right">Errors · discards</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.interfaceId} className={cx('cursor-pointer hover:bg-sunken/60', p.interfaceId === selectedId && 'bg-accent-soft')} onClick={() => select(p.interfaceId)}>
                    <td className="font-medium">{p.deviceName}</td>
                    <td>
                      <button className="font-mono text-[13px] text-accent hover:underline" onClick={(e) => (e.stopPropagation(), select(p.interfaceId))}>
                        {p.name}
                      </button>
                      {p.countInTotals && staff && (
                        <span className="ml-1.5">
                          <Chip tone="accent" title="Counts towards totals">
                            Σ
                          </Chip>
                        </span>
                      )}
                      {p.description && <span className="block max-w-[28ch] truncate text-[12px] text-ink-3">{p.description}</span>}
                    </td>
                    <td>
                      <StatusCell p={p} />
                    </td>
                    <td className="text-right tabular-nums">{p.fresh ? bps(p.inBps) : <span className="text-ink-3">—</span>}</td>
                    <td className="text-right tabular-nums">{p.fresh ? bps(p.outBps) : <span className="text-ink-3">—</span>}</td>
                    <td>{p.fresh ? <UtilBar p={p} /> : <span className="text-ink-3">—</span>}</td>
                    <td className={cx('text-right tabular-nums text-[13px]', (p.errorsPs ?? 0) > 0 && 'text-warn')}>{p.fresh ? `${perSec(p.errorsPs)} · ${perSec(p.discardsPs)}` : <span className="text-ink-3">—</span>}</td>
                    <td className="text-[13px]">
                      <UpdatedCell p={p} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {ports.data && ports.data.total > ports.data.pageSize && (
            <div className="border-t border-rule px-4 py-2">
              <Pagination page={page} pageSize={ports.data.pageSize} total={ports.data.total} onPage={setPage} />
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
