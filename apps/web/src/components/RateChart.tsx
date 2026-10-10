import { useMemo, useRef, useState } from 'react';
import { formatBitRate } from '@crapplet/shared';

export interface ChartPoint {
  t: number;
  inBps: number | null;
  outBps: number | null;
  inMax?: number | null;
  outMax?: number | null;
}

const W = 760;
const H = 240;
const PAD = { l: 78, r: 12, t: 12, b: 26 };

function niceMax(v: number): number {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/** "500 Mbps", "1.5 Gbps": no decimals unless the value needs one. */
function tickLabel(v: number): string {
  if (v <= 0) return '0';
  const scaled = v / 1000 ** Math.min(4, Math.floor(Math.log10(v) / 3));
  return formatBitRate(v, Math.abs(scaled - Math.round(scaled)) < 0.001 ? 0 : 1);
}

function timeLabel(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs > 2 * 86400_000) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Inbound/outbound traffic over time as SVG. A gap longer than 2.5 steps is
 * drawn as a break in the line (no data), never interpolated. Dashed lines
 * mark the 95th percentile when given.
 */
export function RateChart({ points, stepSeconds, from, to, p95, label }: { points: ChartPoint[]; stepSeconds: number; from: number; to: number; p95?: { inBps: number | null; outBps: number | null } | null; label: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const span = Math.max(1, to - from);
  const max = useMemo(() => niceMax(Math.max(0, ...points.flatMap((p) => [p.inBps ?? 0, p.outBps ?? 0]), p95?.inBps ?? 0, p95?.outBps ?? 0)), [points, p95]);
  const x = (t: number) => PAD.l + ((t - from) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / max) * (H - PAD.t - PAD.b);

  const segments = (key: 'inBps' | 'outBps') => {
    const segs: { t: number; v: number }[][] = [];
    let cur: { t: number; v: number }[] = [];
    let prevT: number | null = null;
    for (const p of points) {
      const v = p[key];
      if (v === null || (prevT !== null && p.t - prevT > stepSeconds * 2500)) {
        if (cur.length) segs.push(cur);
        cur = [];
      }
      if (v !== null) cur.push({ t: p.t, v });
      prevT = p.t;
    }
    if (cur.length) segs.push(cur);
    return segs;
  };
  const line = (seg: { t: number; v: number }[]) => seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = (seg: { t: number; v: number }[]) => (seg.length > 1 ? `${line(seg)}L${x(seg.at(-1)!.t).toFixed(1)},${y(0)}L${x(seg[0]!.t).toFixed(1)},${y(0)}Z` : '');
  const ins = segments('inBps');
  const outs = segments('outBps');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const xticks = Array.from({ length: 5 }, (_, i) => from + (span * i) / 4);

  const nearest = hover === null ? null : points.reduce<ChartPoint | null>((best, p) => (best === null || Math.abs(p.t - hover) < Math.abs(best.t - hover) ? p : best), null);
  const onMove = (e: React.MouseEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    if (px < PAD.l || px > W - PAD.r) return setHover(null);
    setHover(from + ((px - PAD.l) / (W - PAD.l - PAD.r)) * span);
  };

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
        {ins.map((s, i) => (
          <path key={`ia${i}`} d={area(s)} fill="var(--rx)" opacity="0.1" />
        ))}
        {ins.map((s, i) => (
          <path key={`il${i}`} d={line(s)} fill="none" stroke="var(--rx)" strokeWidth="1.6" />
        ))}
        {outs.map((s, i) => (
          <path key={`ol${i}`} d={line(s)} fill="none" stroke="var(--tx)" strokeWidth="1.6" />
        ))}
        {/* Isolated single readings would otherwise be invisible. */}
        {[...ins, ...outs].filter((s) => s.length === 1).map((s, i) => (
          <circle key={`d${i}`} cx={x(s[0]!.t)} cy={y(s[0]!.v)} r="2" fill={ins.includes(s) ? 'var(--rx)' : 'var(--tx)'} />
        ))}
        {p95?.inBps != null && <line x1={PAD.l} x2={W - PAD.r} y1={y(p95.inBps)} y2={y(p95.inBps)} stroke="var(--rx)" strokeDasharray="5 4" strokeWidth="1" />}
        {p95?.outBps != null && <line x1={PAD.l} x2={W - PAD.r} y1={y(p95.outBps)} y2={y(p95.outBps)} stroke="var(--tx)" strokeDasharray="5 4" strokeWidth="1" />}
        {nearest && <line x1={x(nearest.t)} x2={x(nearest.t)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-3)" strokeWidth="1" />}
      </svg>
      {nearest && (
        <div className="glass pointer-events-none absolute top-2 rounded-lg px-2.5 py-1.5 text-[12px] shadow" style={{ left: `${Math.min(70, (x(nearest.t) / W) * 100)}%` }}>
          <div className="text-ink-3">{new Date(nearest.t).toLocaleString()}</div>
          <div>
            <span className="text-rx">In</span> {formatBitRate(nearest.inBps)}
            {nearest.inMax != null && nearest.inMax !== nearest.inBps && <span className="text-ink-3"> (peak {formatBitRate(nearest.inMax)})</span>}
          </div>
          <div>
            <span className="text-tx">Out</span> {formatBitRate(nearest.outBps)}
            {nearest.outMax != null && nearest.outMax !== nearest.outBps && <span className="text-ink-3"> (peak {formatBitRate(nearest.outMax)})</span>}
          </div>
        </div>
      )}
      <figcaption className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-rx" /> Inbound
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-tx" /> Outbound
        </span>
        {p95 && <span className="text-ink-3">Dashed: 95th percentile</span>}
        <span className="text-ink-3">Breaks in the line are periods with no measurement.</span>
      </figcaption>
    </figure>
  );
}
