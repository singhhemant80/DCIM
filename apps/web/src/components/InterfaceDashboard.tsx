import { useMemo, useState, useEffect } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { DASHBOARD_MAX_ITEMS } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import type { InterfaceT, NetworkDeviceT } from '../lib/network';
import { LIVE_WINDOW_SECONDS, bps, latestLive, perSec, pct, useLiveWatchMany, withLive, type DashboardItemT, type LivePort, type LiveSample, type PortHistoryT } from '../lib/monitoring';
import { RateChart } from './RateChart';
import { Button, Chip, EmptyState, ErrorNote, Input, Loading, Modal, Panel, Select, cx } from './ui';

type ChartRange = 'live' | '1h' | '24h';
const RANGE_LABEL: Record<ChartRange, string> = { live: 'Live (5 min)', '1h': '1 hour', '24h': '24 hours' };
const NOT_POLLED: Record<Exclude<DashboardItemT['state'], 'polled'>, string> = {
  device_not_polled: 'This device is not polled yet, so there are no figures.',
  port_excluded: 'This port is excluded from polling on its device.',
  polling_paused: 'Polling is paused for this device.',
};

/** History for one tile (1 hour of raw readings or 24 hours of 5-minute averages). */
function TileHistory({ item, range }: { item: DashboardItemT; range: '1h' | '24h' }) {
  const h = useQuery({
    queryKey: ['monitoring', 'history', item.interfaceId, { range }],
    queryFn: () => api.get<PortHistoryT>(`/monitoring/ports/${item.interfaceId}/history${qs({ range })}`),
    refetchInterval: range === '1h' ? 30_000 : 120_000,
    placeholderData: keepPreviousData,
  });
  const now = Date.now();
  if (h.isLoading) return <div className="grid h-[180px] place-items-center text-[13px] text-ink-3">Loading…</div>;
  if (h.error) return <ErrorNote error={h.error} />;
  const pts = (h.data?.points ?? []).map((p) => ({ t: new Date(p.t).getTime(), inBps: p.inBps, outBps: p.outBps, inMax: p.inMax, outMax: p.outMax }));
  if (!pts.length) return <div className="grid h-[180px] place-items-center text-[13px] text-ink-3">No measurements in the last {RANGE_LABEL[range]}.</div>;
  return <RateChart label={`${item.deviceName} ${item.name}, last ${RANGE_LABEL[range]}`} points={pts} stepSeconds={h.data!.stepSeconds} from={now - (range === '1h' ? 3600e3 : 86400e3)} to={now} p95={h.data!.p95} />;
}

function Tile({
  item,
  live,
  samples,
  range,
  canEdit,
  first,
  last,
  onMove,
  onRemove,
}: {
  item: DashboardItemT;
  live: Map<string, LivePort>;
  samples: LiveSample[] | undefined;
  range: ChartRange;
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const p = item.port ? withLive(item.port, live) : null;
  const l = latestLive(samples);
  const inBps = l ? l.inBps : p?.fresh ? p.inBps : null;
  const outBps = l ? l.outBps : p?.fresh ? p.outBps : null;
  const of = (v: number | null) => (v !== null && p?.speedBps ? `${pct((v / p.speedBps) * 100)} of ${bps(p.speedBps)}` : p?.speedBps ? '' : 'speed unknown');
  const now = Date.now();
  return (
    <section className="glass flex min-w-0 flex-col rounded-2xl">
      <header className="flex items-start justify-between gap-2 border-b border-rule px-4 py-3">
        <Link to={`/network-monitoring?port=${item.interfaceId}`} className="min-w-0 hover:underline" title="Open the full chart and history">
          <span className="block truncate font-semibold">
            {item.deviceName} <span className="font-mono">{item.name}</span>
          </span>
          {item.description && <span className="block truncate text-[12.5px] text-ink-3">{item.description}</span>}
        </Link>
        <span className="flex shrink-0 items-center gap-1">
          {p && (p.operUp === null ? null : !p.enabled ? <Chip>Disabled</Chip> : p.operUp ? <Chip tone="ok">Up</Chip> : <Chip tone="crit">Down</Chip>)}
          {canEdit && (
            <>
              <button className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30" disabled={first} onClick={() => onMove(-1)} aria-label="Move earlier" title="Move earlier">
                ←
              </button>
              <button className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-30" disabled={last} onClick={() => onMove(1)} aria-label="Move later" title="Move later">
                →
              </button>
              <button className="rounded px-1.5 py-0.5 text-ink-3 hover:bg-crit-soft hover:text-crit" onClick={onRemove} aria-label={`Remove ${item.deviceName} ${item.name} from the dashboard`} title="Remove from the dashboard">
                ✕
              </button>
            </>
          )}
        </span>
      </header>
      {!p ? (
        <div className="flex flex-1 flex-col justify-center gap-2 px-4 py-6 text-[13px] text-ink-2">
          <p>{NOT_POLLED[item.state as Exclude<DashboardItemT['state'], 'polled'>]}</p>
          <Link to="/alerts?tab=polling" className="text-accent hover:underline">
            Set up polling in Monitoring &amp; Alerts → Polling
          </Link>
        </div>
      ) : (
        <div className="flex flex-1 flex-col px-4 py-3">
          <dl className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1">
            <div className="min-w-0">
              <dt className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <span className="inline-block size-2 rounded-full" style={{ background: 'var(--rx)' }} aria-hidden /> In {l && <span className="text-ok">· live</span>}
              </dt>
              <dd className="text-[20px] font-semibold tabular-nums">{inBps !== null ? bps(inBps) : <span className="text-ink-3">—</span>}</dd>
              <dd className="text-[11.5px] text-ink-3">{inBps !== null ? of(inBps) : 'no recent reading'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <span className="inline-block size-2 rounded-full" style={{ background: 'var(--tx)' }} aria-hidden /> Out {l && <span className="text-ok">· live</span>}
              </dt>
              <dd className="text-[20px] font-semibold tabular-nums">{outBps !== null ? bps(outBps) : <span className="text-ink-3">—</span>}</dd>
              <dd className="text-[11.5px] text-ink-3">{outBps !== null ? of(outBps) : ''}</dd>
            </div>
          </dl>
          <div className="min-h-[180px] flex-1">
            {range === 'live' ? (
              samples && samples.length > 1 ? (
                <RateChart label={`Live traffic on ${item.deviceName} ${item.name}`} points={samples} stepSeconds={1} from={now - LIVE_WINDOW_SECONDS * 1000} to={now} />
              ) : (
                <div className="grid h-[180px] place-items-center text-center text-[13px] text-ink-3">Waiting for live readings (one a second while this page is open)…</div>
              )
            ) : (
              <TileHistory item={item} range={range} />
            )}
          </div>
          <p className="mt-2 flex flex-wrap justify-between gap-x-3 text-[12px] text-ink-3">
            <span className={cx((p.errorsPs ?? 0) > 0 && 'text-warn')}>
              Errors {perSec(p.errorsPs)} · discards {perSec(p.discardsPs)}
            </span>
            <span>{p.sampledAt ? `Polled ${relativeTime(p.sampledAt)}` : 'Waiting for the first poll'}</span>
          </p>
        </div>
      )}
    </section>
  );
}

/** Pick interfaces from a device to pin on the dashboard. */
function AddInterfaces({ pinned, onClose }: { pinned: Set<string>; onClose: () => void }) {
  const qc = useQueryClient();
  const [allDevices, setAllDevices] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const devices = useQuery({ queryKey: ['network', 'devices', 'picker', allDevices], queryFn: () => api.get<NetworkDeviceT[]>(`/network/devices${qs({ all: allDevices ? 'true' : undefined })}`) });
  const polling = useQuery({ queryKey: ['monitoring', 'devices'], queryFn: () => api.get<{ deviceId: string; enabled: boolean; configured: boolean }[]>('/monitoring/devices') });
  const ifaces = useQuery({ queryKey: ['network', 'interfaces', deviceId], queryFn: () => api.get<InterfaceT[]>(`/network/devices/${deviceId}/interfaces`), enabled: !!deviceId });
  const pollOf = useMemo(() => new Map((polling.data ?? []).map((d) => [d.deviceId, d])), [polling.data]);
  const room = DASHBOARD_MAX_ITEMS - pinned.size;
  const add = useMutation({
    mutationFn: () => api.post<{ added: number }>('/monitoring/dashboard', { interfaceIds: [...chosen] }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['monitoring', 'dashboard'] });
      onClose();
    },
  });
  const list = (ifaces.data ?? []).filter((i) => !filter || `${i.name} ${i.description ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const poll = deviceId ? pollOf.get(deviceId) : undefined;
  const toggle = (id: string) => setChosen((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : s.size >= room ? s : new Set([...s, id])));
  return (
    <div className="grid gap-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <Select value={deviceId} onChange={(e) => (setDeviceId(e.target.value), setChosen(new Set()))} aria-label="Device">
          <option value="">Choose a device…</option>
          {(devices.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.hostname || d.assetTag}
              {d.datacenterCode ? ` · ${d.datacenterCode}${d.rackName ? ` ${d.rackName}` : ''}` : ''}
              {pollOf.get(d.id)?.enabled ? ' · polled' : ''}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={allDevices} onChange={(e) => setAllDevices(e.target.checked)} /> Include servers and other devices
        </label>
      </div>
      <ErrorNote error={devices.error ?? ifaces.error} />
      {deviceId && (
        <>
          {poll?.enabled ? (
            <p className="text-[13px] text-ok">This device is polled: its interfaces show live figures.</p>
          ) : (
            <p className="rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
              This device is not polled{poll?.configured ? ' (paused)' : ''}, so its interfaces will show no figures until polling is on.{' '}
              <Link to="/alerts?tab=polling" className="font-medium underline">
                Polling settings
              </Link>
            </p>
          )}
          <Input placeholder="Filter by name or description" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter interfaces" />
          {ifaces.isLoading && <Loading />}
          {ifaces.data && !ifaces.data.length && <p className="text-[13px] text-ink-2">This device has no interfaces in inventory. Add them on its page under Network, or run discovery.</p>}
          {list.length > 0 && (
            <ul className="max-h-[50vh] divide-y divide-rule overflow-y-auto rounded-lg border border-rule">
              {list.map((i) => {
                const already = pinned.has(i.id);
                return (
                  <li key={i.id}>
                    <label className={cx('flex items-center gap-3 px-3 py-2', already ? 'opacity-60' : 'cursor-pointer hover:bg-sunken/50')}>
                      <input type="checkbox" disabled={already} checked={already || chosen.has(i.id)} onChange={() => toggle(i.id)} />
                      <span className="min-w-0 flex-1">
                        <span className="font-mono text-[13px]">{i.name}</span>
                        {i.description && <span className="ml-2 text-[12.5px] text-ink-3">{i.description}</span>}
                      </span>
                      <span className="shrink-0 text-[12px] text-ink-3">{already ? 'On the dashboard' : i.speedBps ? bps(i.speedBps) : i.kind}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <ErrorNote error={add.error} />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-[12.5px] text-ink-3">
          {chosen.size} selected · room for {room} more (up to {DASHBOARD_MAX_ITEMS})
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!chosen.size} busy={add.isPending} onClick={() => add.mutate()}>
          Add {chosen.size || ''} to dashboard
        </Button>
      </div>
    </div>
  );
}

/**
 * Interface dashboard: interfaces the team chose, side by side, each with its
 * own live chart. While the page is open the worker reads the devices of the
 * pinned interfaces once a second (read-only, nothing stored).
 */
export function InterfaceDashboard({ live, fast }: { live: Map<string, LivePort>; fast: Map<string, LiveSample[]> }) {
  const { can } = useAuth();
  const canEdit = can('alerts.manage');
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [range, setRange] = useState<ChartRange>(() => {
    try {
      return (localStorage.getItem('dash-range') as ChartRange) || 'live';
    } catch {
      return 'live';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('dash-range', range);
    } catch {
      /* private mode */
    }
  }, [range]);
  const q = useQuery({ queryKey: ['monitoring', 'dashboard'], queryFn: () => api.get<DashboardItemT[]>('/monitoring/dashboard'), refetchInterval: 30_000 });
  const items = q.data ?? [];
  // One polled port per device keeps that device's one-second live view running.
  const perDevice = useMemo(() => [...new Map(items.filter((i) => i.state === 'polled').map((i) => [i.deviceId, i.interfaceId])).values()], [items]);
  const watch = useLiveWatchMany(perDevice);
  const refresh = () => qc.invalidateQueries({ queryKey: ['monitoring', 'dashboard'] });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/monitoring/dashboard/${id}`), onSuccess: refresh });
  const order = useMutation({
    mutationFn: (ids: string[]) => api.put<DashboardItemT[]>('/monitoring/dashboard/order', { interfaceIds: ids }),
    onSuccess: (d) => qc.setQueryData(['monitoring', 'dashboard'], d),
  });
  const move = (idx: number, dir: -1 | 1) => {
    const ids = items.map((i) => i.interfaceId);
    const j = idx + dir;
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    order.mutate(ids);
  };
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {canEdit && (
          <Button variant="primary" onClick={() => setAdding(true)} disabled={items.length >= DASHBOARD_MAX_ITEMS}>
            Add interfaces
          </Button>
        )}
        <span className="inline-flex rounded-lg border border-rule bg-panel p-0.5 text-[13px]" role="group" aria-label="Chart range">
          {(Object.keys(RANGE_LABEL) as ChartRange[]).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)} className={range === r ? 'rounded-md bg-field px-2.5 py-1 font-medium' : 'rounded-md px-2.5 py-1 text-ink-3 hover:text-ink'}>
              {RANGE_LABEL[r]}
            </button>
          ))}
        </span>
        <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
          {perDevice.length > 0 &&
            (watch?.live ? (
              <>
                <span className="size-1.5 animate-pulse rounded-full bg-ok" aria-hidden /> Live: devices read once a second while this page is open (not stored)
              </>
            ) : (
              (watch?.reason ?? 'Starting live view…')
            ))}
        </span>
        <span className="ml-auto text-[12.5px] text-ink-3">
          {items.length} of {DASHBOARD_MAX_ITEMS} · shared with all staff
        </span>
      </div>
      <ErrorNote error={q.error ?? remove.error ?? order.error} />
      {q.isLoading && <Loading />}
      {q.data && items.length === 0 && (
        <Panel>
          <EmptyState
            title="No interfaces on the dashboard yet"
            action={
              canEdit ? (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Add interfaces
                </Button>
              ) : undefined
            }
          >
            Pin the uplinks, transit ports and customer ports you want to watch. Each gets its own live graph here, side by side.
          </EmptyState>
        </Panel>
      )}
      {items.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {items.map((it, k) => (
            <Tile
              key={it.interfaceId}
              item={it}
              live={live}
              samples={fast.get(it.interfaceId)}
              range={range}
              canEdit={canEdit}
              first={k === 0}
              last={k === items.length - 1}
              onMove={(dir) => move(k, dir)}
              onRemove={() => remove.mutate(it.interfaceId)}
            />
          ))}
        </div>
      )}
      <Modal
        wide
        open={adding}
        onOpenChange={setAdding}
        title="Add interfaces to the dashboard"
        description="Choose a device, then tick its interfaces. Interfaces on devices that are not polled are pinned too and show their figures once polling is on."
      >
        {adding && <AddInterfaces pinned={new Set(items.map((i) => i.interfaceId))} onClose={() => setAdding(false)} />}
      </Modal>
    </div>
  );
}
