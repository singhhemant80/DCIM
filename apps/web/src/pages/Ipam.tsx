import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IP_ROLES, IP_STATUS_LABELS, PREFIX_STATUSES, PREFIX_STATUS_LABELS, type IpStatus } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { useTree } from '../lib/dcim';
import { deviceLabel, useVlans, useVrfs, type InterfaceT, type NetworkDeviceT } from '../lib/network';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Stat, Table, Textarea, cx } from '../components/ui';
import { useCustomerOptions } from './Racks';
import { Tabs } from './Network';
import { AddressDns, DnsTab } from './IpamDns';

export interface PrefixT {
  id: string;
  prefix: string;
  family: 4 | 6;
  vrfId: string | null;
  vrfName: string | null;
  status: (typeof PREFIX_STATUSES)[number];
  isPool: boolean;
  gateway: string | null;
  description: string | null;
  customerId: string | null;
  customerName: string | null;
  datacenterId: string | null;
  datacenterCode: string | null;
  vlan: { id: string; vid: number; name: string } | null;
  depth: number;
  childCount: number;
  size: string;
  usable: string;
  usedAddresses: number;
  addressUtilization: number;
  childCoverage: number;
}
interface PrefixDetailT extends PrefixT {
  parents: PrefixT[];
  children: PrefixT[];
  available: { first: string; last: string; count: string }[];
  ptrZone: string;
}
export interface AddressT {
  id: string;
  address: string;
  family: 4 | 6;
  prefixLength: number | null;
  vrfId: string | null;
  vrfName: string | null;
  status: IpStatus;
  reservationExpired: boolean;
  role: string | null;
  dnsName: string | null;
  reverseDns: string | null;
  customerId: string | null;
  customerName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  interfaceId: string | null;
  interfaceName: string | null;
  serviceRef: string | null;
  reservedUntil: string | null;
  prefixId: string | null;
  prefix: string | null;
  notes?: string | null;
  dns?: { status: string; error: string | null; syncedAt: string | null; records: { name: string; type: string; content: string }[] };
  updatedAt: string;
}

const t = (v: string) => (v.trim() === '' ? null : v.trim());
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const STATUS_TONE: Record<IpStatus, 'ok' | 'est' | 'warn' | 'neutral'> = {
  allocated: 'ok',
  reserved: 'est',
  deprecated: 'warn',
  released: 'neutral',
};
const big = (n: string) => (n.length > 9 ? `${Number(n).toExponential(2)}` : Number(n).toLocaleString('en-IN'));

const TABS = [
  { key: 'prefixes', label: 'Prefixes' },
  { key: 'addresses', label: 'Addresses' },
  { key: 'conflicts', label: 'Conflicts' },
  { key: 'import', label: 'Import / export' },
  { key: 'dns', label: 'DNS' },
] as const;

export function IpamPage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  if (me?.user.userType === 'customer') return <CustomerIpam />;
  const tab = (params.get('tab') as (typeof TABS)[number]['key']) ?? 'prefixes';
  return (
    <>
      <PageHeader
        title="IP address management"
        description="IPv4 and IPv6 prefixes, pools and address assignments. Allocating an address only records it here; it never configures a router or announces a route."
      />
      <Tabs tabs={TABS} value={tab} label="IPAM sections" onChange={(k) => setParams(k === 'prefixes' ? {} : { tab: k }, { replace: true })} />
      {tab === 'prefixes' && <PrefixesTab />}
      {tab === 'addresses' && <AddressesTab />}
      {tab === 'conflicts' && <ConflictsTab />}
      {tab === 'import' && <ImportTab />}
      {tab === 'dns' && <DnsTab />}
    </>
  );
}

export function UtilBar({ pct, className, label }: { pct: number; className?: string; label: string }) {
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-sunken', className)} role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full', pct >= 90 ? 'bg-crit' : pct >= 75 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 2 : 0, pct))}%` }} />
    </div>
  );
}

function pctLabel(p: number) {
  if (p === 0) return '0%';
  if (p < 0.01) return '<0.01%';
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/* ------------------------------------------------------------------ prefixes */

function PrefixesTab() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const vrfs = useVrfs();
  const [vrf, setVrf] = useState(params.get('vrf') ?? 'global');
  const [family, setFamily] = useState('');
  const [q, setQ] = useState('');
  const [add, setAdd] = useState(false);
  const list = useQuery({
    queryKey: ['ipam', 'prefixes', vrf, family, q],
    queryFn: () => api.get<PrefixT[]>(`/ipam/prefixes${qs({ vrfId: vrf || undefined, family, q })}`),
    placeholderData: keepPreviousData,
  });
  const summary = useQuery({
    queryKey: ['ipam', 'summary'],
    queryFn: () =>
      api.get<{
        prefixes: number;
        allocated: number;
        reserved: number;
        ipv4: { usable: number; used: number; utilization: number };
      }>('/ipam/summary'),
  });
  return (
    <div className="grid gap-5">
      {summary.data && (
        <dl className="glass grid grid-cols-2 gap-4 rounded-2xl p-4 sm:grid-cols-4">
          <Stat label="Prefixes" value={summary.data.prefixes} />
          <Stat label="Allocated addresses" value={summary.data.allocated.toLocaleString('en-IN')} />
          <Stat label="Reserved addresses" value={summary.data.reserved.toLocaleString('en-IN')} />
          <Stat
            label="IPv4 used (active subnets)"
            value={`${summary.data.ipv4.utilization}%`}
            note={`${summary.data.ipv4.used.toLocaleString('en-IN')} of ${summary.data.ipv4.usable.toLocaleString('en-IN')} usable`}
            tone={summary.data.ipv4.utilization >= 90 ? 'crit' : summary.data.ipv4.utilization >= 75 ? 'warn' : undefined}
          />
        </dl>
      )}
      <Panel flush>
        <div className="flex flex-wrap items-end gap-3 border-b border-rule p-4">
          <Field label="VRF">
            {(id) => (
              <Select id={id} className="w-44" value={vrf} onChange={(e) => setVrf(e.target.value)}>
                <option value="global">Global table</option>
                <option value="">All VRFs</option>
                {vrfs.data?.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Family">
            {(id) => (
              <Select id={id} className="w-28" value={family} onChange={(e) => setFamily(e.target.value)}>
                <option value="">Both</option>
                <option value="4">IPv4</option>
                <option value="6">IPv6</option>
              </Select>
            )}
          </Field>
          <Field label="Search">{(id) => <Input id={id} className="w-64" placeholder="Prefix, address, description, customer" value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
          {can('ipam.write') && (
            <Button variant="primary" className="ml-auto" onClick={() => setAdd(true)}>
              Add prefix
            </Button>
          )}
        </div>
        {list.isLoading && <Loading />}
        <ErrorNote error={list.error} className="m-4" />
        {list.data?.length === 0 && <EmptyState title="No prefixes">Add your aggregates (as containers) and the subnets inside them. Addresses can only be assigned inside a prefix.</EmptyState>}
        {!!list.data?.length && <PrefixTable rows={list.data} showVrf={vrf === ''} />}
      </Panel>
      {add && <PrefixForm onClose={() => setAdd(false)} />}
    </div>
  );
}

function PrefixTable({ rows, showVrf }: { rows: PrefixT[]; showVrf?: boolean }) {
  return (
    <Table label="Prefixes">
      <thead>
        <tr>
          <th>Prefix</th>
          {showVrf && <th>VRF</th>}
          <th>Status</th>
          <th>Assigned to</th>
          <th>Location / VLAN</th>
          <th className="w-48">Utilization</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const container = p.status === 'container' || p.childCount > 0;
          const pct = container ? p.childCoverage : p.addressUtilization;
          return (
            <tr key={p.id} className="hover:bg-sunken/60">
              <td style={{ paddingLeft: `${16 + p.depth * 18}px` }} className="whitespace-nowrap">
                {p.depth > 0 && (
                  <span className="mr-1 text-ink-3" aria-hidden>
                    └
                  </span>
                )}
                <Link to={`/ipam/prefixes/${p.id}`} className="font-mono text-[13px] font-medium text-accent hover:underline">
                  {p.prefix}
                </Link>
                {p.isPool && <Chip tone="accent">pool</Chip>}
              </td>
              {showVrf && <td>{p.vrfName ?? 'Global'}</td>}
              <td>
                <Chip tone={p.status === 'active' ? 'ok' : p.status === 'reserved' ? 'est' : p.status === 'deprecated' ? 'warn' : 'neutral'}>{PREFIX_STATUS_LABELS[p.status]}</Chip>
              </td>
              <td>{p.customerName ?? <span className="text-ink-3">—</span>}</td>
              <td className="text-[13px]">{[p.datacenterCode, p.vlan ? `VLAN ${p.vlan.vid}` : null].filter(Boolean).join(' · ') || <span className="text-ink-3">—</span>}</td>
              <td>
                <div className="flex items-center gap-2">
                  <UtilBar pct={pct} label={`${p.prefix} ${container ? 'covered by subnets' : 'addresses used'}`} />
                  <span className="w-14 text-right text-[12.5px] tabular-nums">{pctLabel(pct)}</span>
                </div>
                <div className="text-[11.5px] text-ink-3">
                  {container ? `${p.childCount} subnet${p.childCount === 1 ? '' : 's'}` : `${p.usedAddresses.toLocaleString('en-IN')} of ${big(p.usable)}`}
                </div>
              </td>
              <td className="max-w-[28ch] truncate text-[13px]">{p.description ?? ''}</td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function PrefixForm({ prefix, onClose }: { prefix?: PrefixT; onClose: (id?: string) => void }) {
  const qc = useQueryClient();
  const vrfs = useVrfs();
  const vlans = useVlans();
  const tree = useTree();
  const customers = useCustomerOptions();
  const [f, setF] = useState({
    prefix: s(prefix?.prefix),
    vrfId: s(prefix?.vrfId),
    status: prefix?.status ?? 'active',
    isPool: prefix?.isPool ?? false,
    datacenterId: s(prefix?.datacenterId),
    vlanId: s(prefix?.vlan?.id),
    customerId: s(prefix?.customerId),
    gateway: s(prefix?.gateway),
    description: s(prefix?.description),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const body = () => ({
    status: f.status,
    isPool: f.isPool,
    datacenterId: t(f.datacenterId),
    vlanId: t(f.vlanId),
    customerId: t(f.customerId),
    gateway: t(f.gateway),
    description: t(f.description),
  });
  const m = useMutation({
    mutationFn: () =>
      prefix
        ? api.put<{ id: string }>(`/ipam/prefixes/${prefix.id}`, body())
        : api.post<{ id: string }>('/ipam/prefixes', {
            ...body(),
            prefix: f.prefix,
            vrfId: t(f.vrfId),
          }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['ipam'] });
      onClose(r.id);
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={prefix ? `Edit ${prefix.prefix}` : 'Add prefix'} wide>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Prefix" hint="Network address and length, e.g. 203.0.113.0/24 or 2001:db8:100::/48">
          {(id, d) => <Input id={id} aria-describedby={d} required disabled={!!prefix} value={f.prefix} onChange={set('prefix')} className="font-mono" />}
        </Field>
        <Field label="VRF">
          {(id) => (
            <Select id={id} disabled={!!prefix} value={f.vrfId} onChange={set('vrfId')}>
              <option value="">Global table</option>
              {vrfs.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status" hint="Containers hold subnets; addresses are assigned from active subnets">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={f.status} onChange={set('status')}>
              {PREFIX_STATUSES.map((x) => (
                <option key={x} value={x}>
                  {PREFIX_STATUS_LABELS[x]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Gateway" hint="Excluded from automatic allocation">
          {(id, d) => <Input id={id} aria-describedby={d} value={f.gateway} onChange={set('gateway')} className="font-mono" />}
        </Field>
        <Field label="Customer">
          {(id) => (
            <Select id={id} value={f.customerId} onChange={set('customerId')}>
              <option value="">Not assigned</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
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
        <Field label="VLAN">
          {(id) => (
            <Select id={id} value={f.vlanId} onChange={set('vlanId')}>
              <option value="">None</option>
              {vlans.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.vid} {v.name}
                  {v.datacenterCode ? ` (${v.datacenterCode})` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Description">{(id) => <Input id={id} value={f.description} onChange={set('description')} />}</Field>
        <label className="flex items-center gap-2 text-[13.5px] sm:col-span-2" title="In a pool every address is usable, including the first and last (e.g. NAT pools, /31 links)">
          <input type="checkbox" checked={f.isPool} onChange={(e) => setF((x) => ({ ...x, isPool: e.target.checked }))} /> Pool: every address is usable (no network/broadcast reservation)
        </label>
        <ErrorNote error={m.error} className="sm:col-span-2" />
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={() => onClose()}>
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

export function PrefixDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['ipam', 'prefix', id],
    queryFn: () => api.get<PrefixDetailT>(`/ipam/prefixes/${id}`),
  });
  const [edit, setEdit] = useState(false);
  const [alloc, setAlloc] = useState<'next' | 'specific' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: () => api.delete(`/ipam/prefixes/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['ipam'] });
      navigate('/ipam');
    },
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const p = q.data!;
  const staff = me?.user.userType === 'staff';
  const writable = staff && can('ipam.write');
  const container = p.status === 'container' || p.childCount > 0;
  return (
    <>
      <nav className="mb-2 text-[13px] text-ink-3">
        <Link to="/ipam" className="hover:underline">
          IP address management
        </Link>
        {p.parents.map((x) => (
          <span key={x.id}>
            {' / '}
            <Link to={`/ipam/prefixes/${x.id}`} className="font-mono hover:underline">
              {x.prefix}
            </Link>
          </span>
        ))}
      </nav>
      <PageHeader
        title={p.prefix}
        description={
          <>
            {PREFIX_STATUS_LABELS[p.status]}
            {p.vrfName ? ` · VRF ${p.vrfName}` : ' · global table'}
            {p.customerName ? ` · ${p.customerName}` : ''}
            {p.description ? ` · ${p.description}` : ''}
          </>
        }
        actions={
          writable && (
            <>
              <Button onClick={() => setEdit(true)}>Edit</Button>
              <Button variant="ghost" className="text-crit" onClick={() => setConfirm(true)}>
                Delete
              </Button>
              {!container && p.status !== 'deprecated' && (
                <>
                  <Button onClick={() => setAlloc('specific')}>Assign address</Button>
                  <Button variant="primary" onClick={() => setAlloc('next')}>
                    Allocate next free
                  </Button>
                </>
              )}
            </>
          )
        }
      />
      <div className="grid gap-5">
        <dl className="glass grid grid-cols-2 gap-4 rounded-2xl p-4 sm:grid-cols-5">
          <Stat label="Size" value={big(p.size)} note={p.family === 6 ? 'IPv6 addresses' : 'addresses'} />
          <Stat label="Usable" value={big(p.usable)} note={p.isPool ? 'pool: all usable' : p.family === 4 ? 'minus network and broadcast' : 'minus the subnet-router anycast'} />
          <Stat label="In use" value={p.usedAddresses.toLocaleString('en-IN')} note="allocated, reserved or deprecated" />
          <Stat label={container ? 'Covered by subnets' : 'Utilization'} value={pctLabel(container ? p.childCoverage : p.addressUtilization)} />
          <Stat label="Gateway" value={<span className="font-mono text-[18px]">{p.gateway ?? '—'}</span>} note={p.vlan ? `VLAN ${p.vlan.vid} ${p.vlan.name}` : undefined} />
        </dl>
        {p.children.length > 0 && (
          <Panel title="Subnets" flush>
            <PrefixTable rows={p.children.map((c) => ({ ...c, depth: 0 }))} />
          </Panel>
        )}
        {staff && p.available.length > 0 && (
          <Panel title="Free ranges">
            <ul className="flex flex-wrap gap-2 font-mono text-[12.5px]">
              {p.available.map((r) => (
                <li key={r.first} className="rounded-lg border border-rule bg-sunken px-2 py-1">
                  {r.first === r.last ? r.first : `${r.first} – ${r.last}`} <span className="font-sans text-ink-3">({big(r.count)})</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12.5px] text-ink-3">Reverse DNS zone: {p.ptrZone}</p>
          </Panel>
        )}
        <AddressList prefixId={p.id} />
      </div>
      {edit && <PrefixForm prefix={p} onClose={() => (setEdit(false), qc.invalidateQueries({ queryKey: ['ipam'] }))} />}
      {alloc && <AllocateForm prefix={p} mode={alloc} onClose={() => setAlloc(null)} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${p.prefix}?`}
        body="Refused while it holds addresses that no other prefix covers. Child subnets are not deleted."
        confirmLabel="Delete prefix"
        onConfirm={() => del.mutate()}
        busy={del.isPending}
        error={del.error}
      />
    </>
  );
}

/* ------------------------------------------------------------------ addresses */

function AddressList({ prefixId }: { prefixId?: string }) {
  const { me } = useAuth();
  const [params] = useSearchParams();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState(prefixId ? '' : (params.get('q') ?? ''));
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<AddressT | null>(null);
  const list = useQuery({
    queryKey: ['ipam', 'addresses', prefixId, q, status, page],
    queryFn: () => api.get<Paginated<AddressT>>(`/ipam/addresses${qs({ prefixId, q, status, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });
  const staff = me?.user.userType === 'staff';
  return (
    <Panel flush title={prefixId ? 'Addresses' : undefined}>
      <div className="flex flex-wrap items-end gap-3 border-b border-rule p-4">
        <Field label="Search">
          {(id) => <Input id={id} className="w-72" placeholder="Address, subnet, DNS name, device, customer, service" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />}
        </Field>
        <Field label="Status">
          {(id) => (
            <Select id={id} className="w-40" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
              <option value="">All in use</option>
              {(['allocated', 'reserved', 'deprecated', ...(staff ? (['released'] as const) : [])] as IpStatus[]).map((x) => (
                <option key={x} value={x}>
                  {IP_STATUS_LABELS[x]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {list.isLoading && <Loading />}
      <ErrorNote error={list.error} className="m-4" />
      {list.data?.items.length === 0 && <EmptyState title="No addresses">{prefixId ? 'Nothing assigned in this prefix yet.' : 'Try another search.'}</EmptyState>}
      {!!list.data?.items.length && (
        <>
          <Table label="IP addresses">
            <thead>
              <tr>
                <th>Address</th>
                <th>Status</th>
                <th>DNS name</th>
                <th>Assigned to</th>
                {staff && <th>Service</th>}
                {!prefixId && <th>Prefix</th>}
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((a) => (
                <tr key={a.id} className={cx('hover:bg-sunken/60', staff && 'cursor-pointer')} onClick={() => staff && setOpen(a)}>
                  <td className="font-mono text-[13px] font-medium whitespace-nowrap">
                    {a.address}
                    {a.prefixLength !== null && <span className="text-ink-3">/{a.prefixLength}</span>}
                    {a.vrfName && <Chip>{a.vrfName}</Chip>}
                  </td>
                  <td>
                    <Chip tone={STATUS_TONE[a.status]}>{IP_STATUS_LABELS[a.status]}</Chip>
                    {a.reservationExpired && <Chip tone="warn">expired</Chip>}
                    {a.role && <span className="ml-1 text-[12px] text-ink-3">{a.role}</span>}
                  </td>
                  <td className="text-[13px]">
                    {a.dnsName ?? '—'}
                    {a.dns?.status === 'failed' && (
                      <Chip tone="crit" title={a.dns.error ?? undefined}>
                        DNS failed
                      </Chip>
                    )}
                    {a.dns?.status === 'pending' && <Chip tone="est">DNS pending</Chip>}
                    {a.dns?.status === 'synced' && <Chip tone="ok">in DNS</Chip>}
                  </td>
                  <td className="text-[13px]">
                    {a.deviceName ? (
                      staff ? (
                        <Link to={`/hardware/${a.deviceId}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
                          {a.deviceName}
                        </Link>
                      ) : (
                        a.deviceName
                      )
                    ) : null}
                    {a.interfaceName && <span className="font-mono"> {a.interfaceName}</span>}
                    {a.customerName && <div className="text-ink-3">{a.customerName}</div>}
                    {!a.deviceName && !a.customerName && '—'}
                  </td>
                  {staff && <td className="text-[13px]">{a.serviceRef ?? '—'}</td>}
                  {!prefixId && <td className="font-mono text-[12.5px]">{a.prefix ?? <Chip tone="crit">no prefix</Chip>}</td>}
                  <td className="text-[12.5px] whitespace-nowrap text-ink-3">{formatDateTime(a.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />
        </>
      )}
      {open && <AddressModal address={open} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

function AddressesTab() {
  return <AddressList />;
}

type AssignForm = {
  status: string;
  prefixLength: string;
  role: string;
  dnsName: string;
  reverseDns: string;
  customerId: string;
  deviceId: string;
  interfaceId: string;
  serviceRef: string;
  reservedUntil: string;
  notes: string;
};
const emptyAssign = (a?: AddressT): AssignForm => ({
  status: a?.status === 'released' ? 'allocated' : (a?.status ?? 'allocated'),
  prefixLength: s(a?.prefixLength),
  role: s(a?.role),
  dnsName: s(a?.dnsName),
  reverseDns: s(a?.reverseDns),
  customerId: s(a?.customerId),
  deviceId: s(a?.deviceId),
  interfaceId: s(a?.interfaceId),
  serviceRef: s(a?.serviceRef),
  reservedUntil: a?.reservedUntil ? a.reservedUntil.slice(0, 10) : '',
  notes: s(a?.notes),
});
const assignBody = (f: AssignForm) => ({
  status: f.status,
  prefixLength: f.prefixLength ? Number(f.prefixLength) : null,
  role: t(f.role),
  dnsName: t(f.dnsName),
  reverseDns: t(f.reverseDns),
  customerId: t(f.customerId),
  deviceId: t(f.deviceId),
  interfaceId: t(f.interfaceId),
  serviceRef: t(f.serviceRef),
  reservedUntil: f.status === 'reserved' && f.reservedUntil ? new Date(`${f.reservedUntil}T23:59:59`).toISOString() : null,
  notes: t(f.notes),
});

function AssignFields({ f, setF, allowDeprecated }: { f: AssignForm; setF: (fn: (x: AssignForm) => AssignForm) => void; allowDeprecated?: boolean }) {
  const customers = useCustomerOptions();
  const devices = useQuery({
    queryKey: ['network', 'devices', 'all'],
    queryFn: () => api.get<NetworkDeviceT[]>('/network/devices?all=true'),
  });
  const ports = useQuery({
    queryKey: ['network', 'interfaces', f.deviceId],
    queryFn: () => api.get<InterfaceT[]>(`/network/devices/${f.deviceId}/interfaces`),
    enabled: !!f.deviceId,
  });
  const set = (k: keyof AssignForm) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <>
      <Field label="Status">
        {(id) => (
          <Select id={id} value={f.status} onChange={set('status')}>
            <option value="allocated">Allocated (in use)</option>
            <option value="reserved">Reserved (held for later)</option>
            {allowDeprecated && <option value="deprecated">Deprecated (being retired)</option>}
          </Select>
        )}
      </Field>
      {f.status === 'reserved' ? (
        <Field label="Reserved until" hint="Optional; after this date the address can be allocated again">
          {(id, d) => <Input id={id} aria-describedby={d} type="date" value={f.reservedUntil} onChange={set('reservedUntil')} />}
        </Field>
      ) : (
        <Field label="Role">
          {(id) => (
            <Select id={id} value={f.role} onChange={set('role')}>
              <option value="">—</option>
              {IP_ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label="Device">
        {(id) => (
          <Select id={id} value={f.deviceId} onChange={(e) => setF((x) => ({ ...x, deviceId: e.target.value, interfaceId: '' }))}>
            <option value="">None</option>
            {devices.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {deviceLabel(d)} ({d.assetTag})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Interface">
        {(id) => (
          <Select id={id} value={f.interfaceId} onChange={set('interfaceId')} disabled={!f.deviceId}>
            <option value="">None</option>
            {ports.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Customer" hint="Defaults to the device's or prefix's customer">
        {(id, d) => (
          <Select id={id} aria-describedby={d} value={f.customerId} onChange={set('customerId')}>
            <option value="">—</option>
            {customers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Service reference" hint="e.g. WHMCS service ID">
        {(id, d) => <Input id={id} aria-describedby={d} value={f.serviceRef} onChange={set('serviceRef')} />}
      </Field>
      <Field label="DNS name">{(id) => <Input id={id} value={f.dnsName} onChange={set('dnsName')} placeholder="host.example.com" />}</Field>
      <Field label="Reverse DNS (PTR)">{(id) => <Input id={id} value={f.reverseDns} onChange={set('reverseDns')} />}</Field>
      <Field label="Prefix length on the host" hint="Defaults to the subnet's length">
        {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} max={128} value={f.prefixLength} onChange={set('prefixLength')} />}
      </Field>
      <Field label="Notes">{(id) => <Input id={id} value={f.notes} onChange={set('notes')} />}</Field>
    </>
  );
}

function AllocateForm({ prefix, mode, onClose }: { prefix: PrefixT; mode: 'next' | 'specific'; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<AssignForm>({
    ...emptyAssign(),
    customerId: s(prefix.customerId),
  });
  const [count, setCount] = useState('1');
  const [address, setAddress] = useState('');
  const m = useMutation({
    mutationFn: () =>
      mode === 'next'
        ? api.post<AddressT[]>('/ipam/allocate-next', {
            ...assignBody(f),
            prefixId: prefix.id,
            count: Number(count),
          })
        : api
            .post<AddressT>('/ipam/addresses', {
              ...assignBody(f),
              address,
              vrfId: prefix.vrfId,
            })
            .then((a) => [a]),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ipam'] }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={mode === 'next' ? `Allocate from ${prefix.prefix}` : `Assign an address in ${prefix.prefix}`}
      description="Records the assignment in IPAM only. No device is configured and no route is announced."
      wide
    >
      {m.data ? (
        <div>
          <p className="rounded-lg bg-ok-soft px-3 py-2 text-ok">
            {m.data.length === 1 ? 'Assigned' : `Assigned ${m.data.length} addresses`}: <span className="font-mono">{m.data.map((a) => a.address).join(', ')}</span>
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          {mode === 'next' ? (
            <Field label="How many" hint="Consecutive free addresses are picked lowest-first, skipping the gateway and child subnets">
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={256} required value={count} onChange={(e) => setCount(e.target.value)} />}
            </Field>
          ) : (
            <Field label="Address">{(id) => <Input id={id} required value={address} onChange={(e) => setAddress(e.target.value)} className="font-mono" />}</Field>
          )}
          <div />
          <AssignFields f={f} setF={setF} />
          <ErrorNote error={m.error} className="sm:col-span-2" />
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" busy={m.isPending}>
              {mode === 'next' ? 'Allocate' : 'Assign'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function AddressModal({ address, onClose }: { address: AddressT; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [f, setF] = useState<AssignForm>(emptyAssign(address));
  const [reason, setReason] = useState('');
  const [releasing, setReleasing] = useState(false);
  const history = useQuery({
    queryKey: ['ipam', 'history', address.id],
    queryFn: () =>
      api.get<
        {
          id: number;
          occurredAt: string;
          actorLabel: string | null;
          action: string;
          summary: string;
        }[]
      >(`/ipam/addresses/${address.id}/history`),
  });
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['ipam'] });
    onClose();
  };
  const released = address.status === 'released';
  const save = useMutation({
    mutationFn: () =>
      released
        ? api.post('/ipam/addresses', {
            ...assignBody(f),
            address: address.address,
            vrfId: address.vrfId,
          })
        : api.patch(`/ipam/addresses/${address.id}`, assignBody(f)),
    onSuccess: done,
  });
  const rel = useMutation({
    mutationFn: () =>
      api.post(`/ipam/addresses/${address.id}/release`, {
        reason: t(reason) ?? undefined,
      }),
    onSuccess: done,
  });
  const writable = can('ipam.write');
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={address.address}
      description={`${IP_STATUS_LABELS[address.status]}${address.prefix ? ` in ${address.prefix}` : ''}${address.vrfName ? ` (VRF ${address.vrfName})` : ''}`}
      wide
    >
      {writable ? (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <AssignFields f={f} setF={setF} allowDeprecated={!released} />
          <ErrorNote error={save.error} className="sm:col-span-2" />
          <div className="flex justify-between gap-2 sm:col-span-2">
            <div>
              {!released && (
                <Button type="button" variant="ghost" className="text-crit" onClick={() => setReleasing(true)}>
                  Release
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" busy={save.isPending}>
                {released ? 'Assign again' : 'Save'}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <p className="text-ink-2">Read-only.</p>
      )}
      <AddressDns id={address.id} dns={address.dns} canResync={writable} />
      <div className="mt-5">
        <p className="mb-1 text-[13px] font-semibold">History</p>
        {history.isLoading && <Loading />}
        <ol className="max-h-56 divide-y divide-rule overflow-y-auto">
          {history.data?.map((h) => (
            <li key={h.id} className="py-1.5 text-[13px]">
              {h.summary}
              <span className="block text-[12px] text-ink-3">
                {formatDateTime(h.occurredAt)} · {h.actorLabel ?? 'system'}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <Modal open={releasing} onOpenChange={setReleasing} title={`Release ${address.address}?`} description="The address returns to the free pool. Its assignment is cleared but the history is kept.">
        <Field label="Reason (optional)">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <ErrorNote error={rel.error} className="mt-3" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setReleasing(false)}>
            Cancel
          </Button>
          <Button variant="danger" busy={rel.isPending} onClick={() => rel.mutate()}>
            Release address
          </Button>
        </div>
      </Modal>
    </Modal>
  );
}

/* ------------------------------------------------------------------ conflicts */

function ConflictsTab() {
  const q = useQuery({
    queryKey: ['ipam', 'conflicts'],
    queryFn: () =>
      api.get<{
        checkedAt: string;
        issues: {
          kind: string;
          severity: 'warning' | 'error';
          addressId: string;
          address: string;
          message: string;
        }[];
      }>('/ipam/conflicts'),
  });
  return (
    <Panel flush title="Consistency check" actions={q.data && <span className="text-[12.5px] text-ink-3">Checked {formatDateTime(q.data.checkedAt)}</span>}>
      <p className="border-b border-rule px-4 py-3 text-[13px] text-ink-2">Records that need attention. Nothing here is changed automatically; open the address to fix it.</p>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} className="m-4" />
      {q.data?.issues.length === 0 && <EmptyState title="No problems found" />}
      {!!q.data?.issues.length && (
        <Table label="IPAM issues">
          <thead>
            <tr>
              <th>Address</th>
              <th>Severity</th>
              <th>Problem</th>
            </tr>
          </thead>
          <tbody>
            {q.data.issues.map((i) => (
              <tr key={i.kind + i.addressId}>
                <td className="font-mono text-[13px]">
                  <Link className="text-accent hover:underline" to={`/ipam?tab=addresses&q=${encodeURIComponent(i.address)}`}>
                    {i.address}
                  </Link>
                </td>
                <td>
                  <Chip tone={i.severity === 'error' ? 'crit' : 'warn'}>{i.severity}</Chip>
                </td>
                <td>{i.message}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ import / export */

interface ImportResultT {
  dryRun: boolean;
  total: number;
  created: number;
  failed: number;
  results: { line: number; key: string; ok: boolean; message: string }[];
}

function ImportTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'prefixes' | 'addresses'>('prefixes');
  const [csv, setCsv] = useState('');
  const m = useMutation({
    mutationFn: (dryRun: boolean) => api.post<ImportResultT>('/ipam/import', { kind, csv, dryRun }),
    onSuccess: (r) => !r.dryRun && qc.invalidateQueries({ queryKey: ['ipam'] }),
  });
  const headers =
    kind === 'prefixes'
      ? 'prefix,vrf,status,is_pool,datacenter,vlan,customer_code,gateway,description'
      : 'address,vrf,status,prefix_length,role,dns_name,reverse_dns,customer_code,device,interface,service_ref,reserved_until,notes';
  return (
    <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
      <Panel title="Import from CSV">
        {!can('ipam.write') ? (
          <p className="text-ink-2">You need the “Allocate and release IP addresses” permission to import.</p>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Import">
                {(id) => (
                  <Select id={id} className="w-40" value={kind} onChange={(e) => (setKind(e.target.value as 'prefixes' | 'addresses'), m.reset())}>
                    <option value="prefixes">Prefixes</option>
                    <option value="addresses">Addresses</option>
                  </Select>
                )}
              </Field>
              <label className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-rule-strong bg-field px-3.5 font-medium hover:bg-panel">
                Choose CSV file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setCsv(await file.text());
                      m.reset();
                    }
                  }}
                />
              </label>
            </div>
            <p className="text-[12.5px] text-ink-3">
              Columns: <span className="font-mono">{headers}</span>. Only the first column is required. Devices are matched by asset tag, customers by code, VRFs by name. Prefixes are imported
              shortest first, so parents can be in the same file.
            </p>
            <Textarea aria-label="CSV content" className="min-h-48 font-mono text-[12.5px]" value={csv} onChange={(e) => (setCsv(e.target.value), m.reset())} placeholder={`${headers}\n`} />
            <div className="flex gap-2">
              <Button disabled={!csv.trim()} busy={m.isPending && m.variables === true} onClick={() => m.mutate(true)}>
                Check file
              </Button>
              <Button variant="primary" disabled={!m.data?.dryRun || m.data.created === 0} busy={m.isPending && m.variables === false} onClick={() => m.mutate(false)}>
                Import {m.data?.dryRun ? `${m.data.created} valid row${m.data.created === 1 ? '' : 's'}` : ''}
              </Button>
            </div>
            <ErrorNote error={m.error} />
            {m.data && (
              <div>
                <p className={cx('rounded-lg px-3 py-2', m.data.failed ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok')}>
                  {m.data.dryRun ? 'Check:' : 'Imported:'} {m.data.created} of {m.data.total} row{m.data.total === 1 ? '' : 's'} {m.data.dryRun ? 'would be created' : 'created'}
                  {m.data.failed ? `, ${m.data.failed} with problems (${m.data.dryRun ? 'they will be skipped' : 'skipped'})` : ''}.
                </p>
                {m.data.failed > 0 && (
                  <ul className="mt-2 max-h-60 overflow-y-auto text-[13px]">
                    {m.data.results
                      .filter((r) => !r.ok)
                      .map((r) => (
                        <li key={r.line} className="border-t border-rule py-1">
                          Line {r.line} <span className="font-mono">{r.key}</span>: {r.message}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </Panel>
      <Panel title="Export">
        <p className="mb-3 text-[13px] text-ink-2">CSV in the same format as the import.</p>
        <div className="flex flex-col gap-2">
          <a className="text-accent hover:underline" href="/api/v1/ipam/export.csv?kind=prefixes">
            Download prefixes.csv
          </a>
          <a className="text-accent hover:underline" href="/api/v1/ipam/export.csv?kind=addresses">
            Download addresses.csv
          </a>
        </div>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ customer view */

function CustomerIpam() {
  const prefixes = useQuery({
    queryKey: ['ipam', 'prefixes', 'mine'],
    queryFn: () => api.get<PrefixT[]>('/ipam/prefixes'),
  });
  return (
    <>
      <PageHeader title="Your IP addresses" description="Subnets and addresses assigned to your account." />
      <div className="grid gap-5">
        <Panel flush title="Subnets">
          {prefixes.isLoading && <Loading />}
          <ErrorNote error={prefixes.error} className="m-4" />
          {prefixes.data?.length === 0 && <EmptyState title="No subnets assigned" />}
          {!!prefixes.data?.length && (
            <Table label="Your subnets">
              <thead>
                <tr>
                  <th>Subnet</th>
                  <th>Gateway</th>
                  <th>VLAN</th>
                  <th className="w-48">In use</th>
                </tr>
              </thead>
              <tbody>
                {prefixes.data.map((p) => (
                  <tr key={p.id}>
                    <td className="font-mono font-medium">{p.prefix}</td>
                    <td className="font-mono">{p.gateway ?? '—'}</td>
                    <td>{p.vlan ? p.vlan.vid : '—'}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <UtilBar pct={p.addressUtilization} label={`${p.prefix} addresses used`} />
                        <span className="text-[12.5px] tabular-nums whitespace-nowrap">
                          {p.usedAddresses} / {big(p.usable)}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        <AddressList />
      </div>
    </>
  );
}
