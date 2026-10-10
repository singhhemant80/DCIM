import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CATEGORY_LABELS,
  CREDENTIAL_KIND_LABELS,
  POWER_GROUPS,
  POWER_KINDS,
  POWER_PERIODS,
  POWER_PERIOD_LABELS,
  POWER_QUALITY_LABELS,
  formatKwh,
  formatWattsShort,
  type CredentialKind,
  type PowerPeriod,
} from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import type { NetworkDeviceT } from '../lib/network';
import { hours, money, sourceLabel, type DevicePowerT, type EnergyT, type PowerNowT, type PowerSummaryT } from '../lib/power';
import { PowerHourlyChart, PowerReadingsChart, type HourT } from '../components/PowerChart';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Stat, Table, Textarea, cx } from '../components/ui';
import { Tabs } from './Network';

const STAFF_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'devices', label: 'Devices' },
  { key: 'energy', label: 'Energy & cost' },
  { key: 'racks', label: 'Racks' },
  { key: 'pdus', label: 'PDUs' },
  { key: 'collection', label: 'Collection' },
  { key: 'tariffs', label: 'Tariffs' },
  { key: 'retention', label: 'Data retention' },
] as const;
const CUSTOMER_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'devices', label: 'Equipment' },
  { key: 'energy', label: 'Energy' },
] as const;
type TabKey = (typeof STAFF_TABS)[number]['key'];

const catLabel = (c: string) => CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c;

/* ------------------------------------------------------------------ small pieces */

export function QualityChip({ d }: { d: Pick<DevicePowerT, 'quality' | 'source' | 'at' | 'estimateKind'> }) {
  if (d.quality === 'measured')
    return (
      <Chip tone="ok" title={d.at ? `Measured ${relativeTime(d.at)}` : undefined}>
        Measured · {sourceLabel(d.source)}
      </Chip>
    );
  if (d.quality === 'estimated')
    return (
      <Chip tone="est" title={d.source === 'admin' ? 'Admin estimate for this device' : "The model's typical draw"}>
        Estimated · {d.source === 'admin' ? 'admin' : 'model'}
      </Chip>
    );
  if (d.quality === 'unknown')
    return (
      <Chip tone="warn" title="No measurement and no estimate: set a power estimate or the model's typical draw">
        Unknown
      </Chip>
    );
  return <Chip title="Not in a powered lifecycle state and not measured">{POWER_QUALITY_LABELS.off}</Chip>;
}

/** Energy total with its estimated share, so a blended figure is never shown unlabelled. */
function EnergyCell({ e }: { e: EnergyT | null }) {
  if (!e) return <>—</>;
  const total = e.measuredKwh + e.estimatedKwh;
  return (
    <span title={`${formatKwh(e.measuredKwh)} measured, ${formatKwh(e.estimatedKwh)} estimated${e.unknownHours > 0 ? `, ${hours(e.unknownHours)} unknown` : ''}`}>
      {formatKwh(total)}
      {e.estimatedKwh > 0 && <span className="text-est"> ({e.measuredKwh > 0 ? `${Math.min(99, Math.floor((e.estimatedKwh / total) * 100))}%` : 'all'} est.)</span>}
    </span>
  );
}

/** Measured and estimated watts side by side as one bar, never merged into one number without labels. */
function SplitBar({ measured, estimated, max }: { measured: number; estimated: number; max?: number | null }) {
  const top = Math.max(max ?? 0, measured + estimated, 1);
  return (
    <span className="flex h-2 w-full min-w-24 overflow-hidden rounded-full bg-sunken" title={`${formatWattsShort(measured)} measured, ${formatWattsShort(estimated)} estimated${max ? ` of ${formatWattsShort(max)}` : ''}`}>
      <span className="h-full bg-accent" style={{ width: `${(measured / top) * 100}%` }} />
      <span className="h-full bg-est opacity-60" style={{ width: `${(estimated / top) * 100}%` }} />
    </span>
  );
}

function NowStats({ now }: { now: PowerNowT }) {
  return (
    <>
      <Stat label="Measured now" value={formatWattsShort(now.measuredW)} note={`${now.measuredDevices} device${now.measuredDevices === 1 ? '' : 's'} reporting`} />
      <Stat label="Estimated now" value={<span className="text-est">{formatWattsShort(now.estimatedW)}</span>} note={`${now.estimatedDevices} device${now.estimatedDevices === 1 ? '' : 's'} from estimates`} />
      <Stat label="Unknown" value={now.unknownDevices} tone={now.unknownDevices ? 'warn' : undefined} note={now.unknownDevices ? 'No measurement and no estimate (not in totals)' : 'Every device has a figure'} />
    </>
  );
}

function EnergyStats({ e, staff, period }: { e: EnergyT | null; staff: boolean; period: string }) {
  return (
    <>
      <Stat label={`Energy, ${period.toLowerCase()}`} value={formatKwh(e ? e.measuredKwh + e.estimatedKwh : 0)} note={e ? `${formatKwh(e.measuredKwh)} measured, ${formatKwh(e.estimatedKwh)} estimated` : 'No hourly data yet'} />
      {staff && <Stat label="Cost" value={money(e?.cost)} note={e?.cost.length ? `${money(e.cost.map((c) => ({ ...c, amount: c.estimatedPart })))} of it from estimates` : e && e.unpricedKwh > 0 ? 'Add a tariff to price energy' : undefined} />}
    </>
  );
}

function PeriodSelect({ value, onChange }: { value: PowerPeriod; onChange: (p: PowerPeriod) => void }) {
  return (
    <Select className="w-40" value={value} onChange={(e) => onChange(e.target.value as PowerPeriod)} aria-label="Period">
      {POWER_PERIODS.map((p) => (
        <option key={p} value={p}>
          {POWER_PERIOD_LABELS[p]}
        </option>
      ))}
    </Select>
  );
}

/* ------------------------------------------------------------------ overview */

function OverviewTab({ onDevice }: { onDevice: (id: string) => void }) {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const [period, setPeriod] = useState<PowerPeriod>('24h');
  const q = useQuery({ queryKey: ['power', 'summary', period], queryFn: () => api.get<PowerSummaryT>(`/power/summary${qs({ period })}`), refetchInterval: 60_000, placeholderData: keepPreviousData });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const s = q.data!;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Panel title={staff ? 'Equipment power' : 'Your equipment'} actions={<PeriodSelect value={period} onChange={setPeriod} />}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
          <NowStats now={s.now} />
          <EnergyStats e={s.energy} staff={staff} period={POWER_PERIOD_LABELS[period]} />
        </dl>
        <p className="mt-4 text-[12.5px] text-ink-3">
          Measured figures come from BMCs (Redfish, IPMI), metered PDU outlets and switch/router power supplies. When a device has no recent measurement, its estimate (admin figure, else the model's typical draw) is used and labelled. PDUs and UPSs are not counted as load.
          {s.energy && s.energy.unknownHours > 0 && ` ${hours(s.energy.unknownHours)} of device time in this period had neither a measurement nor an estimate.`}
          {s.period.roundedToHours && ` Period boundaries are rounded to whole hours (${formatDateTime(s.period.from)} → ${formatDateTime(s.period.to)}).`}
        </p>
      </Panel>
      <div className="grid gap-5 lg:grid-cols-2">
        {staff && s.byDatacenter.length > 0 && (
          <Panel flush title="By datacenter">
            <Table label="Power by datacenter">
              <thead>
                <tr>
                  <th>Datacenter</th>
                  <th>Now</th>
                  <th className="w-1/3" />
                  <th className="text-right">Energy</th>
                </tr>
              </thead>
              <tbody>
                {s.byDatacenter.map((d) => (
                  <tr key={d.datacenterId ?? 'none'}>
                    <td className="font-medium">{d.datacenterCode ?? <span className="text-ink-3">Not racked</span>}</td>
                    <td className="text-[13px] whitespace-nowrap">
                      {formatWattsShort(d.now.measuredW)} <span className="text-est">+ {formatWattsShort(d.now.estimatedW)} est.</span>
                      {d.now.unknownDevices > 0 && <span className="text-warn"> · {d.now.unknownDevices} unknown</span>}
                    </td>
                    <td>
                      <SplitBar measured={d.now.measuredW} estimated={d.now.estimatedW} />
                    </td>
                    <td className="text-right text-[13px] tabular-nums">
                      <EnergyCell e={d.energy} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
        <Panel flush title="By category">
          {s.byCategory.length === 0 ? (
            <EmptyState title="No equipment drawing power" />
          ) : (
            <Table label="Power by category">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Now</th>
                  <th className="text-right">Energy</th>
                </tr>
              </thead>
              <tbody>
                {s.byCategory.map((c) => (
                  <tr key={c.category}>
                    <td>{catLabel(c.category)}</td>
                    <td className="text-[13px]">
                      {formatWattsShort(c.now.measuredW)} <span className="text-est">+ {formatWattsShort(c.now.estimatedW)} est.</span>
                    </td>
                    <td className="text-right text-[13px] tabular-nums">
                      <EnergyCell e={c.energy} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        <Panel flush title="Largest draw now">
          {s.top.length === 0 ? (
            <EmptyState title="No figures yet">Enable collection on a BMC or PDU, or set estimates.</EmptyState>
          ) : (
            <ul className="divide-y divide-rule">
              {s.top.map((d) => (
                <li key={d.deviceId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <button className="truncate text-left font-medium text-accent hover:underline" onClick={() => onDevice(d.deviceId)}>
                    {d.name}
                  </button>
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <span className="tabular-nums">{formatWattsShort(d.watts)}</span>
                    <QualityChip d={d} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ device detail */

interface DeviceDetailT extends DevicePowerT {
  spec: { typicalW: number | null; idleW: number | null; maxW: number | null; psuCount: number | null; psuRatedW: number | null } | null;
  profile: { estimateW: number | null; includeInTotals: boolean; notes: string | null } | null;
  sources: { source: string; at: string; watts: number; fresh: boolean }[];
  outlets: { id: string; outlet_number: number; name: string | null; label: string | null; last_watts: number | null; last_at: string | null; pdu_name: string }[];
}

function ProfileForm({ d, onDone }: { d: DeviceDetailT; onDone: () => void }) {
  const qc = useQueryClient();
  const [estimate, setEstimate] = useState(d.profile?.estimateW?.toString() ?? '');
  const [include, setInclude] = useState(d.profile?.includeInTotals ?? true);
  const [notes, setNotes] = useState(d.profile?.notes ?? '');
  const save = useMutation({
    mutationFn: () => api.put(`/power/devices/${d.deviceId}/profile`, { estimateW: estimate === '' ? null : Number(estimate), includeInTotals: include, notes: notes || null }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ['power'] }), onDone()),
  });
  return (
    <form className="grid gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <Field label="Estimate (W)" hint={`Used only when there is no fresh measurement. Empty: the model's typical draw${d.spec?.typicalW ? ` (${d.spec.typicalW} W)` : ' (not set on the model)'}.`}>
        {(id, h) => <Input id={id} aria-describedby={h} type="number" min={0} max={100000} value={estimate} onChange={(e) => setEstimate(e.target.value)} />}
      </Field>
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> Count in rack, datacenter and organization totals
      </label>
      <Field label="Notes">{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />}</Field>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

function DeviceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { can, me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const [range, setRange] = useState<'24h' | '7d' | '30d'>('24h');
  const [editing, setEditing] = useState(false);
  const d = useQuery({ queryKey: ['power', 'device', id], queryFn: () => api.get<DeviceDetailT>(`/power/devices/${id}`), refetchInterval: 30_000 });
  const h = useQuery({ queryKey: ['power', 'device', id, 'history', range], queryFn: () => api.get<{ raw: { source: string; at: string; watts: number }[]; hourly: HourT[] }>(`/power/devices/${id}/history${qs({ range })}`), placeholderData: keepPreviousData });
  const now = Date.now();
  const span = { '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }[range];
  const x = d.data;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={x ? `Power: ${x.name}` : 'Power'} wide>
      {d.isLoading && <Loading />}
      <ErrorNote error={d.error} />
      {x && (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[26px] font-semibold tracking-[-0.02em]">{formatWattsShort(x.watts)}</span>
            <QualityChip d={x} />
            {!x.counted && x.quality !== 'off' && <Chip title="Not added to totals (PDU/UPS, or excluded)">Not in totals</Chip>}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            <div>
              <dt className="text-ink-3">Model typical / max</dt>
              <dd>
                {x.spec?.typicalW ?? '—'} W / {x.spec?.maxW ?? '—'} W
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Power supplies</dt>
              <dd>{x.spec?.psuCount ? `${x.spec.psuCount} × ${x.spec.psuRatedW ?? '?'} W` : '—'}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Estimate in use</dt>
              <dd>{x.estimateW !== null ? `${x.estimateW} W (${x.estimateKind === 'admin' ? 'admin' : 'model'})` : 'none'}</dd>
            </div>
            {staff && (
              <div>
                <dt className="text-ink-3">Location</dt>
                <dd>{x.rackName ? `${x.datacenterCode ?? ''} ${x.rackName}` : 'Not racked'}</dd>
              </div>
            )}
          </dl>
          {x.sources.length > 0 && (
            <div>
              <p className="mb-1 text-[13px] font-semibold">Latest reading per source (highest priority first wins)</p>
              <ul className="text-[13px]">
                {x.sources.map((s) => (
                  <li key={s.source} className={cx(!s.fresh && 'text-ink-3')}>
                    {sourceLabel(s.source)}: {formatWattsShort(s.watts)} {relativeTime(s.at)}
                    {!s.fresh && ' (stale, not used)'}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {staff && x.outlets.length > 0 && (
            <p className="text-[13px]">
              Fed by {x.outlets.map((o) => `${o.pdu_name} outlet ${o.outlet_number}${o.label ? ` (${o.label})` : ''}`).join(', ')}.
            </p>
          )}
          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold">{range === '24h' ? 'Readings' : 'Hourly energy'}</p>
              <Select className="w-32" value={range} onChange={(e) => setRange(e.target.value as typeof range)} aria-label="Range">
                <option value="24h">24 hours</option>
                <option value="7d">7 days</option>
                <option value="30d">30 days</option>
              </Select>
            </div>
            {h.data && range === '24h' && (h.data.raw.length ? <PowerReadingsChart raw={h.data.raw} from={now - span} to={now} /> : <p className="text-[13px] text-ink-3">No measurements in the last 24 hours{x.estimateW !== null ? '; the estimate is used instead.' : '.'}</p>)}
            {h.data && range !== '24h' && (h.data.hourly.length ? <PowerHourlyChart hours={h.data.hourly} from={now - span} to={now} /> : <p className="text-[13px] text-ink-3">No hourly energy yet.</p>)}
          </div>
          {staff && can('power.configure') && (
            <div className="flex flex-wrap gap-2 border-t border-rule pt-3">
              <Button size="sm" onClick={() => setEditing(true)}>
                Estimate and totals
              </Button>
              <Link to={`/network/devices/${x.deviceId}`}>
                <Button size="sm" variant="ghost">
                  BMC / SNMP access
                </Button>
              </Link>
            </div>
          )}
          {editing && <ProfileForm d={x} onDone={() => setEditing(false)} />}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ devices */

function DevicesTab({ onDevice }: { onDevice: (id: string) => void }) {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const [period, setPeriod] = useState<PowerPeriod>('24h');
  const [quality, setQuality] = useState('');
  const [sort, setSort] = useState<'power' | 'energy' | 'name'>('power');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['power', 'devices', period, quality, sort, q, page],
    queryFn: () => api.get<Paginated<DevicePowerT>>(`/power/devices${qs({ period, quality, sort, q, page, pageSize: 50 })}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  return (
    <Panel
      flush
      title={staff ? 'Devices' : 'Your equipment'}
      actions={
        <div className="flex flex-wrap gap-2">
          <Input className="w-44" placeholder="Search" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} aria-label="Search devices" />
          <Select className="w-36" value={quality} onChange={(e) => (setQuality(e.target.value), setPage(1))} aria-label="Quality">
            <option value="">All figures</option>
            <option value="measured">Measured</option>
            <option value="estimated">Estimated</option>
            <option value="unknown">Unknown</option>
          </Select>
          <Select className="w-36" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
            <option value="power">Highest draw</option>
            <option value="energy">Most energy</option>
            <option value="name">Name</option>
          </Select>
          <PeriodSelect value={period} onChange={setPeriod} />
        </div>
      }
    >
      <ErrorNote error={list.error} className="m-4" />
      {list.isLoading && <Loading />}
      {list.data?.total === 0 && <EmptyState title="No devices">{staff ? 'Devices appear here once they exist in inventory.' : 'Equipment assigned to your account appears here.'}</EmptyState>}
      {!!list.data?.items.length && (
        <Table label="Device power">
          <thead>
            <tr>
              <th>Device</th>
              {staff && <th>Location</th>}
              <th className="text-right">Now</th>
              <th>Figure</th>
              <th className="text-right">Energy ({POWER_PERIOD_LABELS[period].toLowerCase()})</th>
              {staff && <th className="text-right">Cost</th>}
              {staff && <th>Collection</th>}
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((d) => (
              <tr key={d.deviceId} className="cursor-pointer hover:bg-sunken/60" onClick={() => onDevice(d.deviceId)}>
                <td>
                  <span className="font-medium">{d.name}</span>
                  <span className="block text-[12px] text-ink-3">
                    {catLabel(d.category)}
                    {staff && d.customerName ? ` · ${d.customerName}` : ''}
                  </span>
                </td>
                {staff && <td className="text-[13px]">{d.rackName ? `${d.datacenterCode ?? ''} ${d.rackName}` : <span className="text-ink-3">Not racked</span>}</td>}
                <td className="text-right tabular-nums">{formatWattsShort(d.watts)}</td>
                <td>
                  <span className="flex flex-wrap gap-1">
                    <QualityChip d={d} />
                    {!d.counted && d.quality !== 'off' && <Chip title="Distribution equipment (PDU/UPS) or excluded: shown, but not added to totals">not in totals</Chip>}
                  </span>
                </td>
                <td className="text-right text-[13px] tabular-nums">
                  <EnergyCell e={d.energy ?? null} />
                </td>
                {staff && <td className="text-right text-[13px] tabular-nums">{money(d.energy?.cost)}</td>}
                {staff && (
                  <td className="text-[13px]">
                    {!d.polling ? (
                      <span className="text-ink-3">—</span>
                    ) : d.polling.consecutiveFailures ? (
                      <span className="text-crit" title={d.polling.lastError ?? undefined}>
                        Failing
                      </span>
                    ) : d.polling.enabled ? (
                      <span className="text-ok">{CREDENTIAL_KIND_LABELS[d.polling.credentialKind as CredentialKind]}</span>
                    ) : (
                      <span className="text-ink-3">Paused</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {list.data && list.data.total > list.data.pageSize && (
        <div className="border-t border-rule px-4 py-2">
          <Pagination page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ energy */

function EnergyTab() {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const [period, setPeriod] = useState<PowerPeriod>('last_month');
  const [groupBy, setGroupBy] = useState<(typeof POWER_GROUPS)[number]>(staff ? 'datacenter' : 'device');
  const r = useQuery({
    queryKey: ['power', 'energy', period, groupBy],
    queryFn: () => api.get<{ period: PowerSummaryT['period']; rows: (EnergyT & { name: string | null; totalKwh: number })[] }>(`/power/energy${qs({ period, groupBy })}`),
    placeholderData: keepPreviousData,
  });
  const groups = staff ? POWER_GROUPS : (['device', 'category'] as const);
  return (
    <Panel
      flush
      title="Energy"
      actions={
        <div className="flex flex-wrap gap-2">
          <Select className="w-36" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)} aria-label="Group by">
            {groups.map((g) => (
              <option key={g} value={g}>
                By {g}
              </option>
            ))}
          </Select>
          <PeriodSelect value={period} onChange={setPeriod} />
          <a href={`/api/v1/power/energy.csv${qs({ period, groupBy })}`} download>
            <Button size="sm">CSV</Button>
          </a>
        </div>
      }
    >
      <p className="border-b border-rule px-4 py-2.5 text-[13px] text-ink-2">
        Measured energy is integrated from timestamped readings and never bridges a gap; time without a measurement uses the device's estimate and is shown separately; time with neither is "unknown" and adds no energy.
        {staff && ' Cost uses the tariff in force for each hour: the datacenter’s own tariff, else the organization’s.'}
        {r.data?.period.roundedToHours && ` Period rounded to whole hours: ${formatDateTime(r.data.period.from)} → ${formatDateTime(r.data.period.to)}.`}
      </p>
      <ErrorNote error={r.error} className="m-4" />
      {r.isLoading && <Loading />}
      {r.data?.rows.length === 0 && <EmptyState title="No energy recorded in this period">Hourly energy is built by the worker every minute from readings and estimates.</EmptyState>}
      {!!r.data?.rows.length && (
        <Table label="Energy">
          <thead>
            <tr>
              <th>{groupBy[0]!.toUpperCase() + groupBy.slice(1)}</th>
              <th className="text-right">Measured</th>
              <th className="text-right">Estimated</th>
              <th className="text-right">Total</th>
              <th className="text-right">Unknown time</th>
              {staff && <th className="text-right">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {r.data.rows.map((e) => (
              <tr key={e.key}>
                <td className="font-medium">{groupBy === 'category' ? catLabel(e.key) : (e.name ?? <span className="text-ink-3">None</span>)}</td>
                <td className="text-right tabular-nums">{formatKwh(e.measuredKwh)}</td>
                <td className="text-right text-est tabular-nums">{formatKwh(e.estimatedKwh)}</td>
                <td className="text-right font-medium tabular-nums">{formatKwh(e.totalKwh)}</td>
                <td className={cx('text-right tabular-nums', e.unknownHours > 0 && 'text-warn')}>{hours(e.unknownHours)}</td>
                {staff && (
                  <td className="text-right tabular-nums" title={e.cost.length ? `${money(e.cost.map((c) => ({ ...c, amount: c.estimatedPart })))} from estimates` : undefined}>
                    {money(e.cost)}
                    {e.unpricedKwh > 0 && <span className="block text-[12px] text-warn">{formatKwh(e.unpricedKwh)} without a tariff</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ racks */

function RacksTab() {
  const r = useQuery({
    queryKey: ['power', 'racks'],
    queryFn: () => api.get<{ rackId: string; name: string; roomName: string; datacenterCode: string; maxPowerW: number | null; now: PowerNowT; pduInputW: number | null; pduCount: number; budgetUsedPct: number | null }[]>('/power/racks'),
    refetchInterval: 60_000,
  });
  return (
    <Panel flush title="Racks">
      <p className="border-b border-rule px-4 py-2.5 text-[13px] text-ink-2">Equipment draw (measured plus labelled estimates) against each rack's power budget. Where a metered PDU is installed, its own input reading is shown beside it, not added to it.</p>
      <ErrorNote error={r.error} className="m-4" />
      {r.isLoading && <Loading />}
      {r.data?.length === 0 && <EmptyState title="No racks" />}
      {!!r.data?.length && (
        <Table label="Rack power">
          <thead>
            <tr>
              <th>Rack</th>
              <th>Measured + estimated</th>
              <th className="w-1/4">Budget</th>
              <th className="text-right">PDU input (measured)</th>
              <th className="text-right">Unknown devices</th>
            </tr>
          </thead>
          <tbody>
            {r.data.map((k) => (
              <tr key={k.rackId}>
                <td>
                  <Link to={`/racks/${k.rackId}`} className="font-medium text-accent hover:underline">
                    {k.datacenterCode} {k.name}
                  </Link>
                  <span className="block text-[12px] text-ink-3">{k.roomName}</span>
                </td>
                <td className="text-[13px] whitespace-nowrap">
                  {formatWattsShort(k.now.measuredW)} <span className="text-est">+ {formatWattsShort(k.now.estimatedW)} est.</span>
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <SplitBar measured={k.now.measuredW} estimated={k.now.estimatedW} max={k.maxPowerW} />
                    <span className={cx('text-[13px] tabular-nums', (k.budgetUsedPct ?? 0) >= 90 ? 'text-crit' : (k.budgetUsedPct ?? 0) >= 75 ? 'text-warn' : '')}>{k.budgetUsedPct !== null ? `${k.budgetUsedPct}%` : 'no budget'}</span>
                  </div>
                </td>
                <td className="text-right text-[13px] tabular-nums">{k.pduInputW !== null ? `${formatWattsShort(k.pduInputW)} (${k.pduCount})` : '—'}</td>
                <td className={cx('text-right text-[13px]', k.now.unknownDevices > 0 && 'text-warn')}>{k.now.unknownDevices}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ PDUs */

interface PduT {
  deviceId: string;
  name: string;
  rackName: string | null;
  lastOkAt: string | null;
  inputW: number | null;
  outlets: { id: string; number: number; name: string | null; label: string | null; deviceId: string | null; deviceName: string | null; watts: number | null; at: string | null; fresh: boolean }[];
}

function PdusTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('power.configure');
  const pdus = useQuery({ queryKey: ['power', 'pdus'], queryFn: () => api.get<PduT[]>('/power/pdus'), refetchInterval: 60_000 });
  const devices = useQuery({ queryKey: ['network', 'devices', 'all'], queryFn: () => api.get<NetworkDeviceT[]>('/network/devices?all=true'), enabled: manage });
  const map = useMutation({ mutationFn: (v: { id: string; deviceId: string | null }) => api.put(`/power/outlets/${v.id}`, { deviceId: v.deviceId }), onSuccess: () => qc.invalidateQueries({ queryKey: ['power'] }) });
  const feedable = (devices.data ?? []).filter((d) => d.category !== 'pdu' && d.category !== 'ups');
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <p className="text-[13px] text-ink-2">
        Outlets appear after the first poll of a metered PDU (APC PowerNet rPDU2 over SNMP). Record which device each outlet feeds: a device whose outlets all report gets a PDU-measured reading (the sum of its outlets, so an A+B fed server counts both feeds once), which takes priority over its BMC. Nothing here switches an outlet.
      </p>
      <ErrorNote error={pdus.error ?? map.error} />
      {pdus.isLoading && <Loading />}
      {pdus.data?.length === 0 && (
        <Panel>
          <EmptyState title="No PDUs">Add PDUs to hardware inventory (category PDU), give them an SNMP credential and enable collection.</EmptyState>
        </Panel>
      )}
      {pdus.data?.map((p) => (
        <Panel
          key={p.deviceId}
          flush
          title={
            <span>
              {p.name} {p.rackName && <span className="font-normal text-ink-3">· {p.rackName}</span>}
            </span>
          }
          actions={<span className="text-[13px] text-ink-2">Input {p.inputW !== null ? formatWattsShort(p.inputW) : '—'} · {p.lastOkAt ? `read ${relativeTime(p.lastOkAt)}` : 'not read yet'}</span>}
        >
          {p.outlets.length === 0 ? (
            <EmptyState title="No outlets reported yet">Enable collection for this PDU on the Collection tab.</EmptyState>
          ) : (
            <Table label={`Outlets of ${p.name}`}>
              <thead>
                <tr>
                  <th>Outlet</th>
                  <th className="text-right">Power</th>
                  <th>Feeds</th>
                </tr>
              </thead>
              <tbody>
                {p.outlets.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <span className="font-mono">{o.number}</span> <span className="text-ink-2">{o.label ?? o.name ?? ''}</span>
                    </td>
                    <td className={cx('text-right tabular-nums', !o.fresh && 'text-ink-3')}>{o.watts !== null && o.fresh ? formatWattsShort(o.watts) : o.watts === null ? 'not metered' : 'stale'}</td>
                    <td className="w-72">
                      {manage ? (
                        <Select value={o.deviceId ?? ''} onChange={(e) => map.mutate({ id: o.id, deviceId: e.target.value || null })} aria-label={`Device fed by outlet ${o.number}`}>
                          <option value="">Nothing / unknown</option>
                          {feedable.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.hostname || d.assetTag}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        (o.deviceName ?? <span className="text-ink-3">—</span>)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ collection */

interface CollectionT {
  deviceId: string;
  deviceName: string;
  category: string;
  configured: boolean;
  enabled: boolean;
  credentialKind: CredentialKind | null;
  intervalSeconds: number | null;
  lastPollAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastDurationMs: number | null;
  lastWatts: number | null;
  credentialKinds: CredentialKind[];
  outlets: number;
}

function CollectionForm({ row, onDone }: { row: CollectionT; onDone: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<CredentialKind>(row.credentialKind ?? row.credentialKinds[0]!);
  const [interval, setIntervalS] = useState(row.intervalSeconds ?? 60);
  const [enabled, setEnabled] = useState(row.configured ? row.enabled : true);
  const save = useMutation({ mutationFn: () => api.put(`/power/polling/${row.deviceId}`, { enabled, credentialKind: kind, intervalSeconds: interval }), onSuccess: () => (void qc.invalidateQueries({ queryKey: ['power'] }), onDone()) });
  const remove = useMutation({ mutationFn: () => api.delete(`/power/polling/${row.deviceId}`), onSuccess: () => (void qc.invalidateQueries({ queryKey: ['power'] }), onDone()) });
  return (
    <form className="grid gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <Field label="Read power with" hint="Read-only. Redfish: chassis power; IPMI: DCMI power reading (needs ipmitool on the worker); SNMP: APC PDU outlets and total; RouterOS: /system/health; NX-OS: power supply input.">
        {(id, h) => (
          <Select id={id} aria-describedby={h} value={kind} onChange={(e) => setKind(e.target.value as CredentialKind)}>
            {row.credentialKinds.map((k) => (
              <option key={k} value={k}>
                {CREDENTIAL_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Interval">
        {(id) => (
          <Select id={id} value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
            {[30, 60, 120, 300, 600, 900].map((s) => (
              <option key={s} value={s}>
                {s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <label className="flex items-center gap-1.5 text-[13px]">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Collection enabled
      </label>
      <ErrorNote error={save.error ?? remove.error} />
      <div className="flex justify-between gap-2">
        {row.configured ? (
          <Button type="button" variant="ghost" busy={remove.isPending} onClick={() => remove.mutate()}>
            Remove
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

function CollectionTab() {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['power', 'polling'], queryFn: () => api.get<CollectionT[]>('/power/polling'), refetchInterval: 15_000 });
  const [edit, setEdit] = useState<CollectionT | null>(null);
  return (
    <Panel flush title="Collection">
      <p className="border-b border-rule px-4 py-2.5 text-[13px] text-ink-2">
        Devices with a stored credential that can read power ({POWER_KINDS.map((k) => CREDENTIAL_KIND_LABELS[k]).join(', ')}). Add BMC or SNMP access on the device's page (Network → device → Read-only access).
      </p>
      <ErrorNote error={list.error} className="m-4" />
      {list.isLoading && <Loading />}
      {list.data?.length === 0 && <EmptyState title="No devices with power-capable access">Add a Redfish or IPMI credential to a server, or SNMP to a metered PDU.</EmptyState>}
      {!!list.data?.length && (
        <Table label="Power collection per device">
          <thead>
            <tr>
              <th>Device</th>
              <th>Method</th>
              <th>Interval</th>
              <th>Last read</th>
              <th className="text-right">Reading</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.deviceId}>
                <td>
                  <span className="font-medium">{d.deviceName}</span>
                  <span className="block text-[12px] text-ink-3">
                    {catLabel(d.category)}
                    {d.outlets ? ` · ${d.outlets} outlets` : ''}
                  </span>
                </td>
                <td className="text-[13px]">{d.credentialKind ? CREDENTIAL_KIND_LABELS[d.credentialKind] : <span className="text-ink-3">Not collected</span>}</td>
                <td className="text-[13px]">{d.configured ? (d.enabled ? `${d.intervalSeconds} s` : <Chip>Paused</Chip>) : '—'}</td>
                <td className="text-[13px]">
                  {!d.configured ? (
                    '—'
                  ) : !d.lastPollAt ? (
                    <span className="text-ink-3">Waiting</span>
                  ) : d.consecutiveFailures ? (
                    <span className="text-crit" title={d.lastError ?? undefined}>
                      Failing ×{d.consecutiveFailures}: {d.lastError}
                    </span>
                  ) : (
                    <span className="text-ok">OK {relativeTime(d.lastOkAt)}</span>
                  )}
                </td>
                <td className="text-right text-[13px] tabular-nums">{d.lastWatts !== null ? formatWattsShort(d.lastWatts) : d.outlets ? 'outlets only' : '—'}</td>
                <td className="text-right">
                  {can('power.configure') && (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(d)}>
                      {d.configured ? 'Change' : 'Enable'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={`Power collection: ${edit?.deviceName ?? ''}`}>
        {edit && <CollectionForm row={edit} onDone={() => setEdit(null)} />}
      </Modal>
    </Panel>
  );
}

/* ------------------------------------------------------------------ tariffs */

interface TariffT {
  id: string;
  name: string;
  datacenterId: string | null;
  datacenterCode: string | null;
  currency: string;
  pricePerKwh: number;
  validFrom: string;
  notes: string | null;
}

function TariffForm({ t, onDone }: { t: TariffT | 'new'; onDone: () => void }) {
  const qc = useQueryClient();
  const dcs = useQuery({ queryKey: ['dcim', 'datacenters'], queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/dcim/datacenters') });
  const x = t === 'new' ? null : t;
  const toLocal = (iso: string) => {
    const d = new Date(iso);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const [v, setV] = useState({ name: x?.name ?? '', datacenterId: x?.datacenterId ?? '', currency: x?.currency ?? 'INR', price: x ? String(x.pricePerKwh) : '', validFrom: toLocal(x?.validFrom ?? new Date().toISOString()), notes: x?.notes ?? '' });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: v.name, datacenterId: v.datacenterId || null, currency: v.currency, pricePerKwh: Number(v.price), validFrom: new Date(v.validFrom).toISOString(), notes: v.notes || null };
      return x ? api.put(`/power/tariffs/${x.id}`, body) : api.post('/power/tariffs', body);
    },
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ['power'] }), onDone()),
  });
  return (
    <form className="grid gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
      <Field label="Name">{(id) => <Input id={id} required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} maxLength={80} />}</Field>
      <Field label="Applies to" hint="A datacenter's own tariff wins over the organization-wide one">
        {(id, h) => (
          <Select id={id} aria-describedby={h} value={v.datacenterId} onChange={(e) => setV({ ...v, datacenterId: e.target.value })}>
            <option value="">All datacenters (organization default)</option>
            {dcs.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} — {d.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Currency">{(id) => <Input id={id} required value={v.currency} onChange={(e) => setV({ ...v, currency: e.target.value.toUpperCase() })} maxLength={3} />}</Field>
        <Field label="Price per kWh">{(id) => <Input id={id} required type="number" min={0} step="any" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} />}</Field>
        <Field label="Valid from">{(id) => <Input id={id} required type="datetime-local" value={v.validFrom} onChange={(e) => setV({ ...v, validFrom: e.target.value })} />}</Field>
      </div>
      <Field label="Notes">{(id) => <Textarea id={id} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} maxLength={1000} />}</Field>
      <p className="text-[12.5px] text-ink-3">A tariff applies from its start until the next one for the same scope starts. Changing a price re-prices past hours on the next report (energy itself is stored, cost is computed when reported).</p>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save tariff
        </Button>
      </div>
    </form>
  );
}

function TariffsTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['power', 'tariffs'], queryFn: () => api.get<TariffT[]>('/power/tariffs') });
  const [edit, setEdit] = useState<TariffT | 'new' | null>(null);
  const [del, setDel] = useState<TariffT | null>(null);
  const remove = useMutation({ mutationFn: () => api.delete(`/power/tariffs/${del!.id}`), onSuccess: () => (setDel(null), qc.invalidateQueries({ queryKey: ['power'] })) });
  return (
    <Panel
      flush
      title="Tariffs"
      actions={
        can('power.configure') && (
          <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
            Add tariff
          </Button>
        )
      }
    >
      <ErrorNote error={list.error} className="m-4" />
      {list.data?.length === 0 && <EmptyState title="No tariffs">Without a tariff, energy is reported in kWh only.</EmptyState>}
      {!!list.data?.length && (
        <Table label="Tariffs">
          <thead>
            <tr>
              <th>Name</th>
              <th>Applies to</th>
              <th className="text-right">Price per kWh</th>
              <th>From</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((t) => (
              <tr key={t.id}>
                <td className="font-medium">{t.name}</td>
                <td className="text-[13px]">{t.datacenterCode ?? 'All datacenters'}</td>
                <td className="text-right tabular-nums">
                  {t.pricePerKwh} {t.currency}
                </td>
                <td className="text-[13px]">{formatDateTime(t.validFrom)}</td>
                <td className="text-right whitespace-nowrap">
                  {can('power.configure') && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDel(t)}>
                        Delete
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit === 'new' ? 'New tariff' : 'Edit tariff'} wide>
        {edit && <TariffForm t={edit} onDone={() => setEdit(null)} />}
      </Modal>
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title="Delete tariff" body={<>Delete “{del?.name}”? Hours it covered are priced with the previous tariff for the same scope, or not at all.</>} confirmLabel="Delete" onConfirm={() => remove.mutate()} busy={remove.isPending} error={remove.error} />
    </Panel>
  );
}

/* ------------------------------------------------------------------ retention */

function RetentionTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['power', 'settings'], queryFn: () => api.get<{ rawDays: number; hourlyDays: number }>('/power/settings') });
  const [v, setV] = useState<{ rawDays: number; hourlyDays: number } | null>(null);
  useEffect(() => {
    if (q.data && !v) setV(q.data);
  }, [q.data, v]);
  const save = useMutation({ mutationFn: () => api.put('/power/settings', v), onSuccess: () => qc.invalidateQueries({ queryKey: ['power', 'settings'] }) });
  if (!v) return <Loading />;
  const manage = can('power.configure');
  return (
    <Panel title="How long power data is kept">
      <form className="grid max-w-lg gap-3" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Readings (days)" hint="7–365">
            {(id, h) => <Input id={id} aria-describedby={h} type="number" min={7} max={365} disabled={!manage} value={v.rawDays} onChange={(e) => setV({ ...v, rawDays: Number(e.target.value) })} />}
          </Field>
          <Field label="Hourly energy (days)" hint="90–3650; billing history">
            {(id, h) => <Input id={id} aria-describedby={h} type="number" min={90} max={3650} disabled={!manage} value={v.hourlyDays} onChange={(e) => setV({ ...v, hourlyDays: Number(e.target.value) })} />}
          </Field>
        </div>
        <ErrorNote error={save.error} />
        {save.isSuccess && <p className="text-[13px] text-ok">Saved.</p>}
        {manage && (
          <div>
            <Button type="submit" variant="primary" busy={save.isPending}>
              Save
            </Button>
          </div>
        )}
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ page */

export function PowerPage() {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const [params, setParams] = useSearchParams();
  const tabs = staff ? STAFF_TABS : CUSTOMER_TABS;
  const tab = ((params.get('tab') as TabKey) ?? 'overview') as TabKey;
  const device = params.get('device');
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  return (
    <>
      <PageHeader
        title={staff ? 'Power consumption' : 'Your power'}
        description={
          staff
            ? 'Equipment power from BMCs, metered PDU outlets and switch power supplies, with labelled estimates where nothing is measured. Energy and cost per hour, rack, datacenter and customer. Collection is read-only.'
            : 'Power and energy of the equipment assigned to your account. Measured figures and estimates are labelled.'
        }
      />
      <Tabs tabs={tabs as unknown as readonly { key: TabKey; label: string }[]} value={tab} label="Power sections" onChange={(k) => setParam('tab', k === 'overview' ? null : k)} />
      {tab === 'overview' && <OverviewTab onDevice={(id) => setParam('device', id)} />}
      {tab === 'devices' && <DevicesTab onDevice={(id) => setParam('device', id)} />}
      {tab === 'energy' && <EnergyTab />}
      {staff && tab === 'racks' && <RacksTab />}
      {staff && tab === 'pdus' && <PdusTab />}
      {staff && tab === 'collection' && <CollectionTab />}
      {staff && tab === 'tariffs' && <TariffsTab />}
      {staff && tab === 'retention' && <RetentionTab />}
      {device && <DeviceDetail id={device} onClose={() => setParam('device', null)} />}
    </>
  );
}
