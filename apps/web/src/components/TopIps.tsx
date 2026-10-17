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

/** ASN and approximate location of a remote address, looked up locally (DB-IP Lite / GeoLite2). */
interface GeoT {
  private?: boolean;
  asn: number | null;
  asName: string | null;
  country: string | null;
  countryName: string | null;
  region: string | null;
  city: string | null;
}
interface GeoStatusT {
  city: { file: string; updatedAt: string } | null;
  asn: { file: string; updatedAt: string } | null;
  source: string | null;
}
interface PeerT {
  ip: string;
  inBps?: number;
  outBps?: number;
  inBytes?: number;
  outBytes?: number;
  geo: GeoT;
}
interface PeersT {
  ip: string;
  range: string;
  source?: 'realtime' | 'flows';
  from?: string;
  to?: string;
  geo: GeoStatusT;
  items: PeerT[];
}

function flag(cc: string | null) {
  if (!cc || !/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function place(g: GeoT) {
  if (g.private) return 'Private / reserved range';
  const parts = [g.city, g.region && g.region !== g.city ? g.region : null, g.countryName ?? g.country].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Unknown';
}

function AsnText({ g }: { g: GeoT }) {
  if (g.private) return <span className="text-ink-3">—</span>;
  if (!g.asn) return <span className="text-ink-3">Unknown</span>;
  return (
    <>
      <span className="font-mono">AS{g.asn}</span>
      {g.asName && <span className="ml-1 text-ink-2">{g.asName}</span>}
    </>
  );
}

function GeoAttribution({ geo }: { geo?: GeoStatusT }) {
  if (!geo) return null;
  if (!geo.city && !geo.asn) return <>ASN and location appear once the IP database has been downloaded (the worker fetches DB-IP Lite automatically; it needs HTTPS access to download.db-ip.com). </>;
  return geo.source === 'DB-IP' ? (
    <>
      ASN and approximate location:{' '}
      <a href="https://db-ip.com" target="_blank" rel="noreferrer" className="text-accent hover:underline">
        IP Geolocation by DB-IP
      </a>
      , looked up on this server. City is often approximate.{' '}
    </>
  ) : (
    <>ASN and approximate location from {geo.source}, looked up on this server. </>
  );
}

/** "Top remote" cell: the remote address with the most traffic, its ASN and location. */
function PeerCell({ peer }: { peer?: PeerT | null }) {
  if (!peer) return <span className="text-[12px] text-ink-3">—</span>;
  const g = peer.geo;
  return (
    <span className="block max-w-[34ch] text-[12.5px] leading-snug">
      <span className="font-mono">{peer.ip}</span>
      <span className="block truncate text-ink-3" title={`${g.asn ? `AS${g.asn} ${g.asName ?? ''} · ` : ''}${place(g)}`}>
        {g.private ? (
          'Private / reserved range'
        ) : (
          <>
            {g.asn ? `AS${g.asn}${g.asName ? ` ${g.asName}` : ''}` : 'Unknown ASN'}
            {' · '}
            {flag(g.country)} {g.city ?? g.countryName ?? g.country ?? 'Unknown location'}
          </>
        )}
      </span>
    </span>
  );
}

function RemotePeers({ ip, range, live }: { ip: string; range: PeriodValue<FlowRange>; live: boolean }) {
  const rq = live ? { range: 'live' } : rangeQuery(range);
  const r = useQuery({
    queryKey: ['flows', 'peers', ip, rq],
    queryFn: () => api.get<PeersT>(`/monitoring/flows/ips/${encodeURIComponent(ip)}/peers${qs({ ...rq, limit: 25 })}`),
    refetchInterval: live ? 5_000 : 60_000,
    placeholderData: keepPreviousData,
  });
  const d = r.data;
  const rows = d?.items ?? [];
  const maxRow = Math.max(1, ...rows.map((x) => (live ? Math.max(x.inBps ?? 0, x.outBps ?? 0) : Math.max(x.inBytes ?? 0, x.outBytes ?? 0))));
  return (
    <div className="mt-6">
      <div className="mb-1 text-[13px] font-medium">{live ? 'Remote addresses now' : `Remote addresses, ${FLOW_RANGE_LABELS[range.period as FlowRange]?.toLowerCase() ?? 'chosen days'}`}</div>
      <ErrorNote error={r.error} />
      {r.isLoading && <Loading />}
      {d && !rows.length && <p className="text-[13px] text-ink-3">{live ? 'No remote addresses in the last minute.' : 'No remote addresses recorded for this period (kept for 14 days, hourly).'}</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table label={`Remote addresses of ${ip}`}>
            <thead>
              <tr>
                <th>Remote address</th>
                <th>ASN</th>
                <th>Location</th>
                <th className="text-right">Download{live ? ' now' : ''}</th>
                <th className="text-right">Upload{live ? ' now' : ''}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.ip}>
                  <td className="font-mono text-[13px]">{x.ip}</td>
                  <td className="max-w-[30ch] truncate text-[13px]">
                    <AsnText g={x.geo} />
                  </td>
                  <td className="text-[13px]">
                    {flag(x.geo.country)} {place(x.geo)}
                  </td>
                  <td className="w-36 text-right tabular-nums">
                    {live ? bps(x.inBps ?? 0) : volume(x.inBytes ?? 0)}
                    <Bar value={live ? (x.inBps ?? 0) : (x.inBytes ?? 0)} max={maxRow} tone="rx" />
                  </td>
                  <td className="w-36 text-right tabular-nums">
                    {live ? bps(x.outBps ?? 0) : volume(x.outBytes ?? 0)}
                    <Bar value={live ? (x.outBps ?? 0) : (x.outBytes ?? 0)} max={maxRow} tone="tx" />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
      <p className="mt-2 text-[12.5px] text-ink-3">
        {live
          ? d?.source === 'realtime'
            ? 'The busiest remote addresses this second, from the router (Torch). '
            : 'The busiest remote addresses in the last minute of flow records (top 5). '
          : 'The remote addresses with most traffic, from hourly totals (whole hours covering the period; the busiest 20 per hour are kept). '}
        Download = from the remote address to {ip}; upload = from {ip} to it. <GeoAttribution geo={d?.geo} />
      </p>
    </div>
  );
}

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
  topPeer?: PeerT | null;
}
interface TopT {
  geo?: GeoStatusT;
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
  liveInterface: string | null;
  liveDirection: 'uplink' | 'downlink';
  liveReady: boolean;
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

interface IpRowT {
  ip: string;
  inBps: number;
  outBps: number;
  inBytes?: number;
  outBytes?: number;
  inPeakBps?: number;
  outPeakBps?: number;
  dnsName: string | null;
  prefix: string | null;
  prefixId: string | null;
  deviceId: string | null;
  deviceName: string | null;
  customerId: string | null;
  customerName: string | null;
  topPeer?: PeerT | null;
}
interface LiveT {
  geo?: GeoStatusT;
  /** 'realtime': per-second rates from the routers (Torch); 'flows': the last minute of flow records. */
  source: 'realtime' | 'flows';
  routers: { id: string; name: string; interface: string; ok: boolean; error: string | null; lastAt: string | null }[];
  at: string | null;
  windowSeconds: number;
  totals: { addresses: number; inBps: number; outBps: number };
  items: IpRowT[];
}
type LiveSampleT = { t: number; inBps: number; outBps: number };

function IpHistory({ ip, range, samples, realtime, onClose }: { ip: IpRowT; range: PeriodValue<FlowRange>; samples?: LiveSampleT[]; realtime?: boolean; onClose: () => void }) {
  const rq = rangeQuery(range);
  const h = useQuery({
    queryKey: ['flows', 'history', ip.ip, rq],
    queryFn: () => api.get<HistoryT>(`/monitoring/flows/ips/${encodeURIComponent(ip.ip)}/history${qs(rq)}`),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const d = h.data;
  const live = samples && samples.length ? samples[samples.length - 1]! : null;
  const now = Date.now();
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
        {samples ? (
          <>
            <Stat label="Download now" value={bps(live?.inBps ?? ip.inBps)} note={realtime ? 'this second' : 'last minute, updates every 5 s'} />
            <Stat label="Upload now" value={bps(live?.outBps ?? ip.outBps)} note={realtime ? 'this second' : 'last minute, updates every 5 s'} />
          </>
        ) : (
          <>
            <Stat label="Download, average" value={bps(ip.inBps)} note={ip.inBytes !== undefined ? `${volume(ip.inBytes)} in this period` : undefined} />
            <Stat label="Upload, average" value={bps(ip.outBps)} note={ip.outBytes !== undefined ? `${volume(ip.outBytes)} in this period` : undefined} />
          </>
        )}
        <Stat label={`Download, ${FLOW_RANGE_LABELS[range.period as FlowRange]?.toLowerCase() ?? 'period'}`} value={d ? volume(d.totals.inBytes) : '—'} note={d ? `average ${bps(d.totals.inBps)}` : undefined} />
        <Stat label={`Upload, ${FLOW_RANGE_LABELS[range.period as FlowRange]?.toLowerCase() ?? 'period'}`} value={d ? volume(d.totals.outBytes) : '—'} note={d ? `average ${bps(d.totals.outBps)}` : undefined} />
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
      {samples && (
        <div className="mb-5">
          <div className="mb-1 flex items-center gap-2 text-[13px]">
            <span className="size-2 animate-pulse rounded-full bg-ok" aria-hidden />
            <span className="font-medium">Live</span>
            <span className="text-ink-3">
              {realtime ? 'Read from the router every second (MikroTik Torch) while this page is open; not stored.' : 'Rate over the last minute of flow records, a new point every 5 seconds while this page is open.'}
            </span>
          </div>
          {samples.length > 1 ? (
            <RateChart label={`Live traffic of ${ip.ip}`} points={samples} stepSeconds={realtime ? 1 : 5} from={now - (realtime ? 5 : 10) * 60_000} to={now} />
          ) : (
            <p className="py-6 text-center text-[13px] text-ink-3">Collecting live points…</p>
          )}
        </div>
      )}
      <div className="mb-1 text-[13px] font-medium">History, {FLOW_RANGE_LABELS[range.period as FlowRange]?.toLowerCase() ?? 'chosen days'}</div>
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
      <RemotePeers ip={ip.ip} range={range} live={!!samples} />
    </Panel>
  );
}

function ExporterForm({ exporter, preset, onClose }: { exporter?: ExporterT; preset?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['network', 'devices', 'picker', false], queryFn: () => api.get<NetworkDeviceT[]>('/network/devices') });
  const [f, setF] = useState({
    name: exporter?.name ?? '',
    address: exporter?.address ?? preset ?? '',
    deviceId: exporter?.deviceId ?? '',
    samplingRate: String(exporter?.samplingRate ?? 1),
    enabled: exporter?.enabled ?? true,
    liveInterface: exporter?.liveInterface ?? '',
    liveDirection: exporter?.liveDirection ?? 'uplink',
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, address: f.address, deviceId: f.deviceId || null, samplingRate: Number(f.samplingRate) || 1, enabled: f.enabled, liveInterface: f.liveInterface.trim() || null, liveDirection: f.liveDirection };
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
      <div className="grid gap-4 rounded-lg border border-rule p-3 sm:col-span-2 sm:grid-cols-2">
        <p className="text-[13px] sm:col-span-2">
          <span className="font-medium">Real time, every second (optional).</span>{' '}
          <span className="text-ink-2">
            NexoraDC reads MikroTik Torch on one interface while someone has the live view open (read-only). Needs the device above with a "MikroTik RouterOS API" credential (Network → device → Credentials).
          </span>
        </p>
        <Field label="Interface to watch" hint="Usually the uplink towards your transit, e.g. sfp-sfpplus1 or a bonding interface.">
          {(id, d) => <Input id={id} aria-describedby={d} value={f.liveInterface} onChange={(e) => setF({ ...f, liveInterface: e.target.value })} className="font-mono" placeholder="sfp-sfpplus1" />}
        </Field>
        <Field label="That interface faces">
          {(id) => (
            <Select id={id} value={f.liveDirection} onChange={(e) => setF({ ...f, liveDirection: e.target.value as 'uplink' | 'downlink' })}>
              <option value="uplink">The internet (uplink): received = download</option>
              <option value="downlink">Your customers: received = upload</option>
            </Select>
          )}
        </Field>
      </div>
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
        <span className="text-ink-3">NetFlow v5, v9 and IPFIX. Totals are kept for your IPAM addresses; the remote addresses they talk to are kept as hourly top 20 for 14 days. Traffic between two internet addresses is not stored.</span>
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
                  {e.liveInterface && (
                    <span className={cx('block text-[12px]', e.liveReady ? 'text-ink-3' : 'text-warn')}>
                      Real time: <span className="font-mono">{e.liveInterface}</span>
                      {e.liveReady ? '' : ' (needs a RouterOS API credential on the linked device)'}
                    </span>
                  )}
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
            If RouterOS answers <span className="font-mono">cache too big to fit in memory</span>, the flow cache is larger than the router's free memory: set a smaller one first (
            <span className="font-mono">/ip traffic-flow set cache-entries=16k</span>, or 4k on small routers), then run the first command again. A smaller cache only means flows are sent a little more often.
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
 * address) and upload (from it), from the routers' flow records. Live (the
 * last minute, refreshed every 5 seconds) or averaged over a period.
 */
export function TopIps({ customerId: fixedCustomer }: { customerId?: string } = {}) {
  const { me } = useAuth();
  const staff = me?.user.userType === 'staff';
  const customers = useCustomerOptions();
  const [mode, setMode] = useState<'live' | 'period'>('live');
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
  const filters = { sort, q: debounced || undefined, customerId: customerId || undefined, limit };
  const rq = rangeQuery(range);
  const live = useQuery({
    queryKey: ['flows', 'live', filters],
    queryFn: () => api.get<LiveT>(`/monitoring/flows/live${qs(filters)}`),
    enabled: mode === 'live',
    // Every second while the routers stream real-time rates; every 5 s for flow records.
    refetchInterval: (q) => (q.state.data?.source === 'realtime' ? 1_000 : 5_000),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
  const top = useQuery({
    queryKey: ['flows', 'top', rq, filters],
    queryFn: () => api.get<TopT>(`/monitoring/flows/top${qs({ ...rq, ...filters })}`),
    enabled: periodReady(range) && (mode === 'period' || !!open),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  // While the live view is open, keep the routers' real-time streams (Torch) running.
  useEffect(() => {
    if (mode !== 'live') return;
    const beat = () => void api.post('/monitoring/flows/live/watch').catch(() => undefined);
    beat();
    const h = setInterval(beat, 10_000);
    return () => clearInterval(h);
  }, [mode]);
  // Live points per address, kept in the browser for 10 minutes (one per refresh).
  const [samples, setSamples] = useState<Map<string, LiveSampleT[]>>(() => new Map());
  useEffect(() => {
    const d = live.data;
    if (!d?.at) return;
    const t = new Date(d.at).getTime();
    setSamples((prev) => {
      const next = new Map(prev);
      const cutoff = Date.now() - 10 * 60_000;
      for (const x of d.items) {
        const list = (next.get(x.ip) ?? []).filter((s) => s.t >= cutoff && s.t !== t);
        list.push({ t, inBps: x.inBps, outBps: x.outBps });
        next.set(x.ip, list);
      }
      return next;
    });
  }, [live.data]);
  const isLive = mode === 'live';
  const items: IpRowT[] = (isLive ? live.data?.items : top.data?.items) ?? [];
  const max = useMemo(() => Math.max(1, ...items.map((x) => (isLive ? Math.max(x.inBps, x.outBps) : Math.max(x.inBytes ?? 0, x.outBytes ?? 0)))), [items, isLive]);
  const selected = items.find((x) => x.ip === open) ?? (isLive ? undefined : undefined);
  const busy = isLive ? live : top;
  const at = live.data?.at;
  const fresh = !!at && Date.now() - new Date(at).getTime() < 30_000;
  const realtime = live.data?.source === 'realtime';
  const rtProblem = staff ? live.data?.routers.find((r) => !r.ok && r.error) : undefined;
  const t = top.data?.totals;
  const lt = live.data?.totals;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <Panel>
        {isLive ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Stat label="Download now" value={lt && fresh ? bps(lt.inBps) : '—'} note={realtime ? 'to your addresses, this second' : 'to your addresses, last minute'} />
            <Stat label="Upload now" value={lt && fresh ? bps(lt.outBps) : '—'} note={realtime ? 'from your addresses, this second' : 'from your addresses, last minute'} />
            <Stat label="Active addresses" value={lt && fresh ? lt.addresses : '—'} />
            <Stat
              label="Live feed"
              value={
                <span className="flex items-center gap-2 text-[18px]">
                  <span className={cx('size-2 rounded-full', fresh ? 'animate-pulse bg-ok' : 'bg-warn')} aria-hidden />
                  {realtime ? 'Real time' : fresh ? 'Receiving' : at ? `Stale (${relativeTime(at)})` : 'No flows arriving'}
                </span>
              }
              tone={fresh ? undefined : 'warn'}
              note={
                realtime
                  ? 'Every second, from the router'
                  : rtProblem
                    ? `Real time unavailable (${rtProblem.name}: ${rtProblem.error}); showing flow records, every 5 s`
                    : fresh
                      ? staff
                        ? 'Every 5 s from flow records. For every second, set a real-time interface on the router below'
                        : 'Updates every 5 seconds'
                      : staff
                        ? 'Check Flow sources below'
                        : 'The datacenter has not turned on flow export yet'
              }
            />
          </dl>
        ) : (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            <Stat label="Download, average" value={t ? bps(t.inBps) : '—'} note={t ? `${volume(t.inBytes)} to your addresses` : undefined} />
            <Stat label="Upload, average" value={t ? bps(t.outBps) : '—'} note={t ? `${volume(t.outBytes)} from your addresses` : undefined} />
            <Stat label="Addresses with traffic" value={t?.addresses ?? '—'} />
            <Stat
              label="Newest flow data"
              value={<span className="text-[18px]">{top.data?.latestDataAt ? relativeTime(top.data.latestDataAt) : 'None yet'}</span>}
              tone={top.data && !top.data.latestDataAt ? 'warn' : undefined}
              note={top.data?.latestDataAt ? 'Saved every minute' : staff ? 'Set up a router below' : 'Bandwidth per IP appears once the datacenter turns on flow export'}
            />
          </dl>
        )}
      </Panel>
      {selected && (
        <IpHistory key={selected.ip} ip={selected} range={isLive ? { period: '1h', from: '', to: '' } : range} samples={isLive ? (samples.get(selected.ip) ?? []) : undefined} realtime={isLive && realtime} onClose={() => setOpen(null)} />
      )}
      <Panel
        flush
        title={staff ? 'Top IP addresses by bandwidth' : 'Your IP addresses by bandwidth'}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex rounded-lg border border-rule bg-panel p-0.5 text-[13px]" role="group" aria-label="Live or period">
              {(
                [
                  ['live', 'Live'],
                  ['period', 'Period'],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={mode === k}
                  onClick={() => setMode(k)}
                  className={mode === k ? 'flex items-center gap-1.5 rounded-md bg-field px-2.5 py-1 font-medium' : 'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-ink-3 hover:text-ink'}
                >
                  {k === 'live' && <span className={cx('size-1.5 rounded-full', mode === 'live' && fresh ? 'animate-pulse bg-ok' : 'bg-ink-3')} aria-hidden />}
                  {l}
                </button>
              ))}
            </span>
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
            {!isLive && <PeriodPicker value={range} onChange={setRange} options={FLOW_RANGES} labels={FLOW_RANGE_LABELS} className="w-40" />}
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
        <ErrorNote error={busy.error} className="m-4" />
        {busy.isLoading && <Loading />}
        {busy.data && items.length === 0 && (
          <EmptyState title={debounced || customerId ? 'No matching addresses' : isLive ? 'No traffic in the last minute' : 'No traffic recorded for this period'}>
            {staff
              ? 'Bandwidth per IP comes from your routers’ flow records. Check Flow sources below (the router must be registered and receiving); addresses must be inside a prefix in IP Address Management.'
              : isLive
                ? 'No flows to or from your addresses in the last minute.'
                : 'No flows to or from your addresses in this period.'}
          </EmptyState>
        )}
        {items.length > 0 && (
          <Table label="Top IP addresses">
            <thead>
              <tr>
                <th className="w-10">#</th>
                <th>Address</th>
                <th>{staff ? 'Customer · device' : 'Device'}</th>
                <th>Top remote address · ASN · location</th>
                <th className="text-right">Download{isLive ? ' now' : ''}</th>
                <th className="text-right">Upload{isLive ? ' now' : ''}</th>
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
                  <td>
                    <PeerCell peer={x.topPeer} />
                  </td>
                  <td className="w-44 text-right">
                    <span className={cx('tabular-nums', sort === 'download' && 'font-semibold')}>{bps(x.inBps)}</span>
                    {!isLive && <span className="block text-[12px] text-ink-3 tabular-nums">{volume(x.inBytes ?? 0)}</span>}
                    <Bar value={isLive ? x.inBps : (x.inBytes ?? 0)} max={max} tone="rx" />
                  </td>
                  <td className="w-44 text-right">
                    <span className={cx('tabular-nums', sort === 'upload' && 'font-semibold')}>{bps(x.outBps)}</span>
                    {!isLive && <span className="block text-[12px] text-ink-3 tabular-nums">{volume(x.outBytes ?? 0)}</span>}
                    <Bar value={isLive ? x.outBps : (x.outBytes ?? 0)} max={max} tone="tx" />
                  </td>
                  <td className={cx('text-right tabular-nums', sort === 'total' && 'font-semibold')}>
                    {bps(x.inBps + x.outBps)}
                    {!isLive && <span className="block text-[12px] font-normal text-ink-3">{volume((x.inBytes ?? 0) + (x.outBytes ?? 0))}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {items.length > 0 && (
          <p className="px-4 py-2.5 text-[12px] text-ink-3">
            {isLive
              ? realtime
                ? "Real time: each address's rate this second, read from the router (MikroTik Torch) while this page is open. "
                : `Live: each address's rate over the last minute of flow records, refreshed every 5 seconds (updated ${at ? relativeTime(at) : '—'}). Routers report traffic about once a minute, so a change shows within a minute. `
              : `${top.data && top.data.range.coveredFrom > top.data.range.from ? `Flow data in this period starts ${relativeTime(top.data.range.coveredFrom)}; averages cover only that part. ` : ''}Averages over the period. `}
            Measured from the routers' flow records (NetFlow/IPFIX). Download is traffic to the address, upload traffic from it. Top remote address: the one it exchanged most traffic with
            {isLive ? ' (live)' : ' (hourly totals)'}. Click an address for its chart and all remote addresses. <GeoAttribution geo={isLive ? live.data?.geo : top.data?.geo} />
          </p>
        )}
      </Panel>
      {staff && !fixedCustomer && <FlowSources />}
    </div>
  );
}
