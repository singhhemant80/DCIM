import { useState, type ReactNode } from 'react';
import { SERVICE_KIND_LABELS, type ServiceKind } from '@crapplet/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { Customer, UserRow } from '../lib/types';
import { watts, type AllocationT, type CrossConnectT, type ServiceT, type TicketT } from '../lib/colocation';
import type { PortRateT } from '../lib/monitoring';
import { formatBps } from '../lib/network';
import type { AddressT, PrefixT } from './Ipam';
import { CustomerEquipment } from './Hardware';
import { CustomerForm } from './Customers';
import { TopIps } from '../components/TopIps';
import { Button, Chip, ErrorNote, Loading, Modal, PageHeader, Panel, Table } from '../components/ui';

interface SummaryT {
  devices: number;
  servers: number;
  ips: number;
  prefixes: number;
  allocations: number;
  allocatedU: number;
  contractedPowerW: number;
  crossConnects: number;
  services: number;
  openTickets: number;
  users: number;
}

const STATUS_TONE = { active: 'ok', suspended: 'warn', closed: 'neutral' } as const;
const STATUS_LABEL = { active: 'Active', suspended: 'Suspended', closed: 'Closed' } as const;
const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const none = <span className="text-ink-3">—</span>;

/** A list section that renders nothing but a short line when empty, so the page stays scannable. */
function Section<T>({ title, q, empty, more, children }: { title: string; q: { data?: T[]; isLoading: boolean; error: unknown }; empty: string; more?: ReactNode; children: (rows: T[]) => ReactNode }) {
  const rows = q.data ?? [];
  return (
    <Panel title={`${title}${q.data ? ` (${rows.length})` : ''}`} flush actions={more}>
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} className="m-4" />
      {q.data && rows.length === 0 && <p className="px-4 py-3 text-[13px] text-ink-2">{empty}</p>}
      {rows.length > 0 && children(rows)}
    </Panel>
  );
}

const more = (to: string, text = 'Open list') => (
  <Link to={to} className="text-[13px] text-accent hover:underline">
    {text}
  </Link>
);

/** Staff: everything assigned to one customer on one page. */
export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [allIps, setAllIps] = useState(false);
  const c = useQuery({ queryKey: ['customers', 'detail', id], queryFn: () => api.get<Customer>(`/customers/${id}`) });
  const sum = useQuery({ queryKey: ['customers', 'summary', id], queryFn: () => api.get<SummaryT>(`/customers/${id}/summary`) });
  const on = (perm: string) => can(perm);
  const ips = useQuery({ queryKey: ['customers', id, 'ips'], enabled: on('ipam.read'), queryFn: async () => (await api.get<Paginated<AddressT>>(`/ipam/addresses${qs({ customerId: id, pageSize: 200 })}`)).items });
  const prefixes = useQuery({ queryKey: ['customers', id, 'prefixes'], enabled: on('ipam.read'), queryFn: () => api.get<PrefixT[]>(`/ipam/prefixes${qs({ customerId: id })}`) });
  const allocations = useQuery({ queryKey: ['customers', id, 'alloc'], enabled: on('services.read'), queryFn: () => api.get<AllocationT[]>(`/colocation/allocations${qs({ customerId: id })}`) });
  const xcs = useQuery({ queryKey: ['customers', id, 'xc'], enabled: on('services.read'), queryFn: () => api.get<CrossConnectT[]>(`/colocation/cross-connects${qs({ customerId: id })}`) });
  const services = useQuery({ queryKey: ['customers', id, 'services'], enabled: on('services.read'), queryFn: async () => (await api.get<Paginated<ServiceT>>(`/services${qs({ customerId: id, pageSize: 200 })}`)).items });
  const tickets = useQuery({ queryKey: ['customers', id, 'tickets'], enabled: on('tickets.read'), queryFn: async () => (await api.get<Paginated<TicketT>>(`/tickets${qs({ customerId: id, status: 'open', pageSize: 50 })}`)).items });
  const ports = useQuery({
    queryKey: ['customers', id, 'ports'],
    enabled: on('monitoring.read'),
    refetchInterval: 60_000,
    queryFn: async () => (await api.get<Paginated<PortRateT & { peer: string | null }>>(`/monitoring/ports${qs({ customerId: id, pageSize: 100 })}`)).items,
  });
  const users = useQuery({ queryKey: ['customers', id, 'users'], enabled: on('users.read'), queryFn: async () => (await api.get<Paginated<UserRow>>(`/users${qs({ customerId: id, pageSize: 100 })}`)).items });

  if (c.isLoading) return <Loading />;
  if (c.error || !c.data) return <ErrorNote error={c.error ?? new Error('Customer not found')} />;
  const cu = c.data;
  const s = sum.data;
  const tiles: [string, ReactNode, string?, string?][] = s
    ? [
        ['Servers', s.servers, s.devices !== s.servers ? `${s.devices} devices in all` : undefined],
        ['IP addresses', s.ips, s.prefixes ? `${s.prefixes} prefix${s.prefixes === 1 ? '' : 'es'}` : undefined],
        ['Rack space', s.allocatedU ? `${s.allocatedU} U` : '—', s.allocations ? `${s.allocations} allocation${s.allocations === 1 ? '' : 's'}, ${watts(s.contractedPowerW)} contracted` : undefined],
        ['Cross-connects', s.crossConnects],
        ['Services', s.services, 'pending, active or suspended'],
        ['Open tickets', s.openTickets, undefined, s.openTickets ? '#tickets' : undefined],
        ['Portal users', s.users],
      ]
    : [];
  const inTraffic = (ports.data ?? []).reduce((a, p) => a + (p.inBps ?? 0), 0);
  const outTraffic = (ports.data ?? []).reduce((a, p) => a + (p.outBps ?? 0), 0);

  return (
    <>
      <p className="mb-1 text-[13px]">
        <Link to="/customers" className="text-accent hover:underline">
          Customers
        </Link>
      </p>
      <PageHeader
        title={cu.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{cu.code}</span>
            <Chip tone={STATUS_TONE[cu.status]}>{STATUS_LABEL[cu.status]}</Chip>
            <span className="text-ink-3">Customer since {formatDateTime(cu.createdAt).split(',')[0]}</span>
          </span>
        }
        actions={
          <span className="flex flex-wrap gap-2">
            {deviceIds.length > 0 && (
              <Link to={`/hardware/sheets?ids=${deviceIds.slice(0, 100).join(',')}`}>
                <Button>Print datasheets ({Math.min(deviceIds.length, 100)})</Button>
              </Link>
            )}
            {can('customers.write') && (
              <Button variant="primary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
          </span>
        }
      />

      {s && (
        <div className="mb-5 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-rule bg-rule sm:grid-cols-4 xl:grid-cols-7 [&>*:last-child:nth-child(odd)]:col-span-2 sm:[&>*:last-child:nth-child(odd)]:col-span-1">
          {tiles.map(([k, v, note, href]) => (
            <div key={k} className="bg-panel px-4 py-3">
              <p className="text-[12.5px] text-ink-2">{k}</p>
              <p className="text-[21px] font-semibold tracking-[-0.01em]">{href ? <a href={href} className="text-accent hover:underline">{v}</a> : v}</p>
              {note && <p className="text-[12px] text-ink-3">{note}</p>}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 [&>*]:min-w-0">
        <Panel title="Contact and account">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ['Contact email', cu.contactEmail ? <a href={`mailto:${cu.contactEmail}`} className="text-accent hover:underline">{cu.contactEmail}</a> : null],
                ['Phone', cu.phone ? <a href={`tel:${cu.phone}`} className="text-accent hover:underline">{cu.phone}</a> : null],
                ['Billing reference', cu.billingReference],
                ['Last changed', formatDateTime(cu.updatedAt)],
              ] as [string, ReactNode][]
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-[12.5px] text-ink-2">{k}</dt>
                <dd className="mt-0.5">{v ?? none}</dd>
              </div>
            ))}
          </dl>
          {cu.notes && (
            <div className="mt-4 rounded-lg bg-sunken px-3 py-2 text-[13px]">
              <p className="text-[12px] font-medium text-ink-2">Internal notes (staff only)</p>
              <p className="whitespace-pre-wrap">{cu.notes}</p>
            </div>
          )}
        </Panel>

        {can('dcim.read') && <CustomerEquipment embedded customerId={id} onIds={setDeviceIds} />}

        {can('monitoring.read') && (
          <Section
            title="Network ports and bandwidth"
            q={ports}
            empty="No monitored ports are cabled to this customer's equipment."
            more={ports.data?.length ? <span className="text-[13px] text-ink-2">Now: in {formatBps(inTraffic)} · out {formatBps(outTraffic)}</span> : undefined}
          >
            {(rows) => (
              <Table label="Ports">
                <thead>
                  <tr>
                    <th>Port</th>
                    <th>Connected to</th>
                    <th>Link</th>
                    <th className="text-right">In</th>
                    <th className="text-right">Out</th>
                    <th className="text-right">Utilization</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.interfaceId}>
                      <td className="whitespace-nowrap">
                        <Link to={`/network-monitoring?port=${p.interfaceId}`} className="font-medium text-accent hover:underline">
                          {p.name}
                        </Link>
                        <span className="block text-[12px] text-ink-3">{p.deviceName}</span>
                      </td>
                      <td className="text-[13px]">{p.peer ?? none}</td>
                      <td>{p.operUp === null ? none : <Chip tone={p.operUp ? 'ok' : 'crit'}>{p.operUp ? 'Up' : 'Down'}</Chip>}</td>
                      <td className="text-right whitespace-nowrap">{p.fresh ? formatBps(p.inBps) : none}</td>
                      <td className="text-right whitespace-nowrap">{p.fresh ? formatBps(p.outBps) : none}</td>
                      <td className="text-right whitespace-nowrap">{p.fresh && (p.utilIn !== null || p.utilOut !== null) ? `${Math.round(Math.max(p.utilIn ?? 0, p.utilOut ?? 0))}%` : none}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        )}

        {can('monitoring.read') && (
          <section>
            <h2 className="mb-2 text-[14px] font-semibold">Bandwidth by IP address</h2>
            <TopIps customerId={id} />
          </section>
        )}

        {can('ipam.read') && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] [&>*]:min-w-0">
            <Section
              title="IP addresses"
              q={ips}
              empty="No IP addresses are assigned to this customer."
              more={(ips.data?.length ?? 0) > 12 && <button className="text-[13px] text-accent hover:underline" onClick={() => setAllIps((v) => !v)}>{allIps ? 'Show fewer' : `Show all ${ips.data?.length}`}</button>}
            >
              {(rows) => (
                <Table label="IP addresses">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>Device</th>
                      <th>DNS name</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(allIps ? rows : rows.slice(0, 12)).map((a) => (
                      <tr key={a.id}>
                        <td className="whitespace-nowrap font-mono text-[13px]">
                          {a.address}
                          {a.prefixLength !== null && <span className="text-ink-3">/{a.prefixLength}</span>}
                          {a.role && <span className="ml-2 font-sans text-[12px] text-ink-3">{label(a.role)}</span>}
                        </td>
                        <td>{a.deviceId ? <Link to={`/hardware/${a.deviceId}`} className="text-accent hover:underline">{a.deviceName}</Link> : none}</td>
                        <td className="text-[13px] text-ink-2">{a.dnsName ?? none}</td>
                        <td>
                          <Chip tone={a.status === 'allocated' ? 'ok' : a.status === 'reserved' ? 'accent' : 'neutral'}>{label(a.status)}</Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>
            <Section title="Prefixes" q={prefixes} empty="No prefixes are assigned to this customer.">
              {(rows) => (
                <Table label="Prefixes">
                  <thead>
                    <tr>
                      <th>Prefix</th>
                      <th className="text-right">Used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link to={`/ipam/prefixes/${p.id}`} className="font-mono text-[13px] text-accent hover:underline">
                            {p.prefix}
                          </Link>
                          {p.description && <span className="block text-[12px] text-ink-3">{p.description}</span>}
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {p.usedAddresses} / {p.usable}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>
          </div>
        )}

        {can('services.read') && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
            <Section title="Rack space" q={{ ...allocations, data: allocations.data?.filter((a) => a.active) }} empty="No rack space is allocated to this customer." more={more('/colocation')}>
              {(rows) => (
                <Table label="Rack space">
                  <thead>
                    <tr>
                      <th>Rack</th>
                      <th>Space</th>
                      <th className="text-right">Power use / contract</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => (
                      <tr key={a.id}>
                        <td className="whitespace-nowrap">
                          <Link to={`/racks/${a.rackId}`} className="text-accent hover:underline">
                            {a.datacenterCode} {a.rackName}
                          </Link>
                          <span className="block text-[12px] text-ink-3">{a.roomName}</span>
                        </td>
                        <td className="whitespace-nowrap">
                          {label(a.kind)} · U{a.startU}–{a.endU} <span className="text-ink-3">({a.units} U)</span>
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {a.power ? watts(a.power.measuredW + a.power.estimatedW) : '—'} / {watts(a.contractedPowerW)}
                          {a.power?.overContract && (
                            <span className="ml-2">
                              <Chip tone="crit">Over contract</Chip>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>
            <Section title="Cross-connects" q={{ ...xcs, data: xcs.data?.filter((x) => x.status !== 'decommissioned' && x.status !== 'rejected') }} empty="No cross-connects." more={more('/colocation?tab=cross-connects')}>
              {(rows) => (
                <Table label="Cross-connects">
                  <thead>
                    <tr>
                      <th>A end → Z end</th>
                      <th>Media</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => (
                      <tr key={x.id}>
                        <td className="text-[13px]">
                          {x.aLabel} → {x.zLabel}
                          {x.loaReference && <span className="block text-[12px] text-ink-3">LOA {x.loaReference}</span>}
                        </td>
                        <td className="whitespace-nowrap text-[13px]">
                          {x.media}
                          {x.speed ? ` · ${x.speed}` : ''}
                        </td>
                        <td>
                          <Chip tone={x.status === 'active' ? 'ok' : 'warn'}>{label(x.status)}</Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 [&>*]:min-w-0">
          {can('services.read') && (
            <Section title="Services" q={{ ...services, data: services.data?.filter((x) => ['pending', 'active', 'suspended'].includes(x.status)) }} empty="No current services." more={more(`/services?customerId=${id}`)}>
              {(rows) => (
                <Table label="Services">
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Since</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => (
                      <tr key={x.id}>
                        <td>
                          <span className="font-medium">{x.name}</span>
                          <span className="block text-[12px] text-ink-3">
                            {SERVICE_KIND_LABELS[x.kind as ServiceKind] ?? label(x.kind)}
                            {x.deviceName ? ` · ${x.deviceName}` : ''}
                          </span>
                        </td>
                        <td className="whitespace-nowrap text-ink-2">{x.startDate ?? none}</td>
                        <td>
                          <Chip tone={x.status === 'active' ? 'ok' : x.status === 'suspended' ? 'warn' : 'neutral'}>{label(x.status)}</Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Section>
          )}
          {can('tickets.read') && (
            <div id="tickets">
              <Section title="Open tickets" q={tickets} empty="No open tickets." more={more(`/tickets?customerId=${id}`, 'All tickets')}>
                {(rows) => (
                  <Table label="Open tickets">
                    <thead>
                      <tr>
                        <th>Ticket</th>
                        <th>Priority</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <Link to={`/tickets/${t.id}`} className="font-medium text-accent hover:underline">
                              #{t.number} {t.subject}
                            </Link>
                            <span className="block text-[12px] text-ink-3">Opened {formatDateTime(t.createdAt)}</span>
                          </td>
                          <td>
                            <Chip tone={t.priority === 'urgent' ? 'crit' : t.priority === 'high' ? 'warn' : 'neutral'}>{label(t.priority)}</Chip>
                          </td>
                          <td className="text-[13px]">{label(t.status)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Section>
            </div>
          )}
        </div>

        {can('users.read') && (
          <Section title="Portal users" q={users} empty="No portal users yet." more={more(`/users?customerId=${id}`, 'Manage users')}>
            {(rows) => (
              <Table label="Portal users">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Role</th>
                    <th>Two-factor</th>
                    <th>Last sign-in</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <span className="font-medium">{u.name}</span>
                        <span className="block text-[12px] text-ink-3">{u.email}</span>
                      </td>
                      <td className="text-[13px]">{u.roles.map((r) => r.name).join(', ') || none}</td>
                      <td>{u.mfaEnabled ? <Chip tone="ok">On</Chip> : <Chip tone="warn">Off</Chip>}</td>
                      <td className="whitespace-nowrap text-ink-2">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</td>
                      <td>
                        <Chip tone={u.status === 'active' && !u.locked ? 'ok' : 'warn'}>{u.locked ? 'Locked' : u.status === 'active' ? 'Active' : 'Disabled'}</Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
        )}
      </div>

      <Modal wide open={editing} onOpenChange={setEditing} title={`Edit ${cu.name}`}>
        {editing && <CustomerForm customer={cu} onClose={() => setEditing(false)} />}
      </Modal>
    </>
  );
}
