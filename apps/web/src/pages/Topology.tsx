import { useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { api, qs } from '../lib/api';
import { useTree } from '../lib/dcim';
import { formatBps, type TopologyLinkT, type TopologyNodeT } from '../lib/network';
import { EmptyState, ErrorNote, Loading, Panel, Select } from '../components/ui';

type SimNode = TopologyNodeT & SimulationNodeDatum;
type SimLink = Omit<TopologyLinkT, 'source' | 'target'> & SimulationLinkDatum<SimNode>;

const W = 960;
const H = 600;

const CATEGORY_STYLE: Record<string, { fill: string; label: string }> = {
  router: { fill: 'var(--accent)', label: 'Router' },
  switch: { fill: 'var(--ok)', label: 'Switch' },
  firewall: { fill: 'var(--crit)', label: 'Firewall' },
  load_balancer: { fill: 'var(--warn)', label: 'Load balancer' },
  optical: { fill: 'var(--est)', label: 'Optical' },
  provider: { fill: 'var(--ink-2)', label: 'Provider' },
  unknown: { fill: 'transparent', label: 'Not in inventory' },
};

/** Static force layout; nodes can be dragged. Coordinates are computed once per data set. */
function layout(nodes: TopologyNodeT[], links: TopologyLinkT[]) {
  const n: SimNode[] = nodes.map((x) => ({ ...x }));
  const ids = new Set(n.map((x) => x.id));
  const l: SimLink[] = links.filter((x) => ids.has(x.source) && ids.has(x.target)).map((x) => ({ ...x }));
  const sim = forceSimulation(n)
    .force('link', forceLink<SimNode, SimLink>(l).id((d) => d.id).distance((d) => (d.kind === 'circuit' ? 170 : 150)))
    .force('charge', forceManyBody().strength(-1100))
    .force('center', forceCenter(W / 2, H / 2))
    .force('collide', forceCollide(60))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();
  for (const x of n) {
    x.x = Math.max(40, Math.min(W - 40, x.x ?? W / 2));
    x.y = Math.max(40, Math.min(H - 40, x.y ?? H / 2));
  }
  return { nodes: n, links: l };
}

export function TopologyView() {
  const tree = useTree();
  const [dc, setDc] = useState('');
  const q = useQuery({ queryKey: ['network', 'topology', dc], queryFn: () => api.get<{ nodes: TopologyNodeT[]; links: TopologyLinkT[]; generatedAt: string }>(`/network/topology${qs({ datacenterId: dc })}`) });
  const data = useMemo(() => (q.data ? layout(q.data.nodes, q.data.links) : null), [q.data]);
  const [, force] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const drag = useRef<{ node: SimNode; svg: SVGSVGElement } | null>(null);
  const navigate = useNavigate();

  const toSvg = (svg: SVGSVGElement, e: { clientX: number; clientY: number }) => {
    const r = svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const onMove = (e: RPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    const p = toSvg(drag.current.svg, e);
    drag.current.node.x = Math.max(20, Math.min(W - 20, p.x));
    drag.current.node.y = Math.max(20, Math.min(H - 20, p.y));
    force((n) => n + 1);
  };

  const highlighted = (l: SimLink) => !hover || (l.source as SimNode).id === hover || (l.target as SimNode).id === hover;

  return (
    <Panel
      title="Topology"
      actions={
        <Select className="w-48" aria-label="Datacenter" value={dc} onChange={(e) => setDc(e.target.value)}>
          <option value="">All datacenters</option>
          {tree.data?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.code} — {d.name}
            </option>
          ))}
        </Select>
      }
      flush
    >
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} className="m-4" />
      {data && data.nodes.length === 0 && <EmptyState title="Nothing to draw yet">Add routers, switches or firewalls, document cables between their ports, or run a discovery to import LLDP/CDP neighbors.</EmptyState>}
      {data && data.nodes.length > 0 && (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto w-full touch-none select-none"
            role="img"
            aria-label={`Network topology: ${data.nodes.length} nodes, ${data.links.length} links`}
            onPointerMove={onMove}
            onPointerUp={() => (drag.current = null)}
            onPointerLeave={() => (drag.current = null)}
          >
            {data.links.map((l) => {
              const s = l.source as SimNode;
              const t = l.target as SimNode;
              const dash = l.kind === 'neighbor' ? '6 5' : l.kind === 'circuit' ? '2 4' : undefined;
              const stroke = l.kind === 'cable' ? (l.verifiedByNeighbor ? 'var(--ok)' : 'var(--ink-3)') : l.kind === 'circuit' ? 'var(--ink-2)' : 'var(--est)';
              const mx = ((s.x ?? 0) + (t.x ?? 0)) / 2;
              const my = ((s.y ?? 0) + (t.y ?? 0)) / 2;
              return (
                <g key={l.id} opacity={highlighted(l) ? (l.kind === 'cable' && l.status !== 'connected' ? 0.45 : 1) : 0.15}>
                  <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={stroke} strokeWidth={l.speedBps && l.speedBps >= 1e10 ? 3 : 1.75} strokeDasharray={dash}>
                    <title>
                      {`${s.label} ${l.sourcePort} ↔ ${t.label} ${l.targetPort}\n${l.kind === 'cable' ? `Documented cable (${l.status})${l.verifiedByNeighbor ? ', confirmed by LLDP/CDP' : ', not confirmed by a neighbor protocol'}` : l.kind === 'neighbor' ? `Observed neighbor, ${l.status}; no cable documented` : `Circuit ${l.label} (${l.status})`}${l.speedBps ? `\n${formatBps(l.speedBps)}` : ''}`}
                    </title>
                  </line>
                  {hover && highlighted(l) && (
                    <text x={mx} y={my - 4} textAnchor="middle" className="fill-ink-2 text-[11px]" stroke="var(--paper)" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
                      {l.sourcePort} ↔ {l.targetPort}
                    </text>
                  )}
                </g>
              );
            })}
            {data.nodes.map((n) => {
              const st = CATEGORY_STYLE[n.category] ?? { fill: 'var(--ink-3)', label: n.category };
              const real = !n.id.includes(':');
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className={real ? 'cursor-pointer' : 'cursor-grab'}
                  onPointerDown={(e) => {
                    (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture?.(e.pointerId);
                    drag.current = { node: n, svg: e.currentTarget.ownerSVGElement as SVGSVGElement };
                  }}
                  onDoubleClick={() => real && navigate(`/network/devices/${n.id}`)}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                >
                  <circle r={n.category === 'provider' ? 16 : 14} fill={st.fill} stroke={n.category === 'unknown' ? 'var(--ink-3)' : 'var(--glass-edge)'} strokeWidth={2} strokeDasharray={n.category === 'unknown' ? '3 3' : undefined} />
                  <text y={30} textAnchor="middle" className="fill-ink text-[12px] font-medium" stroke="var(--paper)" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
                    {n.label}
                  </text>
                  {n.datacenterCode && (
                    <text y={44} textAnchor="middle" className="fill-ink-3 text-[10.5px]" stroke="var(--paper)" strokeWidth={4} paintOrder="stroke" strokeLinejoin="round">
                      {n.datacenterCode}
                      {n.rackName ? ` · ${n.rackName}` : ''}
                    </text>
                  )}
                  <title>{`${n.label} — ${st.label}${real ? '\nDouble-click to open' : ''}`}</title>
                </g>
              );
            })}
          </svg>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule px-4 py-3 text-[12.5px] text-ink-2">
            <Legend stroke="var(--ok)">Cable, confirmed by LLDP/CDP</Legend>
            <Legend stroke="var(--ink-3)">Cable, documented only (faded: planned)</Legend>
            <Legend stroke="var(--est)" dash="6 5">Neighbor seen, no cable documented</Legend>
            <Legend stroke="var(--ink-2)" dash="2 4">Provider circuit</Legend>
            <span className="text-ink-3">Links come only from documented cables, discovered neighbors and circuits; nothing is inferred. Drag to rearrange, double-click to open a device.</span>
          </div>
        </>
      )}
    </Panel>
  );
}

function Legend({ stroke, dash, children }: { stroke: string; dash?: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="26" height="8" aria-hidden>
        <line x1="1" y1="4" x2="25" y2="4" stroke={stroke} strokeWidth="2" strokeDasharray={dash} />
      </svg>
      {children}
    </span>
  );
}
