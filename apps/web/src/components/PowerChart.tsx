import { useMemo, useState } from 'react';
import { formatWattsShort } from '@crapplet/shared';
import { sourceLabel } from '../lib/power';

const W = 760;
const H = 220;
const PAD = { l: 64, r: 12, t: 12, b: 26 };
const SOURCE_COLORS: Record<string, string> = { pdu_outlet: 'var(--rx)', redfish: 'var(--accent)', ipmi: 'var(--tx)', nxos: 'var(--ok)', routeros: 'var(--ok)', snmp: 'var(--warn)' };

function niceMax(v: number): number {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
const timeLabel = (t: number, span: number) => (span > 2 * 86400_000 ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));

function Axes({ max, from, to, y }: { max: number; from: number; to: number; y: (v: number) => number }) {
  const span = to - from;
  const x = (t: number) => PAD.l + ((t - from) / span) * (W - PAD.l - PAD.r);
  return (
    <>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(f * max)} y2={y(f * max)} stroke="var(--rule)" />
          <text x={PAD.l - 6} y={y(f * max) + 4} textAnchor="end" fontSize="10.5" fill="var(--ink-3)">
            {formatWattsShort(f * max)}
          </text>
        </g>
      ))}
      {Array.from({ length: 5 }, (_, i) => from + (span * i) / 4).map((t, i) => (
        <text key={t} x={x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fontSize="10.5" fill="var(--ink-3)">
          {timeLabel(t, span)}
        </text>
      ))}
    </>
  );
}

/** Raw readings, one line per source; a gap longer than three typical steps breaks the line. */
export function PowerReadingsChart({ raw, from, to }: { raw: { source: string; at: string; watts: number }[]; from: number; to: number }) {
  const series = useMemo(() => {
    const m = new Map<string, { t: number; w: number }[]>();
    for (const r of raw) m.set(r.source, [...(m.get(r.source) ?? []), { t: new Date(r.at).getTime(), w: r.watts }]);
    return [...m.entries()];
  }, [raw]);
  const max = niceMax(Math.max(0, ...raw.map((r) => r.watts)));
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const x = (t: number) => PAD.l + ((t - from) / (to - from)) * (W - PAD.l - PAD.r);
  const path = (pts: { t: number; w: number }[]) => {
    const steps = pts.slice(1).map((p, i) => p.t - pts[i]!.t).sort((a, b) => a - b);
    const step = steps[Math.floor(steps.length / 2)] ?? 60_000;
    return pts.map((p, i) => `${i === 0 || p.t - pts[i - 1]!.t > step * 3 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.w).toFixed(1)}`).join('');
  };
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Measured power readings">
        <Axes max={max} from={from} to={to} y={y} />
        {series.map(([s, pts]) => (
          <path key={s} d={path(pts)} fill="none" stroke={SOURCE_COLORS[s] ?? 'var(--accent)'} strokeWidth="1.6" />
        ))}
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {series.map(([s]) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ background: SOURCE_COLORS[s] ?? 'var(--accent)' }} /> {sourceLabel(s)} (measured)
          </span>
        ))}
        <span className="text-ink-3">Every reading as collected. Breaks are periods without readings. When sources overlap, totals use the highest-priority one.</span>
      </figcaption>
    </figure>
  );
}

export interface HourT {
  hour: string;
  measuredKwh: number;
  measuredSeconds: number;
  estimatedKwh: number;
  estimatedSeconds: number;
  unknownSeconds: number;
}

/** Hourly energy as bars: measured (solid) and estimated (striped) stacked, unknown time marked below. Bar height = average watts over the hour. */
export function PowerHourlyChart({ hours, from, to }: { hours: HourT[]; from: number; to: number }) {
  const [hover, setHover] = useState<HourT | null>(null);
  const max = niceMax(Math.max(0, ...hours.map((h) => (h.measuredKwh + h.estimatedKwh) * 1000)));
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const x = (t: number) => PAD.l + ((t - from) / (to - from)) * (W - PAD.l - PAD.r);
  const bw = Math.max(1, x(from + 3600_000) - x(from) - 0.5);
  return (
    <figure className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Hourly energy, measured and estimated" onMouseLeave={() => setHover(null)}>
        <defs>
          <pattern id="est-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" fill="var(--est)" opacity="0.18" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--est)" strokeWidth="1.5" />
          </pattern>
        </defs>
        <Axes max={max} from={from} to={to} y={y} />
        {hours.map((h) => {
          const t = new Date(h.hour).getTime();
          const m = h.measuredKwh * 1000;
          const e = h.estimatedKwh * 1000;
          return (
            <g key={h.hour} onMouseEnter={() => setHover(h)}>
              <rect x={x(t)} y={PAD.t} width={bw} height={H - PAD.t - PAD.b} fill="transparent" />
              {m > 0 && <rect x={x(t)} y={y(m)} width={bw} height={y(0) - y(m)} fill="var(--accent)" opacity="0.85" />}
              {e > 0 && <rect x={x(t)} y={y(m + e)} width={bw} height={y(m) - y(m + e)} fill="url(#est-hatch)" />}
              {h.unknownSeconds > 0 && <rect x={x(t)} y={y(0) + 2} width={bw} height={3} fill="var(--warn)" />}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="glass pointer-events-none absolute top-2 right-2 rounded-lg px-2.5 py-1.5 text-[12px] shadow">
          <div className="text-ink-3">{new Date(hover.hour).toLocaleString()}</div>
          <div>Measured {(hover.measuredKwh * 1000).toFixed(0)} Wh ({Math.round(hover.measuredSeconds / 60)} min)</div>
          <div>Estimated {(hover.estimatedKwh * 1000).toFixed(0)} Wh ({Math.round(hover.estimatedSeconds / 60)} min)</div>
          {hover.unknownSeconds > 0 && <div className="text-warn">Unknown {Math.round(hover.unknownSeconds / 60)} min</div>}
        </div>
      )}
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-3 rounded-sm bg-accent" /> Measured
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden>
            <rect width="12" height="12" fill="url(#est-hatch)" />
          </svg>{' '}
          Estimated
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1 w-3 bg-warn" /> No measurement and no estimate
        </span>
        <span className="text-ink-3">Bar height is the hour's average draw.</span>
      </figcaption>
    </figure>
  );
}
