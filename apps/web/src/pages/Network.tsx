import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { CABLE_STATUSES, CABLE_TYPE_LABELS, CABLE_TYPES, CIRCUIT_STATUSES, CIRCUIT_TYPE_LABELS, CIRCUIT_TYPES, CREDENTIAL_KIND_LABELS, PLATFORM_LABELS, VLAN_STATUSES } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { useTree } from '../lib/dcim';
import { deviceLabel, formatBps, useProviders, useVlans, useVrfs, type CableT, type CircuitT, type NetworkDeviceT, type ProviderT, type VlanT, type VrfT } from '../lib/network';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table, Textarea, cx } from '../components/ui';
import { useCustomerOptions } from './Racks';
import { TopologyView } from './Topology';

const TABS = [
  { key: 'devices', label: 'Devices' },
  { key: 'topology', label: 'Topology' },
  { key: 'cables', label: 'Cables' },
  { key: 'vlans', label: 'VLANs' },
  { key: 'vrfs', label: 'VRFs' },
  { key: 'circuits', label: 'Circuits' },
] as const;

const t = (v: string) => (v.trim() === '' ? null : v.trim());
const n = (v: string) => (v.trim() === '' ? null : Number(v));

export function Tabs<K extends string>({ tabs, value, onChange, label }: { tabs: readonly { key: K; label: string }[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="mb-4 flex w-fit max-w-full flex-wrap gap-1 rounded-xl border border-rule bg-sunken p-1">
      {tabs.map((x) => (
        <button
          key={x.key}
          role="tab"
          aria-selected={value === x.key}
          onClick={() => onChange(x.key)}
          className={cx('h-8 rounded-lg px-3.5 text-[13.5px]', value === x.key ? 'bg-panel font-semibold text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

export function NetworkPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as (typeof TABS)[number]['key']) ?? 'devices';
  return (
    <>
      <PageHeader
        title="Network infrastructure"
        description="Routers, switches and firewalls with their ports, cabling, VLANs, VRFs and provider circuits. Discovery is read-only: it never changes device configuration."
      />
      <Tabs tabs={TABS} value={tab} label="Network sections" onChange={(k) => setParams(k === 'devices' ? {} : { tab: k }, { replace: true })} />
      {tab === 'devices' && <DevicesTab />}
      {tab === 'topology' && <TopologyView />}
      {tab === 'cables' && <CablesTab />}
      {tab === 'vlans' && <VlansTab />}
      {tab === 'vrfs' && <VrfsTab />}
      {tab === 'circuits' && <CircuitsTab />}
    </>
  );
}

/* ------------------------------------------------------------------ devices */

function DevicesTab() {
  const tree = useTree();
  const [q, setQ] = useState('');
  const [dc, setDc] = useState('');
  const [all, setAll] = useState(false);
  const list = useQuery({ queryKey: ['network', 'devices', q, dc, all], queryFn: () => api.get<NetworkDeviceT[]>(`/network/devices${qs({ q, datacenterId: dc, all: all ? 'true' : undefined })}`) });
  return (
    <Panel flush>
      <div className="flex flex-wrap items-end gap-3 border-b border-rule p-4">
        <Field label="Search">{(id) => <Input id={id} className="w-64" placeholder="Hostname, asset tag, address, model" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
        <Field label="Datacenter">
          {(id) => (
            <Select id={id} className="w-48" value={dc} onChange={(e) => setDc(e.target.value)}>
              <option value="">All</option>
              {tree.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <label className="flex h-9 items-center gap-2 text-[13.5px] text-ink-2">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include servers and other devices
        </label>
        <p className="ml-auto max-w-[44ch] text-[12.5px] text-ink-3">
          Network devices are added under <Link to="/hardware" className="text-accent hover:underline">Servers & Hardware</Link> with a router, switch or firewall model; manage their ports here.
        </p>
      </div>
      {list.isLoading && <Loading />}
      <ErrorNote error={list.error} className="m-4" />
      {list.data?.length === 0 && <EmptyState title="No network devices">Add a device whose model category is router, switch, firewall, load balancer or optical.</EmptyState>}
      {!!list.data?.length && (
        <Table label="Network devices">
          <thead>
            <tr>
              <th>Device</th>
              <th>Platform</th>
              <th>Location</th>
              <th>Management</th>
              <th className="text-right">Ports</th>
              <th className="text-right">Cabled</th>
              <th>Access</th>
              <th>Last discovery</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.id} className="hover:bg-sunken/60">
                <td>
                  <Link to={`/network/devices/${d.id}`} className="font-medium text-accent hover:underline">
                    {deviceLabel(d)}
                  </Link>
                  <div className="text-[12.5px] text-ink-3">
                    {d.manufacturerName} {d.modelName}
                    {d.networkRole ? ` · ${d.networkRole}` : ''}
                  </div>
                </td>
                <td>{d.platform ? PLATFORM_LABELS[d.platform] : <span className="text-ink-3">Not set</span>}</td>
                <td className="whitespace-nowrap">{d.datacenterCode ? `${d.datacenterCode} · ${d.rackName}${d.positionU ? ` U${d.positionU}` : ''}` : <span className="text-ink-3">Not racked</span>}</td>
                <td className="font-mono text-[12.5px]">{d.mgmtAddress ?? <span className="font-sans text-ink-3">—</span>}</td>
                <td className="text-right tabular-nums">{d.interfaceCount}</td>
                <td className="text-right tabular-nums">
                  {d.cabledCount}/{d.physicalCount}
                </td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {d.credentialKinds.length ? d.credentialKinds.map((k) => <Chip key={k}>{CREDENTIAL_KIND_LABELS[k]}</Chip>) : <span className="text-ink-3">None</span>}
                  </div>
                </td>
                <td className="whitespace-nowrap">
                  {d.lastDiscovery ? (
                    <Chip tone={d.lastDiscovery.status === 'succeeded' ? 'ok' : d.lastDiscovery.status === 'failed' ? 'crit' : 'est'} title={d.lastDiscovery.mode === 'test' ? 'Connection test' : 'Discovery'}>
                      {d.lastDiscovery.status} {d.lastDiscovery.finishedAt ? relativeTime(d.lastDiscovery.finishedAt) : ''}
                    </Chip>
                  ) : (
                    <span className="text-ink-3">Never</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ cables */

function CablesTab() {
  const list = useQuery({ queryKey: ['network', 'cables'], queryFn: () => api.get<CableT[]>('/network/cables') });
  const { can } = useAuth();
  const [edit, setEdit] = useState<CableT | null>(null);
  return (
    <Panel flush>
      <p className="border-b border-rule px-4 py-3 text-[13px] text-ink-2">Cables are created from a device's ports page (choose a port, then “Connect cable”). A port takes exactly one cable; logical interfaces cannot be cabled.</p>
      {list.isLoading && <Loading />}
      <ErrorNote error={list.error} className="m-4" />
      {list.data?.length === 0 && <EmptyState title="No cables documented" />}
      {!!list.data?.length && (
        <Table label="Cables">
          <thead>
            <tr>
              <th>Label</th>
              <th>A side</th>
              <th>B side</th>
              <th>Type</th>
              <th>Status</th>
              <th>Length</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((c) => (
              <tr key={c.id}>
                <td className="font-mono text-[12.5px]">{c.label ?? '—'}</td>
                <td>
                  <Link className="text-accent hover:underline" to={`/network/devices/${c.a.deviceId}`}>
                    {c.a.deviceName}
                  </Link>{' '}
                  <span className="font-mono text-[12.5px]">{c.a.interfaceName}</span>
                </td>
                <td>
                  <Link className="text-accent hover:underline" to={`/network/devices/${c.b.deviceId}`}>
                    {c.b.deviceName}
                  </Link>{' '}
                  <span className="font-mono text-[12.5px]">{c.b.interfaceName}</span>
                </td>
                <td>{c.type ? CABLE_TYPE_LABELS[c.type as keyof typeof CABLE_TYPE_LABELS] : '—'}</td>
                <td>
                  <Chip tone={c.status === 'connected' ? 'ok' : c.status === 'planned' ? 'est' : 'warn'}>{c.status}</Chip>
                </td>
                <td>{c.lengthM !== null ? `${c.lengthM} m` : '—'}</td>
                <td className="text-right">
                  {can('network.write') && (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(c)}>
                      Edit
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit && <CableEditor cable={edit} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

export function CableEditor({ cable, onClose }: { cable: CableT | { id: string; status: string | null; type: string | null; label: string | null; color?: string | null; lengthM?: number | null; notes?: string | null }; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ type: cable.type ?? '', status: cable.status ?? 'connected', label: cable.label ?? '', color: cable.color ?? '', lengthM: cable.lengthM?.toString() ?? '', notes: cable.notes ?? '' });
  const [confirm, setConfirm] = useState(false);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['network'] });
    onClose();
  };
  const save = useMutation({ mutationFn: () => api.patch(`/network/cables/${cable.id}`, { type: t(f.type), status: f.status, label: t(f.label), color: t(f.color), lengthM: n(f.lengthM), notes: t(f.notes) }), onSuccess: done });
  const del = useMutation({ mutationFn: () => api.delete(`/network/cables/${cable.id}`), onSuccess: done });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Cable">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <CableFields f={f} setF={setF} />
        <ErrorNote error={save.error} className="sm:col-span-2" />
        <div className="flex justify-between gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" className="text-crit" onClick={() => setConfirm(true)}>
            Remove cable
          </Button>
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
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Remove this cable?" body="Both ports become free. The record is removed; the change is kept in the audit log." confirmLabel="Remove cable" onConfirm={() => del.mutate()} busy={del.isPending} error={del.error} />
    </Modal>
  );
}

type CableForm = { type: string; status: string; label: string; color: string; lengthM: string; notes: string };
export function CableFields({ f, setF }: { f: CableForm; setF: (fn: (x: CableForm) => CableForm) => void }) {
  const set = (k: keyof CableForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <>
      <Field label="Type">
        {(id) => (
          <Select id={id} value={f.type} onChange={set('type')}>
            <option value="">Not specified</option>
            {CABLE_TYPES.map((c) => (
              <option key={c} value={c}>
                {CABLE_TYPE_LABELS[c]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Status">
        {(id) => (
          <Select id={id} value={f.status} onChange={set('status')}>
            {CABLE_STATUSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Label">{(id) => <Input id={id} value={f.label} onChange={set('label')} className="font-mono" />}</Field>
      <Field label="Color">{(id) => <Input id={id} value={f.color} onChange={set('color')} />}</Field>
      <Field label="Length (m)">{(id) => <Input id={id} type="number" min={0} step="0.1" value={f.lengthM} onChange={set('lengthM')} />}</Field>
      <Field label="Notes">{(id) => <Input id={id} value={f.notes} onChange={set('notes')} />}</Field>
    </>
  );
}

/* ------------------------------------------------------------------ VLANs */

function VlansTab() {
  const list = useVlans();
  const { can } = useAuth();
  const [edit, setEdit] = useState<VlanT | 'new' | null>(null);
  const [ports, setPorts] = useState<VlanT | null>(null);
  return (
    <Panel flush actions={can('network.write') && <Button variant="primary" size="sm" onClick={() => setEdit('new')}>Add VLAN</Button>} title="VLANs">
      {list.isLoading && <Loading />}
      <ErrorNote error={list.error} className="m-4" />
      {list.data?.length === 0 && <EmptyState title="No VLANs">A VLAN ID is unique within a datacenter (or globally when no datacenter is set).</EmptyState>}
      {!!list.data?.length && (
        <Table label="VLANs">
          <thead>
            <tr>
              <th>VID</th>
              <th>Name</th>
              <th>Scope</th>
              <th>Customer</th>
              <th>Status</th>
              <th className="text-right">Ports</th>
              <th className="text-right">Prefixes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((v) => (
              <tr key={v.id}>
                <td className="font-mono tabular-nums">{v.vid}</td>
                <td className="font-medium">{v.name}</td>
                <td>{v.datacenterCode ?? <span className="text-ink-3">Global</span>}</td>
                <td>{v.customerName ?? '—'}</td>
                <td>
                  <Chip tone={v.status === 'active' ? 'ok' : v.status === 'reserved' ? 'est' : 'warn'}>{v.status}</Chip>
                </td>
                <td className="text-right">
                  <button className="text-accent tabular-nums hover:underline" onClick={() => setPorts(v)}>
                    {v.portCount}
                  </button>
                </td>
                <td className="text-right tabular-nums">{v.prefixCount}</td>
                <td className="text-right">
                  {can('network.write') && (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(v)}>
                      Edit
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit && <VlanForm vlan={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
      {ports && <VlanPorts vlan={ports} onClose={() => setPorts(null)} />}
    </Panel>
  );
}

function VlanPorts({ vlan, onClose }: { vlan: VlanT; onClose: () => void }) {
  const q = useQuery({ queryKey: ['network', 'vlans', vlan.id, 'ports'], queryFn: () => api.get<{ id: string; name: string; deviceId: string; deviceName: string; membership: string }[]>(`/network/vlans/${vlan.id}/ports`) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`VLAN ${vlan.vid} — ${vlan.name}`} description="Ports carrying this VLAN (as documented)." wide>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {q.data?.length === 0 && <p className="text-ink-2">No ports carry this VLAN.</p>}
      <ul className="divide-y divide-rule">
        {q.data?.map((p) => (
          <li key={p.id} className="flex justify-between py-2">
            <Link className="text-accent hover:underline" to={`/network/devices/${p.deviceId}`}>
              {p.deviceName} <span className="font-mono">{p.name}</span>
            </Link>
            <Chip>{p.membership}</Chip>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function VlanForm({ vlan, onClose }: { vlan?: VlanT; onClose: () => void }) {
  const qc = useQueryClient();
  const tree = useTree();
  const customers = useCustomerOptions();
  const [f, setF] = useState({ vid: vlan?.vid.toString() ?? '', name: vlan?.name ?? '', datacenterId: vlan?.datacenterId ?? '', status: vlan?.status ?? 'active', customerId: vlan?.customerId ?? '', description: vlan?.description ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const [confirm, setConfirm] = useState(false);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['network'] });
    onClose();
  };
  const body = () => ({ vid: Number(f.vid), name: f.name, datacenterId: t(f.datacenterId), status: f.status, customerId: t(f.customerId), description: t(f.description) });
  const save = useMutation({ mutationFn: () => (vlan ? api.put(`/network/vlans/${vlan.id}`, body()) : api.post('/network/vlans', body())), onSuccess: done });
  const del = useMutation({ mutationFn: () => api.delete(`/network/vlans/${vlan!.id}`), onSuccess: done });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={vlan ? `Edit VLAN ${vlan.vid}` : 'Add VLAN'}>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="VLAN ID">{(id) => <Input id={id} type="number" min={1} max={4094} required value={f.vid} onChange={set('vid')} />}</Field>
        <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} />}</Field>
        <Field label="Scope" hint="VLAN IDs are unique per datacenter">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={f.datacenterId} onChange={set('datacenterId')}>
              <option value="">Global (all datacenters)</option>
              {tree.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} — {x.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <Select id={id} value={f.status} onChange={set('status')}>
              {VLAN_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Customer">
          {(id) => (
            <Select id={id} value={f.customerId} onChange={set('customerId')}>
              <option value="">None</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Description">{(id) => <Input id={id} value={f.description} onChange={set('description')} />}</Field>
        <ErrorNote error={save.error} className="sm:col-span-2" />
        <FormButtons onCancel={onClose} busy={save.isPending} onDelete={vlan ? () => setConfirm(true) : undefined} />
      </form>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Delete VLAN ${vlan?.vid}?`} body="Only possible when no port or prefix uses it." confirmLabel="Delete VLAN" onConfirm={() => del.mutate()} busy={del.isPending} error={del.error} />
    </Modal>
  );
}

function FormButtons({ onCancel, busy, onDelete, label = 'Save' }: { onCancel: () => void; busy: boolean; onDelete?: () => void; label?: string }) {
  return (
    <div className="flex justify-between gap-2 sm:col-span-2">
      <div>
        {onDelete && (
          <Button type="button" variant="ghost" className="text-crit" onClick={onDelete}>
            Delete
          </Button>
        )}
      </div>
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" busy={busy}>
          {label}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ VRFs */

function VrfsTab() {
  const list = useVrfs();
  const { can } = useAuth();
  const [edit, setEdit] = useState<VrfT | 'new' | null>(null);
  return (
    <Panel flush title="VRFs" actions={can('network.write') && <Button variant="primary" size="sm" onClick={() => setEdit('new')}>Add VRF</Button>}>
      <p className="border-b border-rule px-4 py-3 text-[13px] text-ink-2">Prefixes and addresses outside any VRF belong to the global routing table. The same prefix can exist once per VRF.</p>
      {list.isLoading && <Loading />}
      <ErrorNote error={list.error} className="m-4" />
      {list.data?.length === 0 && <EmptyState title="No VRFs" />}
      {!!list.data?.length && (
        <Table label="VRFs">
          <thead>
            <tr>
              <th>Name</th>
              <th>Route distinguisher</th>
              <th>Description</th>
              <th className="text-right">Prefixes</th>
              <th className="text-right">Addresses</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((v) => (
              <tr key={v.id}>
                <td className="font-medium">{v.name}</td>
                <td className="font-mono text-[12.5px]">{v.rd ?? '—'}</td>
                <td>{v.description ?? '—'}</td>
                <td className="text-right tabular-nums">
                  <Link className="text-accent hover:underline" to={`/ipam?vrf=${v.id}`}>
                    {v.prefixCount}
                  </Link>
                </td>
                <td className="text-right tabular-nums">{v.addressCount}</td>
                <td className="text-right">
                  {can('network.write') && (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(v)}>
                      Edit
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit && <VrfForm vrf={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

function VrfForm({ vrf, onClose }: { vrf?: VrfT; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: vrf?.name ?? '', rd: vrf?.rd ?? '', description: vrf?.description ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const [confirm, setConfirm] = useState(false);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['network'] });
    onClose();
  };
  const body = () => ({ name: f.name, rd: t(f.rd), description: t(f.description) });
  const save = useMutation({ mutationFn: () => (vrf ? api.put(`/network/vrfs/${vrf.id}`, body()) : api.post('/network/vrfs', body())), onSuccess: done });
  const del = useMutation({ mutationFn: () => api.delete(`/network/vrfs/${vrf!.id}`), onSuccess: done });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={vrf ? `Edit ${vrf.name}` : 'Add VRF'}>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} />}</Field>
        <Field label="Route distinguisher" hint="ASN:nn or IP:nn">{(id, d) => <Input id={id} aria-describedby={d} value={f.rd} onChange={set('rd')} className="font-mono" placeholder="65000:100" />}</Field>
        <div className="sm:col-span-2">
          <Field label="Description">{(id) => <Input id={id} value={f.description} onChange={set('description')} />}</Field>
        </div>
        <ErrorNote error={save.error} className="sm:col-span-2" />
        <FormButtons onCancel={onClose} busy={save.isPending} onDelete={vrf ? () => setConfirm(true) : undefined} />
      </form>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Delete ${vrf?.name}?`} body="Only possible when no prefix or address is in it." confirmLabel="Delete VRF" onConfirm={() => del.mutate()} busy={del.isPending} error={del.error} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ circuits */

function CircuitsTab() {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['network', 'circuits'], queryFn: () => api.get<CircuitT[]>('/network/circuits') });
  const providers = useProviders();
  const [edit, setEdit] = useState<CircuitT | 'new' | null>(null);
  const [prov, setProv] = useState<ProviderT | 'new' | null>(null);
  const [history, setHistory] = useState<CircuitT | null>(null);
  return (
    <div className="grid gap-5">
      <Panel
        flush
        title="Circuits"
        actions={
          can('network.write') && (
            <Button variant="primary" size="sm" disabled={!providers.data?.length} title={providers.data?.length ? undefined : 'Add a provider first'} onClick={() => setEdit('new')}>
              Add circuit
            </Button>
          )
        }
      >
        {list.isLoading && <Loading />}
        <ErrorNote error={list.error} className="m-4" />
        {list.data?.length === 0 && <EmptyState title="No circuits">Transit, peering, transport and cross-connects, with their commit rate and the port they land on.</EmptyState>}
        {!!list.data?.length && (
          <Table label="Circuits">
            <thead>
              <tr>
                <th>Circuit ID</th>
                <th>Provider</th>
                <th>Type</th>
                <th>Status</th>
                <th>Commit / port</th>
                <th>Terminates on</th>
                <th>Term ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td className="font-mono text-[12.5px] font-medium">{c.cid}</td>
                  <td>
                    {c.providerName}
                    {c.providerAsn ? <span className="text-ink-3"> AS{c.providerAsn}</span> : null}
                  </td>
                  <td>{CIRCUIT_TYPE_LABELS[c.type as keyof typeof CIRCUIT_TYPE_LABELS] ?? c.type}</td>
                  <td>
                    <Chip tone={c.status === 'active' ? 'ok' : c.status === 'decommissioned' ? 'neutral' : 'est'}>{c.status}</Chip>
                  </td>
                  <td className="whitespace-nowrap">
                    {formatBps(c.commitBps)} / {formatBps(c.portSpeedBps)}
                  </td>
                  <td>
                    {c.deviceId ? (
                      <Link className="text-accent hover:underline" to={`/network/devices/${c.deviceId}`}>
                        {c.deviceName} <span className="font-mono text-[12.5px]">{c.interfaceName}</span>
                      </Link>
                    ) : (
                      <span className="text-ink-3">{c.datacenterCode ?? 'Not set'}</span>
                    )}
                  </td>
                  <td>{c.termEndDate ?? '—'}</td>
                  <td className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => setHistory(c)}>
                      History
                    </Button>
                    {can('network.write') && (
                      <Button size="sm" variant="ghost" onClick={() => setEdit(c)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Panel flush title="Providers" actions={can('network.write') && <Button size="sm" onClick={() => setProv('new')}>Add provider</Button>}>
        {providers.data?.length === 0 && <EmptyState title="No providers" />}
        {!!providers.data?.length && (
          <Table label="Providers">
            <thead>
              <tr>
                <th>Name</th>
                <th>ASN</th>
                <th>Account</th>
                <th>NOC</th>
                <th className="text-right">Circuits</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {providers.data.map((p) => (
                <tr key={p.id}>
                  <td className="font-medium">{p.portalUrl ? <a className="text-accent hover:underline" href={p.portalUrl} target="_blank" rel="noreferrer noopener">{p.name}</a> : p.name}</td>
                  <td className="tabular-nums">{p.asn ? `AS${p.asn}` : '—'}</td>
                  <td className="font-mono text-[12.5px]">{p.accountNumber ?? '—'}</td>
                  <td className="text-[13px]">{[p.nocEmail, p.nocPhone].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="text-right tabular-nums">{p.circuitCount}</td>
                  <td className="text-right">
                    {can('network.write') && (
                      <Button size="sm" variant="ghost" onClick={() => setProv(p)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      {edit && <CircuitForm circuit={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} />}
      {prov && <ProviderForm provider={prov === 'new' ? undefined : prov} onClose={() => setProv(null)} />}
      {history && <CircuitHistory circuit={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function CircuitHistory({ circuit, onClose }: { circuit: CircuitT; onClose: () => void }) {
  const q = useQuery({ queryKey: ['network', 'circuits', circuit.id, 'events'], queryFn: () => api.get<{ id: number; occurredAt: string; actorLabel: string | null; summary: string }[]>(`/network/circuits/${circuit.id}/events`) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Circuit ${circuit.cid}`} description="Change history" wide>
      {q.isLoading && <Loading />}
      <ol className="divide-y divide-rule">
        {q.data?.map((e) => (
          <li key={e.id} className="py-2">
            <p>{e.summary}</p>
            <p className="text-[12.5px] text-ink-3">
              {new Date(e.occurredAt).toLocaleString()} · {e.actorLabel ?? 'system'}
            </p>
          </li>
        ))}
      </ol>
    </Modal>
  );
}

function CircuitForm({ circuit, onClose }: { circuit?: CircuitT; onClose: () => void }) {
  const qc = useQueryClient();
  const tree = useTree();
  const providers = useProviders();
  const customers = useCustomerOptions();
  const devices = useQuery({ queryKey: ['network', 'devices', 'all'], queryFn: () => api.get<NetworkDeviceT[]>('/network/devices') });
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const [f, setF] = useState({
    providerId: circuit?.providerId ?? '',
    cid: circuit?.cid ?? '',
    type: circuit?.type ?? 'internet_transit',
    status: circuit?.status ?? 'active',
    commitMbps: circuit?.commitBps ? String(circuit.commitBps / 1e6) : '',
    portMbps: circuit?.portSpeedBps ? String(circuit.portSpeedBps / 1e6) : '',
    installDate: s(circuit?.installDate),
    termEndDate: s(circuit?.termEndDate),
    datacenterId: s(circuit?.datacenterId),
    deviceId: s(circuit?.deviceId),
    interfaceId: s(circuit?.interfaceId),
    zSide: s(circuit?.zSide),
    customerId: s(circuit?.customerId),
    description: s(circuit?.description),
    notes: s(circuit?.notes),
  });
  const ports = useQuery({ queryKey: ['network', 'interfaces', f.deviceId], queryFn: () => api.get<{ id: string; name: string; kind: string }[]>(`/network/devices/${f.deviceId}/interfaces`), enabled: !!f.deviceId });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const [confirm, setConfirm] = useState(false);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['network'] });
    onClose();
  };
  const mbps = (v: string) => (v.trim() ? Math.round(Number(v) * 1e6) : null);
  const body = () => ({
    providerId: f.providerId,
    cid: f.cid,
    type: f.type,
    status: f.status,
    commitBps: mbps(f.commitMbps),
    portSpeedBps: mbps(f.portMbps),
    installDate: t(f.installDate),
    termEndDate: t(f.termEndDate),
    datacenterId: t(f.datacenterId),
    interfaceId: t(f.interfaceId),
    zSide: t(f.zSide),
    customerId: t(f.customerId),
    description: t(f.description),
    notes: t(f.notes),
  });
  const save = useMutation({ mutationFn: () => (circuit ? api.put(`/network/circuits/${circuit.id}`, body()) : api.post('/network/circuits', body())), onSuccess: done });
  const del = useMutation({ mutationFn: () => api.delete(`/network/circuits/${circuit!.id}`), onSuccess: done });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={circuit ? `Edit circuit ${circuit.cid}` : 'Add circuit'} wide>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Provider">
          {(id) => (
            <Select id={id} required value={f.providerId} onChange={set('providerId')}>
              <option value="">Choose</option>
              {providers.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Circuit ID">{(id) => <Input id={id} required value={f.cid} onChange={set('cid')} className="font-mono" />}</Field>
        <Field label="Type">
          {(id) => (
            <Select id={id} value={f.type} onChange={set('type')}>
              {CIRCUIT_TYPES.map((c) => (
                <option key={c} value={c}>
                  {CIRCUIT_TYPE_LABELS[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <Select id={id} value={f.status} onChange={set('status')}>
              {CIRCUIT_STATUSES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Commit (Mbit/s)">{(id) => <Input id={id} type="number" min={0} step="any" value={f.commitMbps} onChange={set('commitMbps')} />}</Field>
        <Field label="Port speed (Mbit/s)">{(id) => <Input id={id} type="number" min={0} step="any" value={f.portMbps} onChange={set('portMbps')} />}</Field>
        <Field label="Installed">{(id) => <Input id={id} type="date" value={f.installDate} onChange={set('installDate')} />}</Field>
        <Field label="Term ends">{(id) => <Input id={id} type="date" value={f.termEndDate} onChange={set('termEndDate')} />}</Field>
        <Field label="Datacenter">
          {(id) => (
            <Select id={id} value={f.datacenterId} onChange={set('datacenterId')}>
              <option value="">Not set</option>
              {tree.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Customer (for customer circuits)">
          {(id) => (
            <Select id={id} value={f.customerId} onChange={set('customerId')}>
              <option value="">None</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Terminating device">
          {(id) => (
            <Select id={id} value={f.deviceId} onChange={(e) => setF((x) => ({ ...x, deviceId: e.target.value, interfaceId: '' }))}>
              <option value="">Not set</option>
              {devices.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {deviceLabel(d)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Port">
          {(id) => (
            <Select id={id} value={f.interfaceId} onChange={set('interfaceId')} disabled={!f.deviceId}>
              <option value="">Not set</option>
              {ports.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Far end (Z side)">{(id) => <Input id={id} value={f.zSide} onChange={set('zSide')} />}</Field>
        <Field label="Description">{(id) => <Input id={id} value={f.description} onChange={set('description')} />}</Field>
        <div className="sm:col-span-2">
          <Field label="Notes">{(id) => <Textarea id={id} value={f.notes} onChange={set('notes')} />}</Field>
        </div>
        <ErrorNote error={save.error} className="sm:col-span-2" />
        <FormButtons onCancel={onClose} busy={save.isPending} onDelete={circuit ? () => setConfirm(true) : undefined} />
      </form>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Delete circuit ${circuit?.cid}?`} body="Only planned or decommissioned circuits can be deleted; set an active circuit to decommissioned first so its history is kept." confirmLabel="Delete circuit" onConfirm={() => del.mutate()} busy={del.isPending} error={del.error} />
    </Modal>
  );
}

function ProviderForm({ provider, onClose }: { provider?: ProviderT; onClose: () => void }) {
  const qc = useQueryClient();
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const [f, setF] = useState({ name: s(provider?.name), asn: s(provider?.asn), accountNumber: s(provider?.accountNumber), portalUrl: s(provider?.portalUrl), nocEmail: s(provider?.nocEmail), nocPhone: s(provider?.nocPhone), notes: s(provider?.notes) });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const [confirm, setConfirm] = useState(false);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['network'] });
    onClose();
  };
  const body = () => ({ name: f.name, asn: n(f.asn), accountNumber: t(f.accountNumber), portalUrl: t(f.portalUrl), nocEmail: t(f.nocEmail), nocPhone: t(f.nocPhone), notes: t(f.notes) });
  const save = useMutation({ mutationFn: () => (provider ? api.put(`/network/providers/${provider.id}`, body()) : api.post('/network/providers', body())), onSuccess: done });
  const del = useMutation({ mutationFn: () => api.delete(`/network/providers/${provider!.id}`), onSuccess: done });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={provider ? `Edit ${provider.name}` : 'Add provider'}>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} />}</Field>
        <Field label="ASN">{(id) => <Input id={id} type="number" min={1} value={f.asn} onChange={set('asn')} />}</Field>
        <Field label="Account number">{(id) => <Input id={id} value={f.accountNumber} onChange={set('accountNumber')} />}</Field>
        <Field label="Portal URL">{(id) => <Input id={id} type="url" value={f.portalUrl} onChange={set('portalUrl')} />}</Field>
        <Field label="NOC email">{(id) => <Input id={id} type="email" value={f.nocEmail} onChange={set('nocEmail')} />}</Field>
        <Field label="NOC phone">{(id) => <Input id={id} value={f.nocPhone} onChange={set('nocPhone')} />}</Field>
        <ErrorNote error={save.error} className="sm:col-span-2" />
        <FormButtons onCancel={onClose} busy={save.isPending} onDelete={provider ? () => setConfirm(true) : undefined} />
      </form>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Delete ${provider?.name}?`} body="Only possible when the provider has no circuits." confirmLabel="Delete provider" onConfirm={() => del.mutate()} busy={del.isPending} error={del.error} />
    </Modal>
  );
}

export function Kv({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-ink-3">{k}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}
