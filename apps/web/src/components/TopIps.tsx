import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FLOW_RANGES, FLOW_RANGE_LABELS, type FlowRange } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { bps } from '../lib/monitoring';
import type { NetworkDeviceT } from '../lib/network';
import { useCustomerOptions } from '../lib/colocation';
import { PeriodPicker, periodReady, type PeriodValue } from './DateRange';
import { RateChart } from './RateChart';
import { Button, Chip, EmptyState, ErrorNote, Field, Input, Loading, Modal, Panel, Select, Stat, Table, cx } from './ui';

interface TopIpT {
  ip: string;
  inBytes: number;
  outBytes: number;
  inBps: number;
  outBps: number;
  inPeakBps: number;
  outPeakBps: number;
  dnsName: string | null;
  prefix: string | null;
  prefixId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  customerId: string | null;
  customerName: string | null;
}
interface TopT {
  range: { name: string; from: string; to: string; stepSeconds: number; coveredFrom: string; averagedSeconds: number };
  totals: { addresses: number; inBytes: number; outBytes: number; inBps: number; outBps: number };
  latestDataAt: string | null;
  items: TopIpT[];
}
interface HistoryT {
  ip: string;
  stepSeconds: number;
  range: { from: string; to: string };
  totals: { inBytes: number; outBytes: number; inBps: number; outBps: number };
  points: { t: string; inBps: number; outBps: number }[];
}
interface ExporterT {
  id: string;
  name: string;
  address: string;
  deviceId: string | null;
  deviceName: string | null;
  enabled: boolean;
  samplingRate: number;
  lastPacketAt: string | null;
  lastVersion: number | null;
  packets: number;
  records: number;
  unmatchedRecords: number;
  badPackets: number;
  lastError: string | null;
  receiving: boolean;
}
interface ExportersT {
  collector: { listening: boolean; port: number; error: string | null; at: string; unknownSources: { address: string; packets: number; lastAt: string }[] } | null;
  exporters: ExporterT[];
}

type Sort = 'download' | 'upload' | 'total';

/** Data volumes in decimal units, as bandwidth is billed (1 GB = 10⁹ bytes). */
export function volume(n: number) {
  const u = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < u.length - 1) ((v /= 1000), i++);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${u[i]}`;
}

function rangeQuery(v: PeriodValue<FlowRange>) {
  return v.period === 'custom' ? { range: 'custom', from: v.from, to: v.to } : { range: v.period };
}

function Bar({ value, max, tone }: { value: number; max: number; tone: 'rx' | 'tx' }) {
  return (
    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-sunken">
      <span className="block h-full rounded-full" style={{ width: `${max > 0 ? Math.max(1, (value / max) * 100) : 0}%`, background: `var(--${tone})` }} />
    </span>
  );
}

function IpHistory({ ip, range, onClose }: { ip: TopIpT; range: PeriodValue<FlowRange>; onClose: () => void }) {
  const rq = rangeQuery(range);
  const h = useQuery({
    queryKey: ['flows', 'history', ip.ip, rq],
    queryFn: () => api.get<HistoryT>(`/monitoring/flows/ips/${encodeURIComponent(ip.ip)}/history${qs(rq)}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
  const d = h.data;
  return (
    <Panel
      title={
        <span>
          <span className="font-mono">{ip.ip}</span>
          {ip.dnsName && <span className="ml-2 font-normal text-ink-3">{ip.dnsName}</span>}
        </span>
      }
      actions={
        <button className="rounded-md px-2 py-1 text-[13px] text-ink-2 hover:bg-sunken" onClick={onClose} aria-label="Close chart">
          ✕
        </button>
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat label="Download, average" value={bps(ip.inBps)} note={`${volume(ip.inBytes)} in this period`} />
        <Stat label="Upload, average" value={bps(ip.outBps)} note={`${volume(ip.outBytes)} in this period`} />
        <Stat label="Busiest minute down" value={bps(ip.inPeakBps)} />
        <Stat label="Busiest minute up" value={bps(ip.outPeakBps)} />
      </dl>
      <p className="mb-3 text-[13px] text-ink-2">
        {ip.customerName && <>Customer {ip.customerName} · </>}
        {ip.deviceName && (
          <>
            Device{' '}
            <Link to={`/hardware/${ip.deviceId}`} className="text-accent hover:underline">
              {ip.deviceName}
            </Link>{' '}
            ·{' '}
          </>
        )}
        {ip.prefix && (
          <>
            Prefix{' '}
            {ip.prefixId ? (
              <Link to={`/ipam/prefixes/${ip.prefixId}`} className="font-mono text-accent hover:underline">
                {ip.prefix}
              </Link>
            ) : (
              <span className="font-mono">{ip.prefix}</span>
            )}
          </>
        )}
      </p>
      <ErrorNote error={h.error} />
      {h.isLoading && <Loading />}
      {d && d.points.length > 0 && (
        <>
          <RateChart
            label={`Traffic of ${ip.ip}`}
            points={d.points.map((p) => ({ t: new Date(p.t).getTime(), inBps: p.inBps, outBps: p.outBps }))}
            stepSeconds={d.stepSeconds}
            from={new Date(d.range.from).getTime()}
            to={new Date(d.range.to).getTime()}
          />
          <p className="mt-2 text-[12.5px] text-ink-3">
            Inbound = download (traffic to {ip.ip}), outbound = upload (from it). {d.stepSeconds === 60 ? 'Per-minute' : 'Hourly'} averages from the router's flow records. Gaps are periods with no flows to or from this address.
          </p>
        </>
      )}
      {d && !d.points.length && <p className="text-[13px] text-ink-3">No flows in this period.</p>}
    </Panel>
  );
}

function ExporterForm({ exporter, preset, onClose }: { exporter?: ExporterT; preset?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['network', 'devices', 'picker', false], queryFn: () => api.get<NetworkDeviceT[]>('/network/devices') });
  const [f, setF] = useState({ name: exporter?.name ?? '', address: exporter?.address ?? preset ?? '', deviceId: exporter?.deviceId ?? '', samplingRate: String(exporter?.samplingRate ?? 1), enabled: exporter?.enabled ?? true });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, address: f.address, deviceId: f.deviceId || null, samplingRate: Number(f.samplingRate) || 1, enabled: f.enabled };
      return exporter ? api.put(`/monitoring/flows/exporters/${exporter.id}`, body) : api.post('/monitoring/flows/exporters', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['flows', 'exporters'] });
      onClose();
    },
  });
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="edge-rtr-01" autoFocus />}</Field>
      <Field label="Router's source address" hint="The address the router sends flows from, as this server sees it (often its public or management address).">
        {(id, d) => <Input id={id} aria-describedby={d} required value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} className="font-mono" placeholder="203.0.113.1" />}
      </Field>
      <Field label="Device (optional)">
        {(id) => (
          <Select id={id} value={f.deviceId} onChange={(e) => setF({ ...f, deviceId: e.target.value })}>
            <option value="">—</option>
            {(devices.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname || d.assetTag}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Sampling (1 in N packets)" hint="1 for MikroTik Traffic Flow, which records every packet. Used when the router does not announce its sampling.">
        {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={1000000} value={f.samplingRate} onChange={(e) => setF({ ...f, samplingRate: e.target.value })} />}
      </Field>
      <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Accept flows from this router
      </label>
      <ErrorNote error={save.error} className="sm:col-span-2" />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          {exporter ? 'Save' : 'Add router'}
        </Button>
      </div>
    </form>
  );
}

/** Routers sending flows, what arrived from each, and the RouterOS commands to turn exporting on. */
function FlowSources() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('monitoring.configure');
  const q = useQuery({ queryKey: ['flows', 'exporters'], queryFn: () => api.get<ExportersT>('/monitoring/flows/exporters'), refetchInterval: 15_000 });
  const [editing, setEditing] = useState<ExporterT | 'new' | { preset: string } | null>(null);
  const [server, setServer] = useState('');
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/monitoring/flows/exporters/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['flows', 'exporters'] }) });
  const c = q.data?.collector;
  const port = c?.port ?? 2055;
  const target = server.trim() || '<this server’s IP>';
  const commands = `/ip traffic-flow set enabled=yes interfaces=all active-flow-timeout=1m inactive-flow-timeout=15s\n/ip traffic-flow target add dst-address=${target} port=${port} version=ipfix`;
  const [copied, setCopied] = useState(false);
  return (
    <Panel
      title="Flow sources (routers)"
      flush
      actions={
        manage && (
          <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
            Add router
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-rule px-4 py-2.5 text-[13px]">
        {c ? (
          c.listening ? (
            <Chip tone="ok">Collector listening on UDP {c.port}</Chip>
          ) : (
            <Chip tone="crit">Collector not listening{c.error ? `: ${c.error}` : ''}</Chip>
          )
        ) : (
          <Chip tone="warn">Collector status unknown (worker not reporting)</Chip>
        )}
        <span className="text-ink-3">NetFlow v5, v9 and IPFIX. Only your IPAM addresses are recorded; internet addresses are not stored.</span>
      </div>
      <ErrorNote error={q.error ?? remove.error} className="m-4" />
      {q.isLoading && <Loading />}
      {q.data && q.data.exporters.length > 0 && (
        <Table label="Flow sources">
          <thead>
            <tr>
              <th>Router</th>
              <th>Source address</th>
              <th>Status</th>
              <th className="text-right">Records</th>
              <th className="text-right">Not your addresses</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {q.data.exporters.map((e) => (
              <tr key={e.id}>
                <td>
                  <span className="font-medium">{e.name}</span>
                  {e.deviceName && <span className="block text-[12px] text-ink-3">{e.deviceName}</span>}
                </td>
                <td className="font-mono text-[13px]">{e.address}</td>
                <td className="text-[13px]">
                  {!e.enabled ? (
                    <Chip>Ignored</Chip>
                  ) : e.receiving ? (
                    <Chip tone="ok">Receiving{e.lastVersion ? ` · ${e.lastVersion === 10 ? 'IPFIX' : `v${e.lastVersion}`}` : ''}</Chip>
                  ) : e.lastPacketAt ? (
                    <Chip tone="warn">Silent since {relativeTime(e.lastPacketAt)}</Chip>
                  ) : (
                    <Chip tone="warn">Nothing received yet</Chip>
                  )}
                  {e.badPackets > 0 && (
                    <span className="mt-0.5 block text-[12px] text-warn" title={e.lastError ?? undefined}>
                      {e.badPackets.toLocaleString('en-IN')} unreadable packets
                    </span>
                  )}
                  {e.samplingRate > 1 && <span className="block text-[12px] text-ink-3">Sampling 1:{e.samplingRate}</span>}
                </td>
                <td className="text-right tabular-nums">{e.records.toLocaleString('en-IN')}</td>
                <td className="text-right tabular-nums text-ink-3" title="Flows where neither address is in your IPAM prefixes (e.g. transit between two internet addresses)">
                  {e.unmatchedRecords.toLocaleString('en-IN')}
                </td>
                <td className="text-right whitespace-nowrap">
                  {manage && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(e)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove.mutate(e.id)}>
                        Remove
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {!!c?.unknownSources?.length && (
        <div className="border-t border-rule px-4 py-3 text-[13px]">
          <p className="mb-1.5 font-medium text-warn">Flows arriving from addresses that are not registered (ignored):</p>
          <ul className="flex flex-wrap gap-2">
            {c.unknownSources.map((u) => (
              <li key={u.address} className="flex items-center gap-2 rounded-lg border border-rule px-2 py-1">
                <span className="font-mono">{u.address}</span>
                <span className="text-ink-3">
                  {u.packets.toLocaleString('en-IN')} packets, {relativeTime(u.lastAt)}
                </span>
                {manage && (
                  <button className="text-accent hover:underline" onClick={() => setEditing({ preset: u.address })}>
                    Register
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="border-t border-rule px-4 py-3">
        <p className="mb-2 text-[13px] font-medium">Turn on Traffic Flow on a MikroTik router (RouterOS terminal)</p>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Input className="w-56 font-mono" placeholder="This server's IP address" value={server} onChange={(e) => setServer(e.target.value)} aria-label="This server's IP address as the router reaches it" />
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(commands).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy commands'}
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-sunken p-3 font-mono text-[12.5px] whitespace-pre">{commands}</pre>
        <ul className="mt-2 list-disc pl-5 text-[12.5px] text-ink-3">
          <li>Then add the router above with the address it sends from (shown under "not registered" once flows arrive).</li>
          <li>The 1-minute active timeout makes long downloads show up every minute instead of every 30 minutes (the RouterOS default).</li>
          <li>
            If RouterOS answers <span className="font-mono">cache too big to fit in memory</span>, the flow cache is larger than the router's free memory: set a smaller one first (<span className="font-mono">/ip traffic-flow set cache-entries=16k</span>, or 4k on small routers), then run the first command again. A smaller cache only means flows are sent a little more often.
          </li>
          <li>Allow UDP port {port} from the router on this server's firewall. The installer opens it when firewalld or ufw is active.</li>
          <li>Reading flows is passive: NexoraDC never changes the router.</li>
        </ul>
      </div>
      <Modal wide open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing && typeof editing === 'object' && 'id' in editing ? `Edit ${editing.name}` : 'Add a router that sends flows'}>
        {editing !== null && (
          <ExporterForm exporter={typeof editing === 'object' && 'id' in editing ? editing : undefined} preset={typeof editing === 'object' && 'preset' in editing ? editing.preset : undefined} onClose={() => setEditing(null)} />
        )}
      </Modal>
    </Panel>
  );
}

/**
 * Bandwidth per IP address: your addresses ranked by download (traffic to the
 * address) and upload (from it), from the routers' flow records.
 */
export function TopIps({ customerId: fixedCustomer }: { customerId?: string } = {}) {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const customers = useCustomerOptions();
  const [range, setRange] = useState<PeriodValue<FlowRange>>({ period: '1h', from: '', to: '' });
  const [sort, setSort] = useState<Sort>('download');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [customerId, setCustomerId] = useState(fixedCustomer ?? '');
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const rq = rangeQuery(range);
  const top = useQuery({
    queryKey: ['flows', 'top', rq, sort, debounced, customerId, limit],
    queryFn: () => api.get<TopT>(`/monitoring/flows/top${qs({ ...rq, sort, q: debounced || undefined, customerId: customerId || undefined, limit })}`),
    enabled: periodReady(range),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const items = top.data?.items ?? [];
  const max = useMemo(() => Math.max(1, ...items.map((x) => Math.max(x.inBytes, x.outBytes))), [items]);
  const selected = items.find((x) => x.ip === open);
  const t = top.data?.totals;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Panel>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat label="Download, average" value={t ? bps(t.inBps) : '—'} note={t ? `${volume(t.inBytes)} to your addresses` : undefined} />
          <Stat label="Upload, average" value={t ? bps(t.outBps) : '—'} note={t ? `${volume(t.outBytes)} from your addresses` : undefined} />
          <Stat label="Addresses with traffic" value={t?.addresses ?? '—'} />
          <Stat
            label="Newest flow data"
            value={<span className="text-[18px]">{top.data?.latestDataAt ? relativeTime(top.data.latestDataAt) : 'None yet'}</span>}
            tone={top.data && !top.data.latestDataAt ? 'warn' : undefined}
            note={top.data?.latestDataAt ? 'Routers send flows about once a minute' : staff ? 'Set up a router below' : 'Bandwidth per IP appears once the datacenter turns on flow export'}
          />
        </dl>
      </Panel>
      {selected && <IpHistory key={selected.ip} ip={selected} range={range} onClose={() => setOpen(null)} />}
      <Panel
        flush
        title={staff ? 'Top IP addresses by bandwidth' : 'Your IP addresses by bandwidth'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex rounded-lg border border-rule bg-panel p-0.5 text-[13px]" role="group" aria-label="Rank by">
              {(
                [
                  ['download', 'Download'],
                  ['upload', 'Upload'],
                  ['total', 'Total'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)} className={sort === k ? 'rounded-md bg-field px-2.5 py-1 font-medium' : 'rounded-md px-2.5 py-1 text-ink-3 hover:text-ink'}>
                  {l}
                </button>
              ))}
            </span>
            <PeriodPicker value={range} onChange={setRange} options={FLOW_RANGES} labels={FLOW_RANGE_LABELS} className="w-40" />
            <Input className="w-56" placeholder={staff ? 'IP, name, device, customer' : 'IP, name or device'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search addresses" />
            {staff && !fixedCustomer && (
              <Select className="w-44" value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Customer">
                <option value="">All customers</option>
                {(customers.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
            <Select className="w-28" value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))} aria-label="How many">
              {[25, 50, 100, 200, 500].map((n) => (
                <option key={n} value={n}>
                  Top {n}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        <ErrorNote error={top.error} className="m-4" />
        {top.isLoading && <Loading />}
        {top.data && items.length === 0 && (
          <EmptyState title={debounced || customerId ? 'No matching addresses' : 'No traffic recorded for this period'}>
            {staff ? 'Bandwidth per IP comes from your routers’ flow records. Set up a router under Flow sources below; addresses must be inside a prefix in IP Address Management.' : 'No flows to or from your addresses in this period.'}
          </EmptyState>
        )}
        {items.length > 0 && (
          <Table label="Top IP addresses">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>Address</th>
                <th>{staff ? 'Customer · device' : 'Device'}</th>
                <th className="text-right">Download</th>
                <th className="text-right">Upload</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x, k) => (
                <tr key={x.ip} className={cx('cursor-pointer hover:bg-sunken/60', open === x.ip && 'bg-accent-soft')} onClick={() => setOpen(open === x.ip ? null : x.ip)}>
                  <td className="text-ink-3 tabular-nums">{k + 1}</td>
                  <td>
                    <button className="font-mono text-[13px] text-accent hover:underline" onClick={(e) => (e.stopPropagation(), setOpen(x.ip))}>
                      {x.ip}
                    </button>
                    {x.dnsName && <span className="block max-w-[28ch] truncate text-[12px] text-ink-3">{x.dnsName}</span>}
                  </td>
                  <td className="text-[13px]">
                    {staff && (x.customerName ?? <span className="text-ink-3">No customer</span>)}
                    {x.deviceName && <span className={cx('block', staff && 'text-[12px] text-ink-3')}>{x.deviceName}</span>}
                    {!staff && !x.deviceName && <span className="text-ink-3">—</span>}
                  </td>
                  <td className="w-44 text-right">
                    <span className={cx('tabular-nums', sort === 'download' && 'font-semibold')}>{bps(x.inBps)}</span>
                    <span className="block text-[12px] text-ink-3 tabular-nums">{volume(x.inBytes)}</span>
                    <Bar value={x.inBytes} max={max} tone="rx" />
                  </td>
                  <td className="w-44 text-right">
                    <span className={cx('tabular-nums', sort === 'upload' && 'font-semibold')}>{bps(x.outBps)}</span>
                    <span className="block text-[12px] text-ink-3 tabular-nums">{volume(x.outBytes)}</span>
                    <Bar value={x.outBytes} max={max} tone="tx" />
                  </td>
                  <td className={cx('text-right tabular-nums', sort === 'total' && 'font-semibold')}>
                    {bps(x.inBps + x.outBps)}
                    <span className="block text-[12px] font-normal text-ink-3">{volume(x.inBytes + x.outBytes)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {items.length > 0 && (
          <p className="px-4 py-2.5 text-[12px] text-ink-3">
            {top.data && top.data.range.coveredFrom > top.data.range.from ? `Flow data in this period starts ${relativeTime(top.data.range.coveredFrom)}; averages cover only that part. ` : ''}Averages over the period, measured from the
            routers' flow records (NetFlow/IPFIX). Download is traffic to the address, upload traffic from it. Click an address for its chart.
          </p>
        )}
      </Panel>
      {staff && !fixedCustomer && <FlowSources />}
    </div>
  );
}
