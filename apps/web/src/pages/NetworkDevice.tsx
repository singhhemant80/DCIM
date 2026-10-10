import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_KIND_LABELS,
  INTERFACE_KINDS,
  INTERFACE_KIND_LABELS,
  INTERFACE_MEDIA,
  INTERFACE_MEDIA_LABELS,
  LOGICAL_KINDS,
  PLATFORMS,
  PLATFORM_LABELS,
  SNMP_AUTH_PROTOCOLS,
  SNMP_PRIV_PROTOCOLS,
  VLAN_MODES,
  VLAN_MODE_LABELS,
  type CredentialKind,
  type InterfaceKind,
} from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { deviceLabel, formatBps, formatUptime, useVlans, type BgpT, type CredentialT, type DeviceSummaryT, type FactsT, type InterfaceT, type NetworkDeviceT, type RunT } from '../lib/network';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table, cx } from '../components/ui';
import { CableFields, Kv, Tabs } from './Network';
import { bps, useMonitoringStream, withLive, type PortRateT } from '../lib/monitoring';
import type { Paginated } from '../lib/api';

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const t = (v: string) => (v.trim() === '' ? null : v.trim());

export function NetworkDevicePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAuth();
  const summary = useQuery({ queryKey: ['network', 'device', id], queryFn: () => api.get<DeviceSummaryT>(`/network/devices/${id}`) });
  const ifaces = useQuery({ queryKey: ['network', 'interfaces', id], queryFn: () => api.get<InterfaceT[]>(`/network/devices/${id}/interfaces`) });
  const [details, setDetails] = useState(false);
  if (summary.isLoading) return <Loading />;
  if (summary.error) return <ErrorNote error={summary.error} />;
  const { device: d, lastCollected } = summary.data!;
  return (
    <>
      <nav className="mb-2 text-[13px] text-ink-3">
        <Link to="/network" className="hover:underline">
          Network infrastructure
        </Link>{' '}
        / {deviceLabel(d)}
      </nav>
      <PageHeader
        title={deviceLabel(d)}
        description={
          <>
            {d.manufacturerName} {d.modelName} · {d.platform ? PLATFORM_LABELS[d.platform] : 'platform not set'}
            {d.networkRole ? ` · ${d.networkRole}` : ''} · {d.datacenterCode ? `${d.datacenterCode} ${d.rackName}${d.positionU ? ` U${d.positionU}` : ''}` : 'not racked'}
          </>
        }
        actions={
          <>
            <Link to={`/hardware/${d.id}`}>
              <Button>Hardware record</Button>
            </Link>
            {can('network.write') && <Button onClick={() => setDetails(true)}>Platform & role</Button>}
          </>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <dl className="glass grid grid-cols-2 gap-4 rounded-2xl p-4 sm:grid-cols-4 lg:grid-cols-6">
          <Kv k="Management address">{d.mgmtAddress ? <span className="font-mono">{d.mgmtAddress}</span> : <span className="text-ink-3" title="Set it on the hardware record">Not set</span>}</Kv>
          <Kv k="Asset tag">
            <span className="font-mono">{d.assetTag}</span>
          </Kv>
          <Kv k="Ports">{d.interfaceCount}</Kv>
          <Kv k="Cabled physical ports">
            {d.cabledCount} of {d.physicalCount}
          </Kv>
          <Kv k="OS (recorded)">{d.os ?? '—'}</Kv>
          <Kv k="Lifecycle">{d.lifecycleState}</Kv>
        </dl>
        {lastCollected && <Collected c={lastCollected} />}
        <PortsPanel device={d} list={ifaces} />
        <div className="grid gap-5 xl:grid-cols-2">
          <CredentialsPanel device={d} creds={summary.data!.credentials} />
          <RunsPanel device={d} runs={summary.data!.runs} creds={summary.data!.credentials} />
        </div>
      </div>
      {details && <DetailsForm device={d} onClose={() => setDetails(false)} />}
    </>
  );
}

function Collected({ c }: { c: NonNullable<DeviceSummaryT['lastCollected']> }) {
  const f: FactsT = c.facts ?? {};
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Collected from the device <Chip tone="est" title="Read during the last discovery; not live data">snapshot {relativeTime(c.at)}</Chip>
        </span>
      }
    >
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Kv k="System name">{f.sysName ?? '—'}</Kv>
        <Kv k="Vendor / model">{[f.vendor, f.model].filter(Boolean).join(' ') || '—'}</Kv>
        <Kv k="Serial">{f.serial ? <span className="font-mono">{f.serial}</span> : '—'}</Kv>
        <Kv k="OS version">{f.osVersion ?? '—'}</Kv>
        <Kv k="Uptime at collection">{formatUptime(f.uptimeSeconds)}</Kv>
        <Kv k="Source">{CREDENTIAL_KIND_LABELS[c.source]}</Kv>
      </dl>
      {c.bgp.length > 0 && <BgpTable bgp={c.bgp} />}
      {c.warnings.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-[12.5px] text-warn">
          {c.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function BgpTable({ bgp }: { bgp: BgpT[] }) {
  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-rule">
      <Table label="BGP sessions">
        <thead>
          <tr>
            <th>BGP peer</th>
            <th>Remote AS</th>
            <th>State</th>
            <th>VRF</th>
            <th className="text-right">Prefixes received</th>
            <th>Up for</th>
          </tr>
        </thead>
        <tbody>
          {bgp.map((b) => (
            <tr key={`${b.vrf}-${b.peer}`}>
              <td className="font-mono text-[12.5px]">{b.peer}</td>
              <td className="tabular-nums">{b.remoteAs ? `AS${b.remoteAs}` : '—'}</td>
              <td>
                <Chip tone={b.state === 'established' ? 'ok' : 'crit'}>{b.state}</Chip>
              </td>
              <td>{b.vrf ?? '—'}</td>
              <td className="text-right tabular-nums">{b.prefixesReceived ?? '—'}</td>
              <td>{b.state === 'established' ? formatUptime(b.uptimeSeconds) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function DetailsForm({ device, onClose }: { device: NetworkDeviceT; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ platform: s(device.platform), networkRole: s(device.networkRole) });
  const m = useMutation({
    mutationFn: () => api.patch(`/network/devices/${device.id}`, { platform: t(f.platform), networkRole: t(f.networkRole) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['network'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Platform and role">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Platform" hint="Used to suggest which access method to configure">
          {(id, dd) => (
            <Select id={id} aria-describedby={dd} value={f.platform} onChange={(e) => setF((x) => ({ ...x, platform: e.target.value }))}>
              <option value="">Not set</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Network role" hint="e.g. edge, core, leaf, spine, ToR, firewall">
          {(id, dd) => <Input id={id} aria-describedby={dd} value={f.networkRole} onChange={(e) => setF((x) => ({ ...x, networkRole: e.target.value }))} />}
        </Field>
        <ErrorNote error={m.error} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ ports */

function PortsPanel({ device, list }: { device: NetworkDeviceT; list: ReturnType<typeof useQuery<InterfaceT[]>> }) {
  const { can } = useAuth();
  const [tab, setTab] = useState<'physical' | 'logical'>('physical');
  const [edit, setEdit] = useState<InterfaceT | 'new' | null>(null);
  const [bulk, setBulk] = useState(false);
  const [cable, setCable] = useState<InterfaceT | null>(null);
  const rows = (list.data ?? []).filter((i) => (tab === 'logical' ? LOGICAL_KINDS.includes(i.kind) : !LOGICAL_KINDS.includes(i.kind)));
  const counts = { physical: (list.data ?? []).filter((i) => !LOGICAL_KINDS.includes(i.kind)).length, logical: (list.data ?? []).filter((i) => LOGICAL_KINDS.includes(i.kind)).length };
  // Live traffic, when this device is polled (measured; nothing is shown without a recent reading).
  const canMon = can('monitoring.read');
  const rates = useQuery({ queryKey: ['monitoring', 'ports', 'device', device.id], queryFn: () => api.get<Paginated<PortRateT>>(`/monitoring/ports?deviceId=${device.id}&pageSize=200&sort=name`), enabled: canMon, refetchInterval: 30_000 });
  const polled = !!rates.data?.items.length;
  const stream = useMonitoringStream(canMon && polled);
  const rateOf = useMemo(() => new Map((rates.data?.items ?? []).map((r) => [r.interfaceId, withLive(r, stream.live)])), [rates.data, stream.live]);
  return (
    <Panel
      flush
      title="Ports and interfaces"
      actions={
        can('network.write') && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setBulk(true)}>
              Add range
            </Button>
            <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
              Add interface
            </Button>
          </div>
        )
      }
    >
      <div className="px-4 pt-3">
        <Tabs
          label="Interface types"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'physical', label: `Physical ports (${counts.physical})` },
            { key: 'logical', label: `Logical interfaces (${counts.logical})` },
          ]}
        />
      </div>
      {list.isLoading && <Loading />}
      <ErrorNote error={list.error} className="m-4" />
      {list.data && rows.length === 0 && (
        <EmptyState title={tab === 'physical' ? 'No ports documented' : 'No logical interfaces'}>
          {tab === 'physical' ? 'Add a range such as ether[1-24] or Ethernet1/[1-48], or run a discovery to import them.' : 'LAGs, VLAN interfaces, bridges, tunnels and loopbacks appear here.'}
        </EmptyState>
      )}
      {rows.length > 0 && (
        <Table label={tab === 'physical' ? 'Physical ports' : 'Logical interfaces'}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Speed</th>
              {polled && <th>Traffic</th>}
              <th>VLANs</th>
              <th>{tab === 'physical' ? 'Connected to' : 'Members / parent'}</th>
              <th>Neighbor (LLDP/CDP)</th>
              <th>IP addresses</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <PortRow key={i.id} i={i} rate={polled ? (rateOf.get(i.id) ?? null) : undefined} canEdit={can('network.write')} onEdit={() => setEdit(i)} onCable={() => setCable(i)} />
            ))}
          </tbody>
        </Table>
      )}
      {edit && <InterfaceForm device={device} iface={edit === 'new' ? undefined : edit} all={list.data ?? []} onClose={() => setEdit(null)} />}
      {bulk && <BulkForm device={device} onClose={() => setBulk(false)} />}
      {cable && <CableConnect from={cable} onClose={() => setCable(null)} />}
    </Panel>
  );
}

function PortRow({ i, rate, canEdit, onEdit, onCable }: { i: InterfaceT; rate?: PortRateT | null; canEdit: boolean; onEdit: () => void; onCable: () => void }) {
  const nbr = i.neighbors[0];
  const verified = nbr?.matched && i.cable?.peer && nbr.matched.interfaceId === i.cable.peer.interfaceId;
  const mismatch = nbr?.matched && i.cable?.peer && nbr.matched.interfaceId !== i.cable.peer.interfaceId;
  const cableable = !LOGICAL_KINDS.includes(i.kind);
  return (
    <tr className={cx(!i.enabled && 'opacity-60')}>
      <td className="whitespace-nowrap">
        <span className="font-mono text-[13px] font-medium">{i.name}</span>
        {!i.enabled && (
          <Chip tone="neutral" title="Administratively disabled (as documented or discovered)">
            disabled
          </Chip>
        )}
        {i.description && <div className="max-w-[24ch] truncate text-[12.5px] text-ink-3">{i.description}</div>}
      </td>
      <td className="text-[13px]">
        {INTERFACE_KIND_LABELS[i.kind]}
        {i.media && <div className="text-[12px] text-ink-3">{INTERFACE_MEDIA_LABELS[i.media as keyof typeof INTERFACE_MEDIA_LABELS]}</div>}
      </td>
      <td className="whitespace-nowrap">{formatBps(i.speedBps)}</td>
      {rate !== undefined && (
        <td className="text-[12.5px] whitespace-nowrap tabular-nums">
          {rate?.fresh ? (
            <Link to={`/network-monitoring?port=${i.id}`} className="block leading-tight hover:underline" title="Measured; open the traffic chart">
              <span className="block">
                <span className="text-rx">in</span> {bps(rate.inBps)}
              </span>
              <span className="block">
                <span className="text-tx">out</span> {bps(rate.outBps)}
              </span>
            </Link>
          ) : (
            <span className="text-ink-3">{rate ? 'no recent reading' : 'not monitored'}</span>
          )}
        </td>
      )}
      <td className="text-[13px]">
        {i.mode === 'access' && i.untaggedVlan && <Chip>{i.untaggedVlan.vid} untagged</Chip>}
        {i.mode === 'tagged_all' && <Chip>all tagged</Chip>}
        {i.mode === 'tagged' && (
          <span title={i.taggedVlans.map((v) => `${v.vid} ${v.name}`).join(', ')}>
            {i.untaggedVlan && <Chip>{i.untaggedVlan.vid} native</Chip>} {i.taggedVlans.length} tagged
          </span>
        )}
        {!i.mode && <span className="text-ink-3">—</span>}
      </td>
      <td className="text-[13px]">
        {i.cable?.peer && (
          <Link className="text-accent hover:underline" to={`/network/devices/${i.cable.peer.deviceId}`}>
            {i.cable.peer.deviceName} <span className="font-mono">{i.cable.peer.interfaceName}</span>
          </Link>
        )}
        {i.cable && i.cable.status !== 'connected' && <Chip tone="est">{i.cable.status}</Chip>}
        {i.circuit && (
          <div>
            <Chip tone="accent">
              {i.circuit.provider} {i.circuit.cid}
            </Chip>
          </div>
        )}
        {i.lag && <div className="text-ink-3">member of {i.lag.name}</div>}
        {i.members.length > 0 && <div>{i.members.map((m) => m.name).join(', ')}</div>}
        {i.parent && <div className="text-ink-3">on {i.parent.name}</div>}
        {!i.cable && !i.circuit && !i.lag && !i.members.length && !i.parent && <span className="text-ink-3">—</span>}
      </td>
      <td className="text-[13px]">
        {nbr ? (
          <div>
            {nbr.remoteSystemName ?? nbr.remoteChassisId} <span className="font-mono">{nbr.remotePortId}</span>
            <div>
              {verified && <Chip tone="ok">matches cable</Chip>}
              {mismatch && <Chip tone="crit">differs from cable</Chip>}
              {!i.cable && nbr.matched && <Chip tone="warn">no cable documented</Chip>}
              {!nbr.matched && <Chip tone="neutral">not in inventory</Chip>}
              <span className="ml-1 text-[11.5px] text-ink-3">{nbr.protocol.toUpperCase()}, {relativeTime(nbr.lastSeenAt)}</span>
            </div>
          </div>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </td>
      <td className="font-mono text-[12.5px]">
        {i.ipAddresses.length
          ? i.ipAddresses.map((a) => (
              <div key={a.id}>
                {a.address}
                {a.prefixLength !== null ? `/${a.prefixLength}` : ''}
              </div>
            ))
          : <span className="font-sans text-ink-3">—</span>}
      </td>
      <td className="text-right whitespace-nowrap">
        {canEdit && cableable && !i.cable && (
          <Button size="sm" variant="ghost" onClick={onCable}>
            Connect
          </Button>
        )}
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
        )}
      </td>
    </tr>
  );
}

function InterfaceForm({ device, iface, all, onClose }: { device: NetworkDeviceT; iface?: InterfaceT; all: InterfaceT[]; onClose: () => void }) {
  const qc = useQueryClient();
  const vlans = useVlans();
  const [f, setF] = useState({
    name: s(iface?.name),
    kind: (iface?.kind ?? 'physical') as InterfaceKind,
    media: s(iface?.media),
    description: s(iface?.description),
    macAddress: s(iface?.macAddress),
    mtu: s(iface?.mtu),
    speedMbps: iface?.speedBps ? String(iface.speedBps / 1e6) : '',
    enabled: iface?.enabled ?? true,
    lagId: s(iface?.lag?.id),
    parentId: s(iface?.parent?.id),
    mode: s(iface?.mode),
    untaggedVlanId: s(iface?.untaggedVlan?.id),
    taggedVlanIds: iface?.taggedVlans.map((v) => v.id) ?? [],
    monitored: iface?.monitored ?? true,
    countInTotals: iface?.countInTotals ?? false,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const [confirm, setConfirm] = useState(false);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['network'] });
    onClose();
  };
  const body = () => ({
    deviceId: device.id,
    name: f.name,
    kind: f.kind,
    media: t(f.media),
    description: t(f.description),
    macAddress: t(f.macAddress),
    mtu: f.mtu ? Number(f.mtu) : null,
    speedBps: f.speedMbps ? Math.round(Number(f.speedMbps) * 1e6) : null,
    enabled: f.enabled,
    lagId: t(f.lagId),
    parentId: t(f.parentId),
    mode: t(f.mode),
    untaggedVlanId: f.mode === 'access' || f.mode === 'tagged' || f.mode === 'tagged_all' ? t(f.untaggedVlanId) : null,
    taggedVlanIds: f.mode === 'tagged' ? f.taggedVlanIds : [],
    monitored: f.monitored,
    countInTotals: f.countInTotals,
  });
  const save = useMutation({ mutationFn: () => (iface ? api.put(`/network/interfaces/${iface.id}`, body()) : api.post('/network/interfaces', body())), onSuccess: done });
  const del = useMutation({ mutationFn: () => api.delete(`/network/interfaces/${iface!.id}`), onSuccess: done });
  const lags = all.filter((x) => x.kind === 'lag' && x.id !== iface?.id);
  const parents = all.filter((x) => x.id !== iface?.id && x.kind !== 'vlan');
  const isPort = !LOGICAL_KINDS.includes(f.kind);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={iface ? `Edit ${iface.name}` : 'Add interface'} wide>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} className="font-mono" placeholder="ether1, Ethernet1/1, port1" />}</Field>
        <Field label="Type">
          {(id) => (
            <Select id={id} value={f.kind} onChange={set('kind')} disabled={!!iface?.cable}>
              {INTERFACE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {INTERFACE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {isPort && (
          <Field label="Media">
            {(id) => (
              <Select id={id} value={f.media} onChange={set('media')}>
                <option value="">Not specified</option>
                {INTERFACE_MEDIA.map((m) => (
                  <option key={m} value={m}>
                    {INTERFACE_MEDIA_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Speed (Mbit/s)" hint="Nominal; needed later for utilization">
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} step="any" value={f.speedMbps} onChange={set('speedMbps')} />}
        </Field>
        <Field label="Description">{(id) => <Input id={id} value={f.description} onChange={set('description')} />}</Field>
        <Field label="MAC address">{(id) => <Input id={id} value={f.macAddress} onChange={set('macAddress')} className="font-mono" />}</Field>
        <Field label="MTU">{(id) => <Input id={id} type="number" min={64} max={65535} value={f.mtu} onChange={set('mtu')} />}</Field>
        {isPort && lags.length > 0 && (
          <Field label="LAG membership">
            {(id) => (
              <Select id={id} value={f.lagId} onChange={set('lagId')}>
                <option value="">Not in a LAG</option>
                {lags.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {(f.kind === 'vlan' || f.kind === 'virtual' || f.kind === 'tunnel') && (
          <Field label="Parent interface">
            {(id) => (
              <Select id={id} value={f.parentId} onChange={set('parentId')}>
                <option value="">None</option>
                {parents.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {f.kind !== 'loopback' && f.kind !== 'tunnel' && (
          <Field label="VLAN mode">
            {(id) => (
              <Select id={id} value={f.mode} onChange={set('mode')}>
                <option value="">None / routed</option>
                {VLAN_MODES.map((m) => (
                  <option key={m} value={m}>
                    {VLAN_MODE_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {f.mode && (
          <Field label={f.mode === 'access' ? 'VLAN' : 'Native (untagged) VLAN'}>
            {(id) => (
              <Select id={id} required={f.mode === 'access'} value={f.untaggedVlanId} onChange={set('untaggedVlanId')}>
                <option value="">{f.mode === 'access' ? 'Choose' : 'None'}</option>
                {vlans.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.vid} {v.name}
                    {v.datacenterCode ? ` (${v.datacenterCode})` : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {f.mode === 'tagged' && (
          <fieldset className="sm:col-span-2">
            <legend className="mb-1 text-[13px] font-medium text-ink-2">Tagged VLANs</legend>
            <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-y-auto rounded-lg border border-rule p-2">
              {vlans.data?.length === 0 && <span className="text-ink-3">No VLANs defined yet.</span>}
              {vlans.data?.map((v) => (
                <label key={v.id} className="flex items-center gap-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    checked={f.taggedVlanIds.includes(v.id)}
                    disabled={v.id === f.untaggedVlanId}
                    onChange={(e) => setF((x) => ({ ...x, taggedVlanIds: e.target.checked ? [...x.taggedVlanIds, v.id] : x.taggedVlanIds.filter((y) => y !== v.id) }))}
                  />
                  {v.vid} {v.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-2 sm:col-span-2">
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={f.enabled} onChange={(e) => setF((x) => ({ ...x, enabled: e.target.checked }))} /> Enabled
          </label>
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={f.monitored} onChange={(e) => setF((x) => ({ ...x, monitored: e.target.checked }))} /> Monitor traffic (Phase 4)
          </label>
          <label className="flex items-center gap-2 text-[13.5px]" title="Avoids double counting: count only uplinks/transit ports, not every hop">
            <input type="checkbox" checked={f.countInTotals} onChange={(e) => setF((x) => ({ ...x, countInTotals: e.target.checked }))} /> Count in device / datacenter totals
          </label>
        </div>
        <ErrorNote error={save.error} className="sm:col-span-2" />
        <div className="flex justify-between gap-2 sm:col-span-2">
          <div>
            {iface && (
              <Button type="button" variant="ghost" className="text-crit" onClick={() => setConfirm(true)}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={save.isPending}>
              Save
            </Button>
          </div>
        </div>
      </form>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${iface?.name}?`}
        body="Refused while a cable is connected or IP addresses are bound to it; remove those first."
        confirmLabel="Delete interface"
        onConfirm={() => del.mutate()}
        busy={del.isPending}
        error={del.error}
      />
    </Modal>
  );
}

function BulkForm({ device, onClose }: { device: NetworkDeviceT; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ pattern: '', kind: 'physical', media: '', speedMbps: '' });
  const m = useMutation({
    mutationFn: () => api.post<{ created: number; skipped: number }>('/network/interfaces/bulk', { deviceId: device.id, pattern: f.pattern, kind: f.kind, media: t(f.media), speedBps: f.speedMbps ? Math.round(Number(f.speedMbps) * 1e6) : null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network'] }),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Add a range of ports">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Pattern" hint="ether[1-24], sfp-sfpplus[1-12], Ethernet1/[1-48], port[1-8]. Existing names are skipped.">
          {(id, d) => <Input id={id} aria-describedby={d} required value={f.pattern} onChange={(e) => setF((x) => ({ ...x, pattern: e.target.value }))} className="font-mono" />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Type">
            {(id) => (
              <Select id={id} value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value }))}>
                <option value="physical">Physical</option>
                <option value="management">Management</option>
              </Select>
            )}
          </Field>
          <Field label="Media">
            {(id) => (
              <Select id={id} value={f.media} onChange={(e) => setF((x) => ({ ...x, media: e.target.value }))}>
                <option value="">—</option>
                {INTERFACE_MEDIA.map((x) => (
                  <option key={x} value={x}>
                    {INTERFACE_MEDIA_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Speed (Mbit/s)">{(id) => <Input id={id} type="number" min={0} value={f.speedMbps} onChange={(e) => setF((x) => ({ ...x, speedMbps: e.target.value }))} />}</Field>
        </div>
        <ErrorNote error={m.error} />
        {m.data && (
          <p className="rounded-lg bg-ok-soft px-3 py-2 text-ok">
            Created {m.data.created}
            {m.data.skipped ? `, skipped ${m.data.skipped} that already existed` : ''}.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {m.data ? 'Close' : 'Cancel'}
          </Button>
          <Button variant="primary" busy={m.isPending}>
            Create ports
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function CableConnect({ from, onClose }: { from: InterfaceT; onClose: () => void }) {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ['network', 'devices', 'all'], queryFn: () => api.get<NetworkDeviceT[]>('/network/devices?all=true') });
  const [deviceId, setDeviceId] = useState('');
  const ports = useQuery({ queryKey: ['network', 'interfaces', deviceId], queryFn: () => api.get<InterfaceT[]>(`/network/devices/${deviceId}/interfaces`), enabled: !!deviceId });
  const [to, setTo] = useState('');
  const [f, setF] = useState({ type: '', status: 'connected', label: '', color: '', lengthM: '', notes: '' });
  const free = (ports.data ?? []).filter((p) => !LOGICAL_KINDS.includes(p.kind) && !p.cable && p.id !== from.id);
  const m = useMutation({
    mutationFn: () => api.post('/network/cables', { aInterfaceId: from.id, bInterfaceId: to, type: t(f.type), status: f.status, label: t(f.label), color: t(f.color), lengthM: f.lengthM ? Number(f.lengthM) : null, notes: t(f.notes) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['network'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Connect a cable to ${from.deviceName} ${from.name}`} wide>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Other device">
          {(id) => (
            <Select id={id} required value={deviceId} onChange={(e) => (setDeviceId(e.target.value), setTo(''))}>
              <option value="">Choose a device</option>
              {devices.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {deviceLabel(d)} {d.datacenterCode ? `(${d.datacenterCode} ${d.rackName ?? ''})` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Port" hint={deviceId && ports.data && !free.length ? 'No free physical ports on that device; add ports to it first' : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} required value={to} onChange={(e) => setTo(e.target.value)} disabled={!deviceId}>
              <option value="">Choose a free port</option>
              {free.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <CableFields f={f} setF={setF} />
        <ErrorNote error={m.error} className="sm:col-span-2" />
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending}>
            Connect
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ credentials */

const SUGGESTED: Record<string, CredentialKind[]> = { routeros: ['routeros_rest', 'routeros_api', 'snmp_v3', 'snmp_v2c'], nxos: ['nxapi', 'snmp_v3', 'snmp_v2c'], fortios: ['fortios_rest', 'snmp_v3', 'snmp_v2c'] };

function CredentialsPanel({ device, creds }: { device: NetworkDeviceT; creds: CredentialT[] }) {
  const { can } = useAuth();
  const [edit, setEdit] = useState<CredentialKind | null>(null);
  const [del, setDel] = useState<CredentialKind | null>(null);
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (k: CredentialKind) => api.delete(`/network/devices/${device.id}/credentials/${k}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['network'] });
      setDel(null);
    },
  });
  const order = device.platform && SUGGESTED[device.platform] ? SUGGESTED[device.platform]! : (['snmp_v3', 'snmp_v2c', 'routeros_rest', 'routeros_api', 'fortios_rest', 'nxapi'] as CredentialKind[]);
  const missing = order.filter((k) => !creds.some((c) => c.kind === k));
  return (
    <Panel title="Read-only access">
      <p className="mb-3 text-[13px] text-ink-2">
        Credentials are encrypted at rest and never shown again after saving. Only the discovery worker uses them, and only for read operations. Use a read-only account or community on the device.
      </p>
      {creds.length === 0 && <p className="mb-3 text-ink-3">No access configured.</p>}
      <ul className="divide-y divide-rule">
        {creds.map((c) => (
          <li key={c.kind} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <div className="min-w-0">
              <p className="font-medium">{CREDENTIAL_KIND_LABELS[c.kind]}</p>
              <p className="text-[12.5px] text-ink-3">
                {c.host ?? device.mgmtAddress ?? 'no address'}
                {c.port ? `:${c.port}` : ''}
                {c.username ? ` · user ${c.username}` : ''} · secret set {relativeTime(c.rotatedAt)}
              </p>
              {c.lastTestAt && (
                <p className={cx('text-[12.5px]', c.lastTestOk ? 'text-ok' : 'text-crit')}>
                  {c.lastTestOk ? 'OK' : 'Failed'} {relativeTime(c.lastTestAt)}: {c.lastTestMessage}
                </p>
              )}
              <ScheduleControl device={device} cred={c} />
            </div>
            {can('monitoring.configure') && (
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEdit(c.kind)}>
                  Replace
                </Button>
                <Button size="sm" variant="ghost" className="text-crit" onClick={() => setDel(c.kind)}>
                  Remove
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {can('monitoring.configure') && missing.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {missing.map((k) => (
            <Button key={k} size="sm" onClick={() => setEdit(k)}>
              Add {CREDENTIAL_KIND_LABELS[k]}
            </Button>
          ))}
        </div>
      )}
      {edit && <CredentialForm device={device} kind={edit} existing={creds.find((c) => c.kind === edit)} onClose={() => setEdit(null)} />}
      <ConfirmDialog
        open={!!del}
        onOpenChange={(o) => !o && setDel(null)}
        title={`Remove ${del ? CREDENTIAL_KIND_LABELS[del] : ''} access?`}
        body="The encrypted secret is deleted. Discovery with this method stops working until it is added again."
        confirmLabel="Remove"
        onConfirm={() => del && remove.mutate(del)}
        busy={remove.isPending}
        error={remove.error}
      />
    </Panel>
  );
}

const SCHEDULES = [
  { hours: 0, label: 'Off (only when started by hand)' },
  { hours: 1, label: 'Every hour' },
  { hours: 6, label: 'Every 6 hours' },
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Daily' },
  { hours: 168, label: 'Weekly' },
];

/** Automatic discovery for one access method. Runs produce previews; nothing is applied automatically. */
function ScheduleControl({ device, cred }: { device: NetworkDeviceT; cred: CredentialT }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (hours: number) => api.put(`/network/devices/${device.id}/credentials/${cred.kind}/schedule`, { hours: hours || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network'] }),
  });
  const current = cred.scheduleHours ?? 0;
  const known = SCHEDULES.some((x) => x.hours === current);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
      <span>Automatic discovery:</span>
      {can('network.write') ? (
        <Select aria-label={`Automatic discovery with ${CREDENTIAL_KIND_LABELS[cred.kind]}`} className="h-7 w-52 text-[12.5px]" value={current} disabled={m.isPending} onChange={(e) => m.mutate(Number(e.target.value))}>
          {!known && <option value={current}>Every {current} hours</option>}
          {SCHEDULES.map((x) => (
            <option key={x.hours} value={x.hours}>
              {x.label}
            </option>
          ))}
        </Select>
      ) : (
        <span>{current ? `every ${current} h` : 'off'}</span>
      )}
      {cred.scheduleHours && cred.nextRunAt ? <span className="text-ink-3">next {formatDateTime(cred.nextRunAt)}</span> : null}
      {m.error ? <span className="text-crit">{(m.error as Error).message}</span> : null}
    </div>
  );
}

function CredentialForm({ device, kind, existing, onClose }: { device: NetworkDeviceT; kind: CredentialKind; existing?: CredentialT; onClose: () => void }) {
  const qc = useQueryClient();
  const p = (existing?.params ?? {}) as Record<string, string | number | boolean | null>;
  const [f, setF] = useState({
    host: s(existing?.host),
    port: s(existing?.port),
    username: s(existing?.username),
    community: '',
    authKey: '',
    privKey: '',
    password: '',
    token: '',
    securityLevel: s(p.securityLevel) || 'authPriv',
    authProtocol: s(p.authProtocol) || 'sha',
    privProtocol: s(p.privProtocol) || 'aes',
    scheme: s(p.scheme) || 'https',
    verifyTls: p.verifyTls === undefined ? true : !!p.verifyTls,
    vdom: s(p.vdom),
    timeoutMs: s(p.timeoutMs),
    tls: p.tls === undefined ? true : !!p.tls,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const snmp = kind === 'snmp_v2c' || kind === 'snmp_v3';
  const m = useMutation({
    mutationFn: () => {
      const base: Record<string, unknown> = { kind, host: t(f.host), port: f.port ? Number(f.port) : null };
      if (f.timeoutMs) base.timeoutMs = Number(f.timeoutMs);
      if (kind === 'snmp_v2c') Object.assign(base, { community: f.community });
      if (kind === 'snmp_v3') Object.assign(base, { username: f.username, securityLevel: f.securityLevel, authProtocol: f.authProtocol, privProtocol: f.privProtocol, authKey: t(f.authKey), privKey: t(f.privKey) });
      if (kind === 'routeros_rest' || kind === 'nxapi') Object.assign(base, { username: f.username, password: f.password, scheme: f.scheme, verifyTls: f.verifyTls });
      if (kind === 'fortios_rest') Object.assign(base, { token: f.token, scheme: f.scheme, verifyTls: f.verifyTls, vdom: t(f.vdom) });
      if (kind === 'routeros_api') Object.assign(base, { username: f.username, password: f.password, tls: f.tls, verifyTls: f.verifyTls });
      return api.put(`/network/devices/${device.id}/credentials`, base);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['network'] });
      onClose();
    },
  });
  const secret = (label: string, k: 'community' | 'authKey' | 'privKey' | 'password' | 'token', required = true, hint?: string) => (
    <Field label={label} hint={hint ?? (existing ? 'Enter it again to replace the stored secret' : undefined)}>
      {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" required={required} value={f[k]} onChange={set(k)} />}
    </Field>
  );
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`${existing ? 'Replace' : 'Add'} ${CREDENTIAL_KIND_LABELS[kind]}`} description={`Read-only access for ${deviceLabel(device)}. The secret is encrypted and cannot be viewed later.`} wide>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Host" hint={device.mgmtAddress ? `Empty: ${device.mgmtAddress}. The host is saved with the secret; later changes to the management address don't redirect it.` : 'The device has no management address; enter one here'}>
          {(id, d) => <Input id={id} aria-describedby={d} required={!device.mgmtAddress} value={f.host} onChange={set('host')} className="font-mono" />}
        </Field>
        <Field label="Port" hint={snmp ? 'Default 161/udp' : kind === 'routeros_api' ? (f.tls ? 'Default 8729 (api-ssl); use the port in IP → Services' : 'Default 8728 (api); use the port in IP → Services') : f.scheme === 'https' ? 'Default 443' : 'Default 80'}>
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={65535} value={f.port} onChange={set('port')} />}
        </Field>
        {kind === 'snmp_v2c' && secret('Community', 'community')}
        {kind === 'snmp_v3' && (
          <>
            <Field label="User">{(id) => <Input id={id} required value={f.username} onChange={set('username')} />}</Field>
            <Field label="Security level">
              {(id) => (
                <Select id={id} value={f.securityLevel} onChange={set('securityLevel')}>
                  <option value="authPriv">authPriv (recommended)</option>
                  <option value="authNoPriv">authNoPriv</option>
                  <option value="noAuthNoPriv">noAuthNoPriv</option>
                </Select>
              )}
            </Field>
            {f.securityLevel !== 'noAuthNoPriv' && (
              <>
                <Field label="Auth protocol">
                  {(id) => (
                    <Select id={id} value={f.authProtocol} onChange={set('authProtocol')}>
                      {SNMP_AUTH_PROTOCOLS.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </Select>
                  )}
                </Field>
                {secret('Auth key', 'authKey')}
              </>
            )}
            {f.securityLevel === 'authPriv' && (
              <>
                <Field label="Privacy protocol">
                  {(id) => (
                    <Select id={id} value={f.privProtocol} onChange={set('privProtocol')}>
                      {SNMP_PRIV_PROTOCOLS.map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </Select>
                  )}
                </Field>
                {secret('Privacy key', 'privKey')}
              </>
            )}
          </>
        )}
        {(kind === 'routeros_rest' || kind === 'nxapi' || kind === 'routeros_api') && (
          <>
            <Field label="Username" hint={kind === 'routeros_rest' ? 'A user in a group with only the read and rest-api policies' : kind === 'routeros_api' ? 'A user in a group with only the read and api policies' : 'A network-operator (read-only) role user'}>
              {(id, d) => <Input id={id} aria-describedby={d} required value={f.username} onChange={set('username')} />}
            </Field>
            {secret('Password', 'password')}
          </>
        )}
        {kind === 'fortios_rest' && (
          <>
            {secret('REST API token', 'token', true, 'From a REST API admin with a read-only profile')}
            <Field label="VDOM">{(id) => <Input id={id} value={f.vdom} onChange={set('vdom')} placeholder="root" />}</Field>
          </>
        )}
        {kind === 'routeros_api' && (
          <>
            <Field label="Service">
              {(id) => (
                <Select id={id} value={f.tls ? 'tls' : 'plain'} onChange={(e) => setF((x) => ({ ...x, tls: e.target.value === 'tls' }))}>
                  <option value="tls">api-ssl (encrypted)</option>
                  <option value="plain">api (lab only: password sent in clear)</option>
                </Select>
              )}
            </Field>
            {f.tls && (
              <label className="flex items-center gap-2 self-end pb-2 text-[13.5px]">
                <input type="checkbox" checked={f.verifyTls} onChange={(e) => setF((x) => ({ ...x, verifyTls: e.target.checked }))} /> Verify the TLS certificate
              </label>
            )}
          </>
        )}
        {!snmp && kind !== 'routeros_api' && (
          <>
            <Field label="Protocol">
              {(id) => (
                <Select id={id} value={f.scheme} onChange={set('scheme')}>
                  <option value="https">HTTPS</option>
                  <option value="http">HTTP (lab only: credentials sent in clear)</option>
                </Select>
              )}
            </Field>
            <label className="flex items-center gap-2 self-end pb-2 text-[13.5px]">
              <input type="checkbox" checked={f.verifyTls} onChange={(e) => setF((x) => ({ ...x, verifyTls: e.target.checked }))} /> Verify the TLS certificate
            </label>
          </>
        )}
        <Field label="Timeout (ms)">{(id) => <Input id={id} type="number" min={500} max={30000} value={f.timeoutMs} onChange={set('timeoutMs')} placeholder={snmp ? '3000' : '5000'} />}</Field>
        <ErrorNote error={m.error} className="sm:col-span-2" />
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={m.isPending}>
            Save encrypted
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ discovery */

const FIELD_LABELS: Record<string, string> = { description: 'Description', macAddress: 'MAC', mtu: 'MTU', speedBps: 'Speed', enabled: 'Enabled', ifIndex: 'ifIndex' };
const fmtChange = (field: string, v: unknown) => (v === null || v === undefined ? '' : field === 'speedBps' ? formatBps(Number(v)) : field === 'enabled' ? (v ? 'yes' : 'no') : String(v));

interface RunDetailT extends RunT {
  result: Record<string, unknown> | null;
  preview: null | {
    interfaces: { name: string; kind: InterfaceKind; action: 'create' | 'update' | 'unchanged'; existingKind: string | null; changes: { field: string; from: unknown; to: unknown }[]; operUp: boolean | null; adminUp: boolean | null; speedBps: number | null; description: string | null; lagName: string | null; addresses: string[] }[];
    missing: { interfaceId: string; name: string; kind: string }[];
    neighbors: { localInterface: string; protocol: string; remoteSystemName: string | null; remotePortId: string; remoteChassisId: string; remoteMgmtAddress: string | null; matched: { deviceId: string; deviceName: string; interfaceId: string | null; interfaceName: string | null } | null; cable: 'verified' | 'mismatch' | 'none' | null; note: string | null }[];
    addresses: { interface: string; address: string; status: 'documented' | 'other_device' | 'not_in_ipam' | 'no_prefix'; detail: string | null }[];
    counts: { create: number; update: number; unchanged: number; missing: number };
  };
}

function RunsPanel({ device, runs, creds }: { device: NetworkDeviceT; runs: RunT[]; creds: CredentialT[] }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<CredentialKind | ''>('');
  const usable = creds.map((c) => c.kind);
  const k = (kind || usable[0]) as CredentialKind | undefined;
  const start = useMutation({
    mutationFn: (mode: 'test' | 'discover') => api.post<RunT>(`/network/devices/${device.id}/discovery`, { kind: k, mode }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['network', 'device', device.id] });
      setOpen(r.id);
    },
  });
  const active = runs.some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => qc.invalidateQueries({ queryKey: ['network', 'device', device.id] }), 2000);
    return () => clearInterval(h);
  }, [active, device.id, qc]);
  return (
    <Panel title="Discovery">
      <p className="mb-3 text-[13px] text-ink-2">
        Reads interfaces, LLDP/CDP neighbors, BGP sessions and device facts. Results are shown as a preview; nothing changes in inventory until you apply it, and nothing is ever changed on the device.
      </p>
      {can('network.write') && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <Field label="Using">
            {(id) => (
              <Select id={id} className="w-60" value={k ?? ''} onChange={(e) => setKind(e.target.value as CredentialKind)} disabled={!usable.length}>
                {!usable.length && <option value="">Add access first</option>}
                {CREDENTIAL_KINDS.filter((x) => usable.includes(x)).map((x) => (
                  <option key={x} value={x}>
                    {CREDENTIAL_KIND_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button disabled={!k || active} busy={start.isPending && start.variables === 'test'} onClick={() => start.mutate('test')}>
            Test connection
          </Button>
          <Button variant="primary" disabled={!k || active} busy={start.isPending && start.variables === 'discover'} onClick={() => start.mutate('discover')}>
            Run discovery
          </Button>
        </div>
      )}
      <ErrorNote error={start.error} className="mb-3" />
      {runs.length === 0 ? (
        <p className="text-ink-3">No runs yet.</p>
      ) : (
        <ul className="divide-y divide-rule">
          {runs.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p>
                  <Chip tone={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'crit' : 'est'}>{r.status}</Chip> {r.trigger === 'schedule' ? 'Scheduled discovery' : r.mode === 'test' ? 'Connection test' : 'Discovery'} via {CREDENTIAL_KIND_LABELS[r.credentialKind]}
                  {r.changes && !r.appliedAt && (
                    <Chip tone={r.changes.total ? 'warn' : 'ok'} title={r.changes.total ? `${r.changes.create} new, ${r.changes.update} changed, ${r.changes.missing} not reported, ${r.changes.neighborMismatch} neighbor/cable differences, ${r.changes.addressesNotInIpam} addresses not in IPAM` : 'Matches inventory'}>
                      {r.changes.total ? `${r.changes.total} difference${r.changes.total === 1 ? '' : 's'}` : 'no differences'}
                    </Chip>
                  )}
                  {r.appliedAt && (
                    <Chip tone="accent" title={`Applied ${formatDateTime(r.appliedAt)}`}>
                      applied
                    </Chip>
                  )}
                </p>
                <p className="text-[12.5px] text-ink-3">
                  {formatDateTime(r.createdAt)} · {r.requestedLabel}
                  {r.error ? ` · ${r.error}` : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setOpen(r.id)}>
                View
              </Button>
            </li>
          ))}
        </ul>
      )}
      {open && <RunDetail id={open} device={device} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

function RunDetail({ id, device, onClose }: { id: string; device: NetworkDeviceT; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['network', 'run', id],
    queryFn: () => api.get<RunDetailT>(`/network/discovery/${id}`),
    refetchInterval: (query) => (query.state.data && (query.state.data.status === 'queued' || query.state.data.status === 'running') ? 1500 : false),
  });
  const pv = q.data?.preview;
  const [sel, setSel] = useState<Set<string> | null>(null);
  const selected = useMemo(() => sel ?? new Set((pv?.interfaces ?? []).filter((i) => i.action !== 'unchanged').map((i) => i.name)), [sel, pv]);
  const [facts, setFacts] = useState(false);
  const [nbrs, setNbrs] = useState(true);
  const importable = useMemo(() => (pv?.addresses ?? []).filter((a) => a.status === 'not_in_ipam' || a.status === 'no_prefix'), [pv]);
  const [addrSel, setAddrSel] = useState<Set<string> | null>(null);
  const addrSelected = useMemo(() => addrSel ?? new Set(importable.filter((a) => a.status === 'not_in_ipam').map((a) => `${a.interface}|${a.address}`)), [addrSel, importable]);
  const [createPrefixes, setCreatePrefixes] = useState(false);
  const canIpam = can('ipam.write');
  const apply = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number; neighbors: number; facts: string[]; addresses: number; prefixesCreated: number; warnings: string[] }>(`/network/discovery/${id}/apply`, {
        interfaces: [...selected],
        updateDeviceFacts: facts,
        importNeighbors: nbrs,
        addresses: canIpam ? [...addrSelected].map((k) => ({ interface: k.split('|')[0], address: k.split('|')[1] })) : [],
        createPrefixes,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network'] }),
  });
  const r = q.data;
  const result = r?.result as { facts?: FactsT; bgp?: BgpT[]; warnings?: string[]; message?: string; latencyMs?: number; collectedAt?: string } | null | undefined;
  const toggle = (name: string) => setSel(() => {
    const n = new Set(selected);
    if (n.has(name)) n.delete(name);
    else n.add(name);
    return n;
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={r ? `${r.mode === 'test' ? 'Connection test' : 'Discovery'} — ${deviceLabel(device)}` : 'Discovery'} wide>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {r && (r.status === 'queued' || r.status === 'running') && (
        <div className="flex items-center gap-2 text-ink-2">
          <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />
          {r.status === 'queued' ? 'Waiting for the discovery worker…' : 'Collecting from the device…'}
          <span className="text-[12.5px] text-ink-3">(If this never starts, check that the crapplet-dcim-worker service is running.)</span>
        </div>
      )}
      {r?.status === 'failed' && <ErrorNote error={new Error(r.error ?? 'Failed')} />}
      {r?.status === 'succeeded' && r.mode === 'test' && (
        <p className="rounded-lg bg-ok-soft px-3 py-2 text-ok">
          {result?.message} {result?.latencyMs !== undefined && <span className="text-[12.5px]">({result.latencyMs} ms)</span>}
        </p>
      )}
      {r?.status === 'succeeded' && pv && (
        <div className="grid gap-4">
          <p className="text-[13px] text-ink-2">
            Collected {result?.collectedAt ? formatDateTime(result.collectedAt) : ''}. {pv.counts.create} new, {pv.counts.update} changed, {pv.counts.unchanged} unchanged
            {pv.counts.missing ? `, ${pv.counts.missing} documented but not reported by the device (kept; review them manually)` : ''}.
          </p>
          {!!result?.warnings?.length && (
            <ul className="list-disc rounded-lg bg-warn-soft py-2 pr-3 pl-7 text-[12.5px] text-warn">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="max-h-72 overflow-y-auto rounded-xl border border-rule">
            <Table label="Discovered interfaces">
              <thead>
                <tr>
                  <th>
                    <span className="sr-only">Apply</span>
                  </th>
                  <th>Interface</th>
                  <th>Change</th>
                  <th>Link</th>
                  <th>Addresses</th>
                </tr>
              </thead>
              <tbody>
                {pv.interfaces.map((i) => (
                  <tr key={i.name}>
                    <td>
                      <input type="checkbox" aria-label={`Apply ${i.name}`} checked={selected.has(i.name)} disabled={!!r.appliedAt} onChange={() => toggle(i.name)} />
                    </td>
                    <td>
                      <span className="font-mono text-[12.5px] whitespace-nowrap">{i.name}</span> <span className="block text-[12px] text-ink-3">{INTERFACE_KIND_LABELS[i.kind]}</span>
                      {i.lagName && <div className="text-[12px] text-ink-3">in {i.lagName}</div>}
                    </td>
                    <td className="text-[12.5px]">
                      {i.action === 'create' && <Chip tone="accent">new</Chip>}
                      {i.action === 'unchanged' && <span className="text-ink-3">unchanged</span>}
                      {i.action === 'update' && i.changes.map((c) => <div key={c.field}>{FIELD_LABELS[c.field] ?? c.field}: {fmtChange(c.field, c.from) || '—'} → {fmtChange(c.field, c.to)}</div>)}
                    </td>
                    <td className="text-[12.5px] whitespace-nowrap">
                      {i.adminUp === false ? <Chip>admin down</Chip> : i.operUp ? <Chip tone="ok">up</Chip> : i.operUp === false ? <Chip tone="crit">down</Chip> : '—'} {formatBps(i.speedBps)}
                    </td>
                    <td className="font-mono text-[12px]">{i.addresses.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          {pv.missing.length > 0 && (
            <p className="text-[12.5px] text-ink-2">
              Not reported by the device: <span className="font-mono">{pv.missing.map((m) => m.name).join(', ')}</span>. Discovery never deletes documented ports.
            </p>
          )}
          {pv.neighbors.length > 0 && (
            <div>
              <p className="mb-1 text-[13px] font-semibold">Neighbors</p>
              <ul className="divide-y divide-rule rounded-xl border border-rule text-[13px]">
                {pv.neighbors.map((n, idx) => (
                  <li key={idx} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                    <span>
                      <span className="font-mono">{n.localInterface}</span> → {n.remoteSystemName ?? n.remoteChassisId} <span className="font-mono">{n.remotePortId}</span> <span className="text-ink-3">({n.protocol.toUpperCase()})</span>
                    </span>
                    <span>
                      {n.matched ? <Chip tone="accent">{n.matched.deviceName}{n.matched.interfaceName ? ` ${n.matched.interfaceName}` : ''}</Chip> : <Chip>not in inventory</Chip>}{' '}
                      {n.cable === 'verified' && <Chip tone="ok">matches cable</Chip>}
                      {n.cable === 'mismatch' && <Chip tone="crit">cable says otherwise</Chip>}
                      {n.cable === 'none' && <Chip tone="warn">no cable documented</Chip>}
                      {n.note && <span className="ml-1 text-[12px] text-ink-3">{n.note}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pv.addresses.length > 0 && (
            <div>
              <p className="mb-1 text-[13px] font-semibold">Addresses on the device vs IPAM</p>
              <ul className="flex flex-wrap gap-x-3 gap-y-1.5">
                {pv.addresses.map((a) => {
                  const key = `${a.interface}|${a.address}`;
                  const canPick = canIpam && !r.appliedAt && (a.status === 'not_in_ipam' || a.status === 'no_prefix');
                  return (
                    <li key={key} className="flex items-center gap-1">
                      {canPick && (
                        <input
                          type="checkbox"
                          aria-label={`Record ${a.address} in IPAM`}
                          checked={addrSelected.has(key)}
                          onChange={() =>
                            setAddrSel(() => {
                              const n = new Set(addrSelected);
                              if (n.has(key)) n.delete(key);
                              else n.add(key);
                              return n;
                            })
                          }
                        />
                      )}
                      <Chip tone={a.status === 'documented' ? 'ok' : a.status === 'other_device' ? 'crit' : 'warn'} title={a.detail ?? (a.status === 'no_prefix' ? 'No prefix in IPAM covers this address' : 'Not recorded in IPAM')}>
                        {a.address} {a.status.replace(/_/g, ' ')}
                      </Chip>
                      <span className="text-[11.5px] text-ink-3">{a.interface}</span>
                    </li>
                  );
                })}
              </ul>
              {canIpam && importable.length > 0 && !r.appliedAt && (
                <p className="mt-1 text-[12.5px] text-ink-3">
                  Ticked addresses are recorded in IPAM (global table) on apply, bound to their interface. Addresses held by another device are never changed.
                </p>
              )}
            </div>
          )}
          {!!result?.bgp?.length && <BgpTable bgp={result.bgp} />}
          {can('network.write') && !r.appliedAt && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
              <div className="flex flex-wrap gap-4 text-[13.5px]">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={nbrs} onChange={(e) => setNbrs(e.target.checked)} /> Record neighbors
                </label>
                {canIpam && importable.some((a) => a.status === 'no_prefix' && addrSelected.has(`${a.interface}|${a.address}`)) && (
                  <label className="flex items-center gap-2" title="Adds the subnet (e.g. 203.0.113.0/30) as an active prefix when IPAM has none covering the address">
                    <input type="checkbox" checked={createPrefixes} onChange={(e) => setCreatePrefixes(e.target.checked)} /> Create missing subnets in IPAM
                  </label>
                )}
                <label className="flex items-center gap-2" title="Hostname (if empty), serial and OS version">
                  <input type="checkbox" checked={facts} onChange={(e) => setFacts(e.target.checked)} /> Update serial / OS on the hardware record
                </label>
              </div>
              <Button variant="primary" busy={apply.isPending} onClick={() => apply.mutate()} disabled={!!apply.data}>
                Apply {selected.size} interface{selected.size === 1 ? '' : 's'}
                {canIpam && addrSelected.size ? ` and ${addrSelected.size} address${addrSelected.size === 1 ? '' : 'es'}` : ''}
              </Button>
            </div>
          )}
          <ErrorNote error={apply.error} />
          {apply.data && (
            <p className="rounded-lg bg-ok-soft px-3 py-2 text-ok">
              Applied: {apply.data.created} created, {apply.data.updated} updated, {apply.data.neighbors} neighbor records, {apply.data.addresses} addresses recorded in IPAM{apply.data.prefixesCreated ? ` (${apply.data.prefixesCreated} new subnets)` : ''}{apply.data.facts.length ? `, updated ${apply.data.facts.join(', ')}` : ''}.
              {apply.data.warnings.map((w) => (
                <span key={w} className="block text-warn">
                  {w}
                </span>
              ))}
            </p>
          )}
          {r.appliedAt && !apply.data && <p className="text-[13px] text-ink-3">Applied {formatDateTime(r.appliedAt)}. Run a new discovery to pick up later changes.</p>}
        </div>
      )}
    </Modal>
  );
}
