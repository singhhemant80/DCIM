import { useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { Chip, ErrorNote, Loading, Panel, Stat, cx } from './ui';

export interface HealthT {
  deviceId: string;
  deviceName: string;
  category: string;
  platform: string | null;
  polling: boolean;
  pollError: string | null;
  at: string | null;
  fresh: boolean;
  cpuPct: number | null;
  cpuCount: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  memoryPct: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskPct: number | null;
  temperatureC: number | null;
  cpuTemperatureC: number | null;
  voltage: number | null;
  uptimeSeconds: number | null;
  version: string | null;
  board: string | null;
  sensors: { name: string; value: string; unit: string | null }[];
  healthError: string | null;
}
interface HistoryT {
  range: string;
  stepSeconds: number;
  points: { t: string; cpuPct: number | null; memoryPct: number | null; temperatureC: number | null }[];
}

/** Thresholds used everywhere health is shown: amber from 75 %, red from 90 % (temperature: 70 / 85 °C). */
export const strained = (h: Pick<HealthT, 'cpuPct' | 'memoryPct' | 'temperatureC' | 'fresh'>) => h.fresh && ((h.cpuPct ?? 0) >= 90 || (h.memoryPct ?? 0) >= 90 || (h.temperatureC ?? 0) >= 85);
const tone = (v: number | null, warn = 75, crit = 90) => (v === null ? 'bg-ink-3' : v >= crit ? 'bg-crit' : v >= warn ? 'bg-warn' : 'bg-ok');
const textTone = (v: number | null, warn = 75, crit = 90) => (v === null ? '' : v >= crit ? 'text-crit' : v >= warn ? 'text-warn' : '');

export function bytesShort(n: number | null) {
  if (n === null) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
export function uptime(s: number | null) {
  if (s === null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export function Meter({ pct, label, warn, crit }: { pct: number | null; label?: string; warn?: number; crit?: number }) {
  return (
    <span className="flex min-w-0 items-center gap-2" title={label}>
      <span className="h-1.5 w-full min-w-12 overflow-hidden rounded-full bg-sunken">
        <span className={cx('block h-full rounded-full', tone(pct, warn, crit))} style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
      </span>
      <span className={cx('w-11 shrink-0 text-right tabular-nums', textTone(pct, warn, crit))}>{pct === null ? '—' : `${Math.round(pct)}%`}</span>
    </span>
  );
}

export function useHealth() {
  return useQuery({ queryKey: ['monitoring', 'health'], queryFn: () => api.get<HealthT[]>('/monitoring/health'), refetchInterval: 30_000 });
}

/** Overview: every polled router and switch with CPU, memory, temperature and uptime. */
export function HealthOverviewPanel() {
  const q = useHealth();
  const items = q.data ?? [];
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  return (
    <Panel
      title="Network device health"
      flush
      actions={
        <Link to="/alerts?tab=polling" className="text-[13px] text-accent hover:underline">
          Polling
        </Link>
      }
    >
      {!items.length && <p className="px-4 py-3 text-[13px] text-ink-2">No device is polled yet. Turn on polling for your routers and switches in Monitoring &amp; Alerts → Polling; health is read with the same read-only credential.</p>}
      {items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px] [&_td]:border-t [&_td]:border-rule [&_td]:px-4 [&_td]:py-2 [&_th]:px-4 [&_th]:py-2 [&_th]:text-[12px] [&_th]:font-semibold [&_th]:text-ink-2">
            <thead>
              <tr>
                <th>Device</th>
                <th className="w-[22%]">CPU</th>
                <th className="w-[22%]">Memory</th>
                <th className="text-right">Temp.</th>
                <th className="text-right">Uptime</th>
              </tr>
            </thead>
            <tbody>
              {items.map((h) => (
                <tr key={h.deviceId} className={cx(!h.fresh && 'opacity-70')}>
                  <td className="whitespace-nowrap">
                    <Link to={`/network/devices/${h.deviceId}`} className="font-medium text-accent hover:underline">
                      {h.deviceName}
                    </Link>
                    <span className="block text-[11.5px] text-ink-3">
                      {!h.polling ? 'Polling paused' : h.pollError && !h.fresh ? <span className="text-crit">Poll failing: {h.pollError.slice(0, 60)}</span> : h.healthError && !h.at ? h.healthError.slice(0, 60) : h.at ? `${h.fresh ? '' : 'stale · '}${relativeTime(h.at)}` : 'Waiting for the first read'}
                      {h.version ? ` · ${h.version.split(' ')[0]}` : ''}
                    </span>
                  </td>
                  <td>
                    <Meter pct={h.cpuPct} label={h.cpuCount ? `${h.cpuCount} cores` : undefined} />
                  </td>
                  <td>
                    <Meter pct={h.memoryPct} label={h.memoryTotalBytes ? `${bytesShort(h.memoryUsedBytes)} of ${bytesShort(h.memoryTotalBytes)}` : undefined} />
                  </td>
                  <td className={cx('text-right whitespace-nowrap tabular-nums', textTone(h.temperatureC, 70, 85))}>{h.temperatureC === null ? '—' : `${Math.round(h.temperatureC)} °C`}</td>
                  <td className="text-right whitespace-nowrap text-ink-2">{uptime(h.uptimeSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** CPU, memory (%) and temperature (°C) over time, on one 0–100 scale. */
function HealthChart({ points, stepSeconds }: { points: HistoryT['points']; stepSeconds: number }) {
  const W = 760;
  const H = 200;
  const P = { l: 36, r: 10, t: 10, b: 24 };
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const pts = useMemo(() => points.map((p) => ({ ...p, ms: new Date(p.t).getTime() })), [points]);
  if (pts.length < 2) return <p className="py-6 text-center text-[13px] text-ink-3">The chart appears after a few readings (about one a minute).</p>;
  const t0 = pts[0]!.ms;
  const t1 = pts[pts.length - 1]!.ms;
  const maxY = Math.max(100, ...pts.map((p) => p.temperatureC ?? 0));
  const x = (ms: number) => P.l + ((ms - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / maxY) * (H - P.t - P.b);
  const line = (k: 'cpuPct' | 'memoryPct' | 'temperatureC') => {
    let d = '';
    let prev: number | null = null;
    for (const p of pts) {
      const v = p[k];
      if (v === null) {
        prev = null;
        continue;
      }
      d += `${prev === null || p.ms - prev > stepSeconds * 3000 ? 'M' : 'L'}${x(p.ms).toFixed(1)},${y(v).toFixed(1)}`;
      prev = p.ms;
    }
    return d;
  };
  const series = [
    { k: 'cpuPct' as const, label: 'CPU %', color: 'var(--rx)' },
    { k: 'memoryPct' as const, label: 'Memory %', color: 'var(--tx)' },
    ...(pts.some((p) => p.temperatureC !== null) ? [{ k: 'temperatureC' as const, label: 'Temperature °C', color: 'var(--est, #7c3aed)' }] : []),
  ];
  const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, t1 - t0 > 2 * 86400_000 ? { day: 'numeric', month: 'short', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  const h = hover !== null ? pts[hover] : null;
  return (
    <div>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto max-h-[260px] w-full"
        role="img"
        aria-label="CPU, memory and temperature over time"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = svg.current!.getBoundingClientRect();
          const ms = t0 + ((((e.clientX - r.left) / r.width) * W - P.l) / (W - P.l - P.r)) * (t1 - t0);
          let best = 0;
          pts.forEach((p, i) => Math.abs(p.ms - ms) < Math.abs(pts[best]!.ms - ms) && (best = i));
          setHover(best);
        }}
      >
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--rule)" />
            <text x={P.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10.5" fill="var(--ink-3)">
              {v}
            </text>
          </g>
        ))}
        {[t0, (t0 + t1) / 2, t1].map((ms, i) => (
          <text key={i} x={x(ms)} y={H - 6} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'} fontSize="10.5" fill="var(--ink-3)">
            {fmt(ms)}
          </text>
        ))}
        {series.map((s) => (
          <path key={s.k} d={line(s.k)} fill="none" stroke={s.color} strokeWidth="1.6" />
        ))}
        {h && <line x1={x(h.ms)} x2={x(h.ms)} y1={P.t} y2={H - P.b} stroke="var(--ink-3)" strokeDasharray="3 3" />}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-2">
        {series.map((s) => (
          <span key={s.k} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: s.color }} /> {s.label}
            {h && <b className="tabular-nums">{h[s.k] === null ? '—' : Math.round(h[s.k]!)}</b>}
          </span>
        ))}
        {h && <span className="text-ink-3">{new Date(h.ms).toLocaleString()}</span>}
      </div>
    </div>
  );
}

/** A router's or switch's health on its page: figures, sensors and the history chart. */
export function DeviceHealthPanel({ deviceId }: { deviceId: string }) {
  const list = useHealth();
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  const hist = useQuery({ queryKey: ['monitoring', 'health', deviceId, range], queryFn: () => api.get<HistoryT>(`/monitoring/health/${deviceId}/history?range=${range}`), refetchInterval: 60_000, placeholderData: keepPreviousData });
  const h = list.data?.find((x) => x.deviceId === deviceId);
  if (list.isLoading) return null;
  if (!h) return null; // not polled: nothing to show (polling is set up under Monitoring & Alerts)
  return (
    <Panel
      title="Health"
      actions={
        <span className="flex items-center gap-2">
          {h.at && <span className="text-[12.5px] text-ink-3">Read {relativeTime(h.at)}</span>}
          {strained(h) && <Chip tone="crit">Under strain</Chip>}
          <span className="inline-flex rounded-lg border border-rule p-0.5 text-[12.5px]" role="group" aria-label="History range">
            {(['24h', '7d', '30d'] as const).map((r) => (
              <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} className={range === r ? 'rounded-md bg-field px-2 py-0.5 font-medium' : 'rounded-md px-2 py-0.5 text-ink-3 hover:text-ink'}>
                {r}
              </button>
            ))}
          </span>
        </span>
      }
    >
      {h.healthError && <p className="mb-3 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">Last health read failed: {h.healthError}</p>}
      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="CPU" value={<span className={textTone(h.cpuPct)}>{h.cpuPct === null ? '—' : `${Math.round(h.cpuPct)}%`}</span>} note={h.cpuCount ? `${h.cpuCount} core${h.cpuCount === 1 ? '' : 's'}` : undefined} />
        <Stat label="Memory" value={<span className={textTone(h.memoryPct)}>{h.memoryPct === null ? '—' : `${Math.round(h.memoryPct)}%`}</span>} note={h.memoryTotalBytes ? `${bytesShort(h.memoryUsedBytes)} of ${bytesShort(h.memoryTotalBytes)}` : undefined} />
        <Stat label="Storage" value={h.diskPct === null ? '—' : `${Math.round(h.diskPct)}%`} note={h.diskTotalBytes ? `${bytesShort(h.diskUsedBytes)} of ${bytesShort(h.diskTotalBytes)}` : undefined} />
        <Stat label="Temperature" value={<span className={textTone(h.temperatureC, 70, 85)}>{h.temperatureC === null ? '—' : `${Math.round(h.temperatureC)} °C`}</span>} note={h.cpuTemperatureC !== null ? `CPU ${Math.round(h.cpuTemperatureC)} °C` : undefined} />
        <Stat label="Voltage" value={h.voltage === null ? '—' : `${h.voltage.toFixed(1)} V`} />
        <Stat label="Uptime" value={uptime(h.uptimeSeconds)} note={[h.board, h.version].filter(Boolean).join(' · ') || undefined} />
      </dl>
      {h.sensors.length > 0 && (
        <p className="mb-4 flex flex-wrap gap-2 text-[12.5px]">
          {h.sensors.map((s) => (
            <span key={s.name} className={cx('rounded-md border border-rule px-2 py-0.5', /fail|bad|error/i.test(s.value) && 'border-crit text-crit')}>
              {s.name}: <b>{s.value}</b>
              {s.unit && ` ${s.unit}`}
            </span>
          ))}
        </p>
      )}
      <ErrorNote error={hist.error} />
      {hist.data && <HealthChart points={hist.data.points} stepSeconds={hist.data.stepSeconds} />}
      <p className="mt-2 text-[12px] text-ink-3">Read about once a minute with the device's polling credential (read-only). History is kept 30 days.</p>
    </Panel>
  );
}
