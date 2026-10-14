import { useMemo, useRef, useState } from 'react';
import { formatBitRate } from '@crapplet/shared';
import { niceMax, tickLabel, timeLabel } from './RateChart';

export interface Series {
  key: string;
  label: string;
  color: string;
  points: { t: number; v: number | null }[];
  dashed?: boolean;
}

/**
 * Distinct colours per uplink: download (in) and upload (out) of each link get
 * their own colour, so four lines for two uplinks never share one.
 */
export const UPLINK_COLORS: { in: string; out: string }[] = [
  { in: '#2563eb', out: '#ea580c' },
  { in: '#16a34a', out: '#c026d3' },
  { in: '#0891b2', out: '#dc2626' },
  { in: '#ca8a04', out: '#7c3aed' },
  { in: '#0d9488', out: '#db2777' },
];
export const uplinkColors = (i: number) => UPLINK_COLORS[i % UPLINK_COLORS.length]!;

const W = 760;
const H = 260;
const PAD = { l: 78, r: 12, t: 12, b: 26 };

/**
 * Several traffic series on one time axis. Gaps longer than 2.5 steps break
 * the line (no data is invented). Click a legend entry to hide or show it.
 */
export function MultiRateChart({ series, stepSeconds, from, to, label }: { series: Series[]; stepSeconds: number; from: number; to: number; label: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const shown = series.filter((s) => !hidden.has(s.key));
  const span = Math.max(1, to - from);
  const max = useMemo(() => niceMax(Math.max(0, ...shown.flatMap((s) => s.points.map((p) => p.v ?? 0)))), [shown]);
  const x = (t: number) => PAD.l + ((t - from) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);
  const segments = (pts: Series['points']) => {
    const segs: { t: number; v: number }[][] = [];
    let cur: { t: number; v: number }[] = [];
    let prevT: number | null = null;
    for (const p of pts) {
      if (p.v === null || (prevT !== null && p.t - prevT > stepSeconds * 2500)) {
        if (cur.length) segs.push(cur);
        cur = [];
      }
      if (p.v !== null) cur.push({ t: p.t, v: p.v });
      prevT = p.t;
    }
    if (cur.length) segs.push(cur);
    return segs;
  };
  const line = (seg: { t: number; v: number }[]) => seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const xticks = Array.from({ length: 5 }, (_, i) => from + (span * i) / 4);
  // The reading nearest the cursor, only if one is within 2.5 steps (no invented values).
  const valueAt = (s: Series, t: number) => {
    const p = s.points.reduce<{ t: number; v: number | null } | null>((b, q) => (b === null || Math.abs(q.t - t) < Math.abs(b.t - t) ? q : b), null);
    return p && Math.abs(p.t - t) <= stepSeconds * 2500 ? p : null;
  };
  const onMove = (e: React.MouseEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < PAD.l || px > W - PAD.r) return setHover(null);
    setHover(from + ((px - PAD.l) / (W - PAD.l - PAD.r)) * span);
  };
  const toggle = (k: string) => setHidden((h) => (h.has(k) ? new Set([...h].filter((x) => x !== k)) : new Set([...h, k])));
  return (
    <figure className="relative">
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--rule)" />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10.5" fill="var(--ink-3)">
              {tickLabel(v)}
            </text>
          </g>
        ))}
        {xticks.map((t, i) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fontSize="10.5" fill="var(--ink-3)">
            {timeLabel(t, span)}
          </text>
        ))}
        {shown.map((s) =>
          segments(s.points).map((seg, i) =>
            seg.length > 1 ? (
              <path key={`${s.key}${i}`} d={line(seg)} fill="none" stroke={s.color} strokeWidth="1.6" strokeDasharray={s.dashed ? '5 3' : undefined} />
            ) : (
              <circle key={`${s.key}${i}`} cx={x(seg[0]!.t)} cy={y(seg[0]!.v)} r="2" fill={s.color} />
            ),
          ),
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-3)" strokeWidth="1" />}
      </svg>
      {hover !== null && (
        <div className="glass pointer-events-none absolute top-2 rounded-lg px-2.5 py-1.5 text-[12px] shadow" style={{ left: `${Math.min(62, (x(hover) / W) * 100)}%` }}>
          <div className="text-ink-3">{new Date(hover).toLocaleString()}</div>
          {shown.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} aria-hidden />
              {s.label} <span className="ml-auto pl-2 tabular-nums">{valueAt(s, hover) ? formatBitRate(valueAt(s, hover)!.v) : 'no data'}</span>
            </div>
          ))}
        </div>
      )}
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px]">
        {series.map((s) => (
          <button key={s.key} type="button" onClick={() => toggle(s.key)} aria-pressed={!hidden.has(s.key)} className={hidden.has(s.key) ? 'flex items-center gap-1.5 text-ink-3 line-through' : 'flex items-center gap-1.5 text-ink-2'}>
            <span className="inline-block h-[3px] w-4 rounded" style={{ background: s.color }} aria-hidden />
            {s.label}
          </button>
        ))}
        <span className="text-ink-3">Click a name to hide or show it. Breaks in a line are periods with no measurement.</span>
      </figcaption>
    </figure>
  );
}
