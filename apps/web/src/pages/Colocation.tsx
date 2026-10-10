import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ALLOCATION_KIND_LABELS,
  CROSS_CONNECT_MEDIA,
  CROSS_CONNECT_MEDIA_LABELS,
  CROSS_CONNECT_STATUS_LABELS,
  CROSS_CONNECT_TRANSITIONS,
  POWER_FEED_LABELS,
  SHIPMENT_STATUS_LABELS,
  VISIT_STATUS_LABELS,
  allocationRange,
  formatBitRate,
  type AllocationKind,
  type CrossConnectStatus,
} from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { useCustomerDevices, useCustomerOptions, useSites, watts, type AllocationT, type CrossConnectT, type OverviewT, type ShipmentT, type VisitT } from '../lib/colocation';
import { Button, Chip, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Stat, Table, Textarea, cx } from '../components/ui';
import { Tabs } from './Network';

type Tone = 'ok' | 'warn' | 'crit' | 'est' | 'neutral' | 'accent';
const today = () => new Date().toISOString().slice(0, 10);

function useRole() {
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  return { staff, manage: staff && can('services.write'), request: staff ? can('services.write') : can('tickets.write') };
}

function CustomerSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const c = useCustomerOptions();
  return (
    <Field label="Customer">
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} required>
          <option value="">Choose…</option>
          {c.data?.items
            .filter((x) => x.status === 'active')
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({x.code})
              </option>
            ))}
        </Select>
      )}
    </Field>
  );
}

function SiteSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const s = useSites();
  return (
    <Field label="Datacenter">
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} required>
          <option value="">Choose…</option>
          {s.data?.map((x) => (
            <option key={x.id} value={x.id}>
              {x.code} · {x.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 flex justify-end gap-2">{children}</div>;
}

/* ================================================================== overview */

function PowerBar({ measured, estimated, contracted }: { measured: number; estimated: number; contracted: number }) {
  const top = Math.max(contracted, measured + estimated, 1);
  const over = measured > contracted && contracted > 0;
  return (
    <div className="flex flex-col gap-1">
      <span className="relative flex h-2 w-full min-w-28 overflow-hidden rounded-full bg-sunken" title={`${watts(measured)} measured, ${watts(estimated)} estimated of ${watts(contracted)} contracted`}>
        <span className={cx('h-full', over ? 'bg-crit' : 'bg-accent')} style={{ width: `${(measured / top) * 100}%` }} />
        <span className="h-full bg-est opacity-60" style={{ width: `${(estimated / top) * 100}%` }} />
        {contracted > 0 && <span className="absolute top-0 h-full w-0.5 bg-ink" style={{ left: `${Math.min(99.5, (contracted / top) * 100)}%` }} aria-hidden />}
      </span>
      <span className="text-[12px] text-ink-3">
        {watts(measured)} measured{estimated > 0 && <span className="text-est"> + {watts(estimated)} estimated</span>} of {watts(contracted)}
      </span>
    </div>
  );
}

function OverviewPanel() {
  const { staff } = useRole();
  const q = useQuery({ queryKey: ['colo', 'overview'], queryFn: () => api.get<OverviewT>('/colocation/overview'), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const o = q.data!;
  return (
    <Panel className="mb-5">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={staff ? 'Allocated space' : 'Your space'} value={`${o.units}U`} note={`${o.allocations} allocation${o.allocations === 1 ? '' : 's'}`} />
        <Stat label="Contracted power" value={watts(o.contractedPowerW)} />
        <Stat
          label="Measured now"
          value={watts(o.measuredW)}
          tone={o.overContract.length ? 'crit' : undefined}
          note={
            <>
              {o.estimatedW > 0 ? <span className="text-est">+ {watts(o.estimatedW)} estimated (not measured)</span> : 'No estimates included'}
              {o.unknownDevices > 0 && `, ${o.unknownDevices} device(s) unknown`}
            </>
          }
        />
        <Stat
          label={staff ? 'Uplink traffic now' : 'Your bandwidth now'}
          value={o.bandwidth?.inBps != null ? `↓ ${formatBitRate(o.bandwidth.inBps)}` : '—'}
          note={o.bandwidth?.outBps != null ? `↑ ${formatBitRate(o.bandwidth.outBps)} · ${o.bandwidth.freshPorts} port${o.bandwidth.freshPorts === 1 ? '' : 's'} measured` : o.bandwidth?.ports ? 'No fresh port data' : 'No monitored ports'}
        />
        <Stat
          label="Open requests"
          value={o.open.crossConnects + o.open.shipments + o.open.visits + o.open.tickets}
          note={`${o.open.tickets} ticket${o.open.tickets === 1 ? '' : 's'}, ${o.open.crossConnects} cross-connect${o.open.crossConnects === 1 ? '' : 's'}, ${o.open.shipments} shipment${o.open.shipments === 1 ? '' : 's'}, ${o.open.visits} visit${o.open.visits === 1 ? '' : 's'}`}
        />
      </dl>
      {o.overContract.length > 0 && (
        <p className="mt-4 rounded-md bg-crit-soft px-3 py-2 text-[13px] text-crit">
          Measured draw above contracted power: {o.overContract.map((x) => `${staff ? `${x.customerName} · ` : ''}${x.datacenterCode} ${x.rackName}`).join('; ')}
        </p>
      )}
      {o.mayExceed.length > 0 && (
        <p className="mt-2 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
          Above contracted power only if estimates are counted (not confirmed by measurement): {o.mayExceed.map((x) => `${staff ? `${x.customerName} · ` : ''}${x.datacenterCode} ${x.rackName}`).join('; ')}
        </p>
      )}
      <p className="mt-4 text-[12.5px] text-ink-3">
        Power is the equipment in each allocated space: measured where a BMC or PDU reports it, otherwise the device's estimate (shown separately).{' '}
        <Link className="text-accent hover:underline" to="/power">
          Power details
        </Link>{' '}
        ·{' '}
        <Link className="text-accent hover:underline" to="/network-monitoring">
          Bandwidth details
        </Link>
      </p>
    </Panel>
  );
}

/* ================================================================== allocations */

function AllocationDialog({ current, onClose }: { current: AllocationT | null; onClose: () => void }) {
  const qc = useQueryClient();
  const racks = useQuery({ queryKey: ['dcim', 'racks', 'all'], queryFn: () => api.get<{ id: string; name: string; uHeight: number; status: string; location: { datacenterCode: string; roomName: string } }[]>('/dcim/racks'), enabled: !current });
  const services = useQuery({ queryKey: ['services', 'for', current?.customerId], queryFn: () => api.get<{ items: { id: string; name: string; customerId: string; status: string }[] }>(`/services?pageSize=200`) });
  const [customerId, setCustomerId] = useState(current?.customerId ?? '');
  const [rackId, setRackId] = useState(current?.rackId ?? '');
  const [kind, setKind] = useState<AllocationKind>(current?.kind ?? 'half');
  const [part, setPart] = useState(String(current?.part ?? 1));
  const [startU, setStartU] = useState(String(current?.startU ?? 1));
  const [endU, setEndU] = useState(String(current?.endU ?? 10));
  const [power, setPower] = useState(String(current?.contractedPowerW ?? 2000));
  const [feeds, setFeeds] = useState<'single' | 'a_b'>(current?.feeds ?? 'a_b');
  const [amps, setAmps] = useState(String(current?.breakerAmps ?? 16));
  const [volts, setVolts] = useState(String(current?.voltage ?? 230));
  const [start, setStart] = useState(today());
  const [serviceId, setServiceId] = useState(current?.serviceId ?? '');
  const [notes, setNotes] = useState(current?.notes ?? '');
  const rack = racks.data?.find((r) => r.id === rackId);
  const range = rack ? allocationRange(kind, rack.uHeight, Number(part), Number(startU), Number(endU)) : null;
  const n = (v: string) => (v.trim() ? Number(v) : null);
  const m = useMutation({
    mutationFn: () =>
      current
        ? api.put(`/colocation/allocations/${current.id}`, { serviceId: serviceId || null, contractedPowerW: Number(power), feeds, breakerAmps: n(amps), voltage: n(volts), notes: notes || null })
        : api.post('/colocation/allocations', {
            customerId,
            rackId,
            kind,
            part: kind === 'half' || kind === 'quarter' ? Number(part) : null,
            startU: kind === 'custom' ? Number(startU) : null,
            endU: kind === 'custom' ? Number(endU) : null,
            contractedPowerW: Number(power),
            feeds,
            breakerAmps: n(amps),
            voltage: n(volts),
            startDate: start,
            serviceId: serviceId || null,
            notes: notes || null,
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['colo'] });
      onClose();
    },
  });
  const custServices = (services.data?.items ?? []).filter((s) => s.customerId === (current?.customerId ?? customerId) && s.status !== 'cancelled' && s.status !== 'terminated');
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={current ? `Edit allocation · ${current.customerName}` : 'Allocate rack space'} description={current ? undefined : 'The units are held for the customer: other customers’ equipment cannot be placed there.'} wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {!current && (
          <>
            <CustomerSelect value={customerId} onChange={setCustomerId} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Rack">
                {(id) => (
                  <Select id={id} value={rackId} onChange={(e) => setRackId(e.target.value)} required>
                    <option value="">Choose…</option>
                    {racks.data
                      ?.filter((r) => r.status === 'active')
                      .map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.location.datacenterCode} · {r.location.roomName} · {r.name} ({r.uHeight}U)
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
              <Field label="Space">
                {(id) => (
                  <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as AllocationKind)}>
                    {(Object.keys(ALLOCATION_KIND_LABELS) as AllocationKind[]).map((k) => (
                      <option key={k} value={k}>
                        {ALLOCATION_KIND_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            {(kind === 'half' || kind === 'quarter') && (
              <Field label={kind === 'half' ? 'Which half' : 'Which quarter (from the bottom)'}>
                {(id) => (
                  <Select id={id} value={part} onChange={(e) => setPart(e.target.value)}>
                    {(kind === 'half' ? ['1', '2'] : ['1', '2', '3', '4']).map((x) => (
                      <option key={x} value={x}>
                        {kind === 'half' ? (x === '1' ? 'Lower half' : 'Upper half') : `Quarter ${x}`}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {kind === 'custom' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="First unit">{(id) => <Input id={id} inputMode="numeric" value={startU} onChange={(e) => setStartU(e.target.value.replace(/\D/g, ''))} />}</Field>
                <Field label="Last unit">{(id) => <Input id={id} inputMode="numeric" value={endU} onChange={(e) => setEndU(e.target.value.replace(/\D/g, ''))} />}</Field>
              </div>
            )}
            {rack && <p className="text-[13px] text-ink-2">{range ? `U${range.startU}–U${range.endU} (${range.endU - range.startU + 1} units) of ${rack.uHeight}U` : 'That range does not fit this rack'}</p>}
          </>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Contracted power (W)">{(id) => <Input id={id} inputMode="numeric" value={power} onChange={(e) => setPower(e.target.value.replace(/\D/g, ''))} required />}</Field>
          <Field label="Feeds">
            {(id) => (
              <Select id={id} value={feeds} onChange={(e) => setFeeds(e.target.value as 'single' | 'a_b')}>
                {(['single', 'a_b'] as const).map((f) => (
                  <option key={f} value={f}>
                    {POWER_FEED_LABELS[f]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Breaker (A)">{(id) => <Input id={id} inputMode="numeric" value={amps} onChange={(e) => setAmps(e.target.value.replace(/\D/g, ''))} />}</Field>
          <Field label="Voltage (V)">{(id) => <Input id={id} inputMode="numeric" value={volts} onChange={(e) => setVolts(e.target.value.replace(/\D/g, ''))} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {!current && <Field label="Starts">{(id) => <Input id={id} type="date" value={start} onChange={(e) => setStart(e.target.value)} required />}</Field>}
          <Field label="Service (optional)">
            {(id) => (
              <Select id={id} value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                <option value="">None</option>
                {custServices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Notes (staff only)">{(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <ErrorNote error={m.error} />
        <Actions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!current && (!range || !customerId)}>
            {current ? 'Save' : 'Allocate'}
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}

function EndAllocationDialog({ a, onClose }: { a: AllocationT; onClose: () => void }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api.post<{ devicesRemaining: number }>(`/colocation/allocations/${a.id}/end`, { endDate: date, reason: reason || null }), onSuccess: () => qc.invalidateQueries({ queryKey: ['colo'] }) });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`End allocation · ${a.customerName}`} description={`Frees U${a.startU}–U${a.endU} in ${a.datacenterCode} ${a.rackName}. Equipment in the space is not moved.`}>
      {m.data ? (
        <>
          <p className={cx('rounded-md px-3 py-2 text-[13px]', m.data.devicesRemaining ? 'bg-warn-soft text-warn' : 'bg-ok-soft text-ok')}>
            Allocation ended.{m.data.devicesRemaining ? ` ${m.data.devicesRemaining} of the customer's device(s) are still in that space.` : ''}
          </p>
          <Actions>
            <Button onClick={onClose}>Close</Button>
          </Actions>
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate();
          }}
        >
          <Field label="End date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}</Field>
          <Field label="Reason">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <ErrorNote error={m.error} />
          <Actions>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" busy={m.isPending}>
              End allocation
            </Button>
          </Actions>
        </form>
      )}
    </Modal>
  );
}

function AllocationsTab() {
  const { staff, manage } = useRole();
  const [status, setStatus] = useState('active');
  const q = useQuery({ queryKey: ['colo', 'allocations', status], queryFn: () => api.get<AllocationT[]>(`/colocation/allocations?status=${status}`), refetchInterval: 60_000 });
  const [edit, setEdit] = useState<AllocationT | 'new' | null>(null);
  const [ending, setEnding] = useState<AllocationT | null>(null);
  return (
    <Panel
      flush
      title={staff ? 'Rack space' : 'Your space'}
      actions={
        <div className="flex gap-2">
          <Select className="w-32" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Active</option>
            <option value="ended">Ended</option>
          </Select>
          {manage && (
            <Button size="sm" variant="primary" onClick={() => setEdit('new')}>
              Allocate space
            </Button>
          )}
        </div>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !q.data!.length ? (
        <EmptyState title={status === 'active' ? 'No allocated space' : 'No ended allocations'}>{staff ? 'Allocate a full, half, quarter rack or custom units to a customer, with its contracted power.' : 'Rack space contracted to you appears here.'}</EmptyState>
      ) : (
        <Table label="Allocations">
          <thead>
            <tr>
              {staff && <th>Customer</th>}
              <th>Location</th>
              <th>Space</th>
              <th>Power vs. contract</th>
              <th>Feeds</th>
              <th>Since</th>
              {manage && <th />}
            </tr>
          </thead>
          <tbody>
            {q.data!.map((a) => (
              <tr key={a.id}>
                {staff && <td className="font-medium">{a.customerName}</td>}
                <td>
                  <div className="font-medium">
                    {a.datacenterCode} · {a.rackName}
                  </div>
                  <div className="text-[12.5px] text-ink-3">{a.roomName}</div>
                </td>
                <td>
                  <div>{ALLOCATION_KIND_LABELS[a.kind]}</div>
                  <div className="text-[12.5px] text-ink-3">
                    U{a.startU}–U{a.endU} ({a.units}U)
                  </div>
                </td>
                <td className="min-w-48">
                  {a.power ? (
                    <>
                      <PowerBar measured={a.power.measuredW} estimated={a.power.estimatedW} contracted={a.contractedPowerW} />
                      {a.power.overContract && <Chip tone="crit">Measured over contract</Chip>}
                      {a.power.mayExceed && (
                        <Chip tone="warn" title="Only with estimated figures included; not confirmed by measurement">
                          May exceed (estimates)
                        </Chip>
                      )}
                      {a.power.unknownDevices > 0 && <div className="text-[12px] text-warn">{a.power.unknownDevices} device(s) without a figure</div>}
                    </>
                  ) : (
                    <span className="text-ink-3">{watts(a.contractedPowerW)} contracted</span>
                  )}
                </td>
                <td className="text-[13px]">
                  {POWER_FEED_LABELS[a.feeds]}
                  {a.breakerAmps ? ` · ${a.breakerAmps} A` : ''}
                  {a.voltage ? ` · ${a.voltage} V` : ''}
                </td>
                <td className="text-[13px]">
                  {a.startDate}
                  {a.endDate && <div className="text-ink-3">ended {a.endDate}</div>}
                  {a.serviceName && <div className="text-ink-3">{a.serviceName}</div>}
                </td>
                {manage && (
                  <td className="text-right whitespace-nowrap">
                    {a.active && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEdit(a)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="text-crit" onClick={() => setEnding(a)}>
                          End
                        </Button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {edit && <AllocationDialog current={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {ending && <EndAllocationDialog a={ending} onClose={() => setEnding(null)} />}
    </Panel>
  );
}

/* ================================================================== cross-connects */

const XC_TONE: Record<CrossConnectStatus, Tone> = { requested: 'accent', approved: 'accent', in_progress: 'warn', active: 'ok', rejected: 'neutral', decommissioned: 'neutral' };

function CrossConnectDialog({ onClose }: { onClose: () => void }) {
  const { staff } = useRole();
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState('');
  const devs = useCustomerDevices(customerId);
  const [f, setF] = useState({ aDeviceId: '', aLabel: '', zLabel: '', loaReference: '', media: 'smf', speed: '', notes: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => api.post('/colocation/cross-connects', { customerId: staff ? customerId : undefined, aDeviceId: f.aDeviceId || null, aLabel: f.aLabel, zLabel: f.zLabel, loaReference: f.loaReference || null, media: f.media, speed: f.speed || null, notes: staff ? f.notes || null : null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['colo'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Request a cross-connect" description="The datacenter team reviews the request, installs the cable and gives it a cross-connect id." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {staff && <CustomerSelect value={customerId} onChange={setCustomerId} />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Your equipment (A side)">
            {(id) => (
              <Select id={id} value={f.aDeviceId} onChange={set('aDeviceId')}>
                <option value="">Not listed / patch panel</option>
                {devs.data?.items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hostname ?? d.assetTag}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="A-side port or panel">{(id) => <Input id={id} value={f.aLabel} onChange={set('aLabel')} placeholder="eth2 / cage panel 1, port 4" required />}</Field>
        </div>
        <Field label="Other side (Z side)" hint="Carrier, another customer or meet-me-room panel and port">
          {(id) => <Input id={id} value={f.zLabel} onChange={set('zLabel')} required />}
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Media">
            {(id) => (
              <Select id={id} value={f.media} onChange={set('media')}>
                {CROSS_CONNECT_MEDIA.map((x) => (
                  <option key={x} value={x}>
                    {CROSS_CONNECT_MEDIA_LABELS[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Speed">{(id) => <Input id={id} value={f.speed} onChange={set('speed')} placeholder="10G" />}</Field>
          <Field label="LOA / CFA reference">{(id) => <Input id={id} value={f.loaReference} onChange={set('loaReference')} />}</Field>
        </div>
        {staff && <Field label="Notes (staff only)">{(id) => <Textarea id={id} rows={2} value={f.notes} onChange={set('notes')} />}</Field>}
        <ErrorNote error={m.error} />
        <Actions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={staff && !customerId}>
            Request
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}

function XcStatusDialog({ x, onClose }: { x: CrossConnectT; onClose: () => void }) {
  const { staff } = useRole();
  const qc = useQueryClient();
  const options = staff ? CROSS_CONNECT_TRANSITIONS[x.status] : (['rejected'] as const);
  const [status, setStatus] = useState<CrossConnectStatus>(options[0] ?? x.status);
  const [circuitId, setCircuitId] = useState(x.circuitId ?? '');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/colocation/cross-connects/${x.id}/status`, { status, circuitId: circuitId || null, reason: reason || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['colo'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={staff ? `Update cross-connect · ${x.customerName}` : 'Withdraw this request?'} description={`${x.aLabel} ↔ ${x.zLabel}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {staff && (
          <Field label="New status">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as CrossConnectStatus)}>
                {options.map((s) => (
                  <option key={s} value={s}>
                    {CROSS_CONNECT_STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {staff && (status === 'active' || status === 'in_progress') && <Field label="Cross-connect id" hint={status === 'active' ? 'Required when it goes live' : undefined}>{(id) => <Input id={id} value={circuitId} onChange={(e) => setCircuitId(e.target.value)} placeholder="XC-MUM1-0042" />}</Field>}
        <Field label={staff ? 'Note to the customer' : 'Reason (optional)'}>{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <ErrorNote error={m.error} />
        <Actions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={status === 'rejected' || status === 'decommissioned' ? 'danger' : 'primary'} busy={m.isPending}>
            {staff ? 'Update' : 'Withdraw request'}
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}

function CrossConnectsTab() {
  const { staff, manage, request } = useRole();
  const q = useQuery({ queryKey: ['colo', 'xc'], queryFn: () => api.get<CrossConnectT[]>('/colocation/cross-connects') });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CrossConnectT | null>(null);
  return (
    <Panel
      flush
      title="Cross-connects"
      actions={
        request && (
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            Request cross-connect
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !q.data!.length ? (
        <EmptyState title="No cross-connects" />
      ) : (
        <Table label="Cross-connects">
          <thead>
            <tr>
              <th>Status</th>
              {staff && <th>Customer</th>}
              <th>A side</th>
              <th>Z side</th>
              <th>Media</th>
              <th>Id</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data!.map((x) => {
              const canAct = manage ? CROSS_CONNECT_TRANSITIONS[x.status].length > 0 : request && (x.status === 'requested' || x.status === 'approved');
              return (
                <tr key={x.id}>
                  <td>
                    <Chip tone={XC_TONE[x.status]}>{CROSS_CONNECT_STATUS_LABELS[x.status]}</Chip>
                    {x.statusReason && <div className="mt-1 max-w-[28ch] text-[12px] text-ink-3">{x.statusReason}</div>}
                  </td>
                  {staff && <td>{x.customerName}</td>}
                  <td>
                    <div>{x.aLabel}</div>
                    {x.aDeviceName && <div className="text-[12.5px] text-ink-3">{x.aDeviceName}</div>}
                  </td>
                  <td>
                    <div>{x.zLabel}</div>
                    {x.loaReference && <div className="text-[12.5px] text-ink-3">LOA {x.loaReference}</div>}
                  </td>
                  <td className="text-[13px]">
                    {CROSS_CONNECT_MEDIA_LABELS[x.media as keyof typeof CROSS_CONNECT_MEDIA_LABELS] ?? x.media}
                    {x.speed ? ` · ${x.speed}` : ''}
                  </td>
                  <td className="font-mono text-[12.5px]">{x.circuitId ?? '—'}</td>
                  <td className="text-right">
                    {canAct && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(x)}>
                        {manage ? 'Update' : 'Withdraw'}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {creating && <CrossConnectDialog onClose={() => setCreating(false)} />}
      {editing && <XcStatusDialog x={editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

/* ================================================================== shipments */

const SHIP_TONE: Record<ShipmentT['status'], Tone> = { expected: 'accent', received: 'warn', delivered: 'ok', shipped_out: 'ok', cancelled: 'neutral' };

function ShipmentDialog({ onClose }: { onClose: () => void }) {
  const { staff } = useRole();
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState('');
  const [datacenterId, setDc] = useState('');
  const [f, setF] = useState({ direction: 'inbound', carrier: '', trackingNumber: '', expectedOn: '', packages: '1', description: '', instructions: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () =>
      api.post('/colocation/shipments', {
        customerId: staff ? customerId : undefined,
        datacenterId,
        direction: f.direction,
        carrier: f.carrier,
        trackingNumber: f.trackingNumber || null,
        expectedOn: f.expectedOn || null,
        packages: Number(f.packages) || 1,
        description: f.description,
        instructions: f.instructions || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['colo'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Announce a shipment" description="Tell the datacenter team what is arriving (or leaving) so it can be received and stored for you." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {staff && <CustomerSelect value={customerId} onChange={setCustomerId} />}
        <div className="grid grid-cols-2 gap-3">
          <SiteSelect value={datacenterId} onChange={setDc} />
          <Field label="Direction">
            {(id) => (
              <Select id={id} value={f.direction} onChange={set('direction')}>
                <option value="inbound">Arriving</option>
                <option value="outbound">Leaving (pickup)</option>
              </Select>
            )}
          </Field>
          <Field label="Carrier">{(id) => <Input id={id} value={f.carrier} onChange={set('carrier')} required />}</Field>
          <Field label="Tracking number">{(id) => <Input id={id} value={f.trackingNumber} onChange={set('trackingNumber')} />}</Field>
          <Field label="Expected on">{(id) => <Input id={id} type="date" value={f.expectedOn} onChange={set('expectedOn')} />}</Field>
          <Field label="Packages">{(id) => <Input id={id} inputMode="numeric" value={f.packages} onChange={set('packages')} />}</Field>
        </div>
        <Field label="Contents">{(id) => <Textarea id={id} rows={2} value={f.description} onChange={set('description')} required />}</Field>
        <Field label="Instructions">{(id) => <Input id={id} value={f.instructions} onChange={set('instructions')} placeholder="Hold in storage until our visit" />}</Field>
        <ErrorNote error={m.error} />
        <Actions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={staff && !customerId}>
            Announce
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}

function ShipmentUpdateDialog({ s, onClose }: { s: ShipmentT; onClose: () => void }) {
  const { staff } = useRole();
  const qc = useQueryClient();
  const next = staff ? (s.status === 'expected' ? ['received', 'cancelled'] : s.status === 'received' ? ['delivered', 'shipped_out'] : []) : ['cancelled'];
  const [status, setStatus] = useState(next[0]!);
  const [storage, setStorage] = useState(s.storageLocation ?? '');
  const [count, setCount] = useState(String(s.packages));
  const [condition, setCondition] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/colocation/shipments/${s.id}/status`, { status, storageLocation: storage || null, packagesReceived: status === 'received' ? Number(count) : null, conditionNote: condition || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['colo'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={staff ? `Shipment · ${s.customerName}` : 'Cancel this shipment?'} description={`${s.carrier}${s.trackingNumber ? ` ${s.trackingNumber}` : ''} · ${s.description}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {staff && (
          <Field label="Record">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
                {next.map((x) => (
                  <option key={x} value={x}>
                    {SHIPMENT_STATUS_LABELS[x as ShipmentT['status']]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {staff && status === 'received' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Packages received">{(id) => <Input id={id} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ''))} />}</Field>
            <Field label="Stored at">{(id) => <Input id={id} value={storage} onChange={(e) => setStorage(e.target.value)} placeholder="Store B, shelf 4" />}</Field>
          </div>
        )}
        {staff && <Field label="Condition / note">{(id) => <Input id={id} value={condition} onChange={(e) => setCondition(e.target.value)} />}</Field>}
        <ErrorNote error={m.error} />
        <Actions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" variant={status === 'cancelled' ? 'danger' : 'primary'} busy={m.isPending}>
            {staff ? 'Save' : 'Cancel shipment'}
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}

function ShipmentsTab() {
  const { staff, manage, request } = useRole();
  const q = useQuery({ queryKey: ['colo', 'shipments'], queryFn: () => api.get<ShipmentT[]>('/colocation/shipments') });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ShipmentT | null>(null);
  return (
    <Panel
      flush
      title="Shipments"
      actions={
        request && (
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            Announce shipment
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !q.data!.length ? (
        <EmptyState title="No shipments" />
      ) : (
        <Table label="Shipments">
          <thead>
            <tr>
              <th>Status</th>
              {staff && <th>Customer</th>}
              <th>Shipment</th>
              <th>Expected</th>
              <th>Received</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data!.map((s) => {
              const canAct = manage ? ['expected', 'received'].includes(s.status) : request && s.status === 'expected';
              return (
                <tr key={s.id}>
                  <td>
                    <Chip tone={SHIP_TONE[s.status]}>{SHIPMENT_STATUS_LABELS[s.status]}</Chip>
                    {s.direction === 'outbound' && <div className="mt-1 text-[12px] text-ink-3">Outbound</div>}
                  </td>
                  {staff && <td>{s.customerName}</td>}
                  <td>
                    <div>
                      {s.carrier} {s.trackingNumber && <span className="font-mono text-[12.5px]">{s.trackingNumber}</span>}
                    </div>
                    <div className="max-w-[40ch] text-[12.5px] text-ink-3">
                      {s.packages} pkg · {s.description}
                    </div>
                  </td>
                  <td className="text-[13px]">
                    {s.expectedOn ?? '—'}
                    <div className="text-ink-3">{s.datacenterCode}</div>
                  </td>
                  <td className="text-[13px]">
                    {s.receivedAt ? formatDateTime(s.receivedAt) : '—'}
                    {s.storageLocation && <div className="text-ink-3">{s.storageLocation}</div>}
                    {s.packagesReceived !== null && s.packagesReceived !== s.packages && <div className="text-warn">{s.packagesReceived} of {s.packages} packages</div>}
                    {s.conditionNote && <div className="max-w-[30ch] text-ink-3">{s.conditionNote}</div>}
                  </td>
                  <td className="text-right">
                    {canAct && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                        {manage ? 'Update' : 'Cancel'}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {creating && <ShipmentDialog onClose={() => setCreating(false)} />}
      {editing && <ShipmentUpdateDialog s={editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

/* ================================================================== visits */

const VISIT_TONE: Record<VisitT['status'], Tone> = { requested: 'accent', approved: 'ok', denied: 'crit', checked_in: 'warn', checked_out: 'neutral', cancelled: 'neutral' };

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function VisitDialog({ onClose }: { onClose: () => void }) {
  const { staff } = useRole();
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState('');
  const [datacenterId, setDc] = useState('');
  const [visitors, setVisitors] = useState([{ name: '', company: '', idLast4: '' }]);
  const [startsAt, setStarts] = useState(localInput(new Date(Date.now() + 86_400_000)));
  const [endsAt, setEnds] = useState(localInput(new Date(Date.now() + 86_400_000 + 3 * 3600_000)));
  const [purpose, setPurpose] = useState('');
  const m = useMutation({
    mutationFn: () =>
      api.post('/colocation/visits', {
        customerId: staff ? customerId : undefined,
        datacenterId,
        visitors: visitors.filter((v) => v.name.trim()).map((v) => ({ name: v.name, company: v.company || null, idLast4: v.idLast4 || null })),
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        purpose,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['colo'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Request site access" description="Visitors must bring the ID document they list here. Only the last 2–4 characters of its number are kept." wide>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {staff && <CustomerSelect value={customerId} onChange={setCustomerId} />}
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3">
          <SiteSelect value={datacenterId} onChange={setDc} />
          <Field label="Arrive">{(id) => <Input id={id} type="datetime-local" value={startsAt} onChange={(e) => setStarts(e.target.value)} required />}</Field>
          <Field label="Leave by">{(id) => <Input id={id} type="datetime-local" value={endsAt} onChange={(e) => setEnds(e.target.value)} required />}</Field>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-ink-2">Visitors</span>
          {visitors.map((v, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)] gap-2">
              <Input aria-label="Name" placeholder="Name as on ID" value={v.name} onChange={(e) => setVisitors((xs) => xs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <Input aria-label="Company" placeholder="Company" value={v.company} onChange={(e) => setVisitors((xs) => xs.map((x, j) => (j === i ? { ...x, company: e.target.value } : x)))} />
              <Input aria-label="ID last 4" placeholder="ID last 4" maxLength={4} value={v.idLast4} onChange={(e) => setVisitors((xs) => xs.map((x, j) => (j === i ? { ...x, idLast4: e.target.value } : x)))} />
            </div>
          ))}
          {visitors.length < 10 && (
            <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => setVisitors((xs) => [...xs, { name: '', company: '', idLast4: '' }])}>
              Add visitor
            </Button>
          )}
        </div>
        <Field label="Purpose">{(id) => <Input id={id} value={purpose} onChange={(e) => setPurpose(e.target.value)} required />}</Field>
        <ErrorNote error={m.error} />
        <Actions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={staff && !customerId}>
            Request access
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}

function VisitUpdateDialog({ v, onClose }: { v: VisitT; onClose: () => void }) {
  const { staff } = useRole();
  const qc = useQueryClient();
  const next = staff ? ({ requested: ['approved', 'denied', 'cancelled'], approved: ['checked_in', 'cancelled'], checked_in: ['checked_out'] } as Record<string, string[]>)[v.status] ?? [] : ['cancelled'];
  const [status, setStatus] = useState(next[0]!);
  const [note, setNote] = useState('');
  const [escort, setEscort] = useState(v.escort);
  const [badge, setBadge] = useState(v.badge ?? '');
  const m = useMutation({
    mutationFn: () => api.post(`/colocation/visits/${v.id}/status`, { status, note: note || null, escort: staff ? escort : undefined, badge: staff ? badge || null : undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['colo'] });
      onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={staff ? `Visit · ${v.customerName}` : 'Cancel this visit?'} description={`${v.visitors.map((x) => x.name).join(', ')} · ${formatDateTime(v.startsAt)}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        {staff && (
          <Field label="Record">
            {(id) => (
              <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
                {next.map((x) => (
                  <option key={x} value={x}>
                    {VISIT_STATUS_LABELS[x as VisitT['status']]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {staff && status === 'approved' && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={escort} onChange={(e) => setEscort(e.target.checked)} /> Escort required
          </label>
        )}
        {staff && status === 'checked_in' && <Field label="Badge">{(id) => <Input id={id} value={badge} onChange={(e) => setBadge(e.target.value)} placeholder="V-17" />}</Field>}
        <Field label={staff ? 'Note to the customer' : 'Reason (optional)'}>{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <ErrorNote error={m.error} />
        <Actions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" variant={status === 'denied' || status === 'cancelled' ? 'danger' : 'primary'} busy={m.isPending}>
            {staff ? 'Save' : 'Cancel visit'}
          </Button>
        </Actions>
      </form>
    </Modal>
  );
}

function VisitsTab() {
  const { staff, manage, request } = useRole();
  const q = useQuery({ queryKey: ['colo', 'visits'], queryFn: () => api.get<VisitT[]>('/colocation/visits') });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<VisitT | null>(null);
  return (
    <Panel
      flush
      title="Site visits"
      actions={
        request && (
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            Request access
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorNote error={q.error} className="m-4" />
      ) : !q.data!.length ? (
        <EmptyState title="No visits" />
      ) : (
        <Table label="Visits">
          <thead>
            <tr>
              <th>Status</th>
              {staff && <th>Customer</th>}
              <th>Visitors</th>
              <th>When</th>
              <th>Purpose</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data!.map((v) => {
              const canAct = manage ? ['requested', 'approved', 'checked_in'].includes(v.status) : request && ['requested', 'approved'].includes(v.status);
              return (
                <tr key={v.id}>
                  <td>
                    <Chip tone={VISIT_TONE[v.status]}>{VISIT_STATUS_LABELS[v.status]}</Chip>
                    {v.escort && <div className="mt-1 text-[12px] text-ink-3">Escorted</div>}
                    {v.badge && <div className="text-[12px] text-ink-3">Badge {v.badge}</div>}
                  </td>
                  {staff && <td>{v.customerName}</td>}
                  <td className="text-[13px]">
                    {v.visitors.map((x, i) => (
                      <div key={i}>
                        {x.name}
                        {x.company ? <span className="text-ink-3"> · {x.company}</span> : null}
                      </div>
                    ))}
                  </td>
                  <td className="text-[13px]">
                    {formatDateTime(v.startsAt)}
                    <div className="text-ink-3">
                      to {formatDateTime(v.endsAt)} · {v.datacenterCode}
                    </div>
                  </td>
                  <td className="max-w-[36ch] text-[13px]">
                    {v.purpose}
                    {v.decisionNote && <div className="text-ink-3">{v.decisionNote}</div>}
                  </td>
                  <td className="text-right">
                    {canAct && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(v)}>
                        {manage ? 'Update' : 'Cancel'}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {creating && <VisitDialog onClose={() => setCreating(false)} />}
      {editing && <VisitUpdateDialog v={editing} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

/* ================================================================== page */

const TABS = [
  { key: 'space', label: 'Space & power' },
  { key: 'cross-connects', label: 'Cross-connects' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'visits', label: 'Visits' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function ColocationPage() {
  const { staff } = useRole();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'space') as TabKey;
  return (
    <>
      <PageHeader
        title="Colocation"
        description={
          staff
            ? 'Rack space contracted to customers with its power, cross-connects, shipments received for customers and site visits.'
            : 'Your rack space and its power against your contract, your bandwidth, cross-connects, deliveries and site visits.'
        }
      />
      <OverviewPanel />
      <Tabs tabs={TABS} value={tab} onChange={(k) => setParams(k === 'space' ? {} : { tab: k })} label="Colocation" />
      {tab === 'space' && <AllocationsTab />}
      {tab === 'cross-connects' && <CrossConnectsTab />}
      {tab === 'shipments' && <ShipmentsTab />}
      {tab === 'visits' && <VisitsTab />}
    </>
  );
}
