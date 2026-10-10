import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { CATEGORY_LABELS, LIFECYCLE_LABELS, RACKED_STATES, type LifecycleState, type RackFace } from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { daysUntil, STATE_TONE, useRacks, type DeviceT, type EventT } from '../lib/dcim';
import { Button, Chip, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Textarea } from '../components/ui';
import { DeviceForm } from './Hardware';
import { formatWattsShort } from '@crapplet/shared';
import type { DevicePowerT } from '../lib/power';
import { QualityChip } from './Power';

/** Current power of this device, labelled measured / estimated / unknown, with a link to its history. */
function DevicePowerPanel({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['power', 'device', id], queryFn: () => api.get<DevicePowerT & { spec: { typicalW: number | null } | null }>(`/power/devices/${id}`), refetchInterval: 60_000, retry: false });
  if (q.isLoading || q.error || !q.data) return null;
  const d = q.data;
  return (
    <Panel title="Power" actions={<Link to={`/power?device=${id}`} className="text-[13px] text-accent hover:underline">History</Link>}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[24px] font-semibold tracking-[-0.02em]">{formatWattsShort(d.watts)}</span>
        <QualityChip d={d} />
      </div>
      {d.quality === 'unknown' && <p className="mt-2 text-[13px] text-ink-3">No measurement and no estimate. Set the model's typical draw, a per-device estimate, or collect from the BMC.</p>}
    </Panel>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[12.5px] text-ink-3">{k}</dt>
          <dd className="break-words">{v === null || v === undefined || v === '' ? <span className="text-ink-3">—</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

function PlacementForm({ device, onClose }: { device: DeviceT; onClose: () => void }) {
  const qc = useQueryClient();
  const racks = useRacks();
  const [rackId, setRackId] = useState(device.location?.rackId ?? '');
  const [u, setU] = useState(String(device.location?.positionU ?? 1));
  const [face, setFace] = useState<RackFace>(device.location?.face ?? 'front');
  const [reason, setReason] = useState('');
  const rack = racks.data?.find((r) => r.id === rackId);
  const zeroU = device.model.uHeight === 0;
  const m = useMutation({
    mutationFn: (take?: boolean) => api.post(`/dcim/devices/${device.id}/placement`, take ? { rackId: null, reason } : { rackId, positionU: zeroU ? null : Number(u), face: zeroU ? null : face, reason: reason || undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose();
    },
  });
  const inService = RACKED_STATES.includes(device.lifecycleState);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate(false);
      }}
    >
      <Field label="Rack">
        {(id) => (
          <Select id={id} required value={rackId} onChange={(e) => setRackId(e.target.value)}>
            <option value="">Choose a rack</option>
            {racks.data
              ?.filter((r) => r.status !== 'decommissioned')
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.location.datacenterCode} / {r.location.roomName} / {r.name} ({r.freeU}U free)
                </option>
              ))}
          </Select>
        )}
      </Field>
      {!zeroU && (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Lowest unit" hint={rack ? `1–${rack.uHeight}; this device uses ${device.model.uHeight}U` : undefined}>
            {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={rack?.uHeight ?? 60} value={u} onChange={(e) => setU(e.target.value)} />}
          </Field>
          <Field label="Face" hint={device.model.fullDepth ? 'Full-depth: uses both faces' : 'Half-depth'}>
            {(id, d) => (
              <Select id={id} aria-describedby={d} value={face} onChange={(e) => setFace(e.target.value as RackFace)}>
                <option value="front">Front</option>
                <option value="rear">Rear</option>
              </Select>
            )}
          </Field>
        </div>
      )}
      <Field label="Reason" hint="Recorded in the device history">
        {(id, d) => <Input id={id} aria-describedby={d} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Consolidating rack A02" />}
      </Field>
      <ErrorNote error={m.error} />
      <div className="flex flex-wrap justify-between gap-2">
        <div>
          {device.location && (
            <Button type="button" variant="ghost" disabled={inService} title={inService ? 'Change the state to In inventory to take it out' : undefined} onClick={() => m.mutate(true)}>
              Take out of rack
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending && m.variables === false} disabled={!rackId}>
            {device.location ? 'Move' : 'Place in rack'}
          </Button>
        </div>
      </div>
      {inService && device.location && <p className="text-[12.5px] text-ink-3">This device is {LIFECYCLE_LABELS[device.lifecycleState].toLowerCase()}. To take it out of the rack, change its state to “In inventory”, which removes it in the same step.</p>}
    </form>
  );
}

function TransitionForm({ device, to, onClose }: { device: DeviceT; to: LifecycleState; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/dcim/devices/${device.id}/transition`, { to, note: note || undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose();
    },
  });
  const leavesRack = !RACKED_STATES.includes(to) && !!device.location;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <p className="text-ink-2">
        {LIFECYCLE_LABELS[device.lifecycleState]} → <strong className="text-ink">{LIFECYCLE_LABELS[to]}</strong>
        {leavesRack && `. This also takes it out of rack ${device.location!.rackName}, freeing its units.`}
        {to === 'retired' && ' Retired equipment can’t be placed in a rack again.'}
      </p>
      <Field label="Note" hint="Optional; recorded in the history">
        {(id, d) => <Textarea id={id} aria-describedby={d} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-14" autoFocus />}
      </Field>
      <ErrorNote error={m.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant={to === 'retired' ? 'danger' : 'primary'} busy={m.isPending}>
          Mark as {LIFECYCLE_LABELS[to].toLowerCase()}
        </Button>
      </div>
    </form>
  );
}

function NoteForm({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'maintenance' | 'note'>('maintenance');
  const [summary, setSummary] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/dcim/devices/${deviceId}/events`, { kind, summary }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim', 'device-events', deviceId] });
      onClose();
    },
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Type">
        {(id) => (
          <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as 'maintenance' | 'note')}>
            <option value="maintenance">Maintenance work</option>
            <option value="note">Note</option>
          </Select>
        )}
      </Field>
      <Field label="What happened">{(id) => <Textarea id={id} required value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Replaced PSU 2 (spare from MUM1 store)" autoFocus />}</Field>
      <ErrorNote error={m.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          Add to history
        </Button>
      </div>
    </form>
  );
}

const EVENT_LABEL: Record<string, string> = { created: 'Added', updated: 'Edited', moved: 'Moved', lifecycle: 'State', maintenance: 'Maintenance', note: 'Note' };

export function DeviceDetailPage() {
  const { id = '' } = useParams();
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  const canWrite = can('dcim.write') && staff;
  const q = useQuery({ queryKey: ['dcim', 'device', id], queryFn: () => api.get<DeviceT>(`/dcim/devices/${id}`) });
  const transitions = useQuery({ queryKey: ['dcim', 'device-transitions', id, q.data?.lifecycleState], queryFn: () => api.get<LifecycleState[]>(`/dcim/devices/${id}/transitions`), enabled: canWrite && !!q.data });
  const events = useQuery({ queryKey: ['dcim', 'device-events', id], queryFn: () => api.get<EventT[]>(`/dcim/devices/${id}/events`), enabled: staff });
  const [dialog, setDialog] = useState<null | 'edit' | 'place' | 'note' | { to: LifecycleState }>(null);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;
  const warrantyDays = daysUntil(d.warrantyExpires);

  return (
    <>
      <p className="mb-2 text-[13px]">
        <Link to="/hardware" className="text-accent hover:underline">
          Servers and hardware
        </Link>
      </p>
      <PageHeader
        title={d.hostname || d.assetTag}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{d.assetTag}</span>
            <span>
              {d.model.manufacturer} {d.model.name}
            </span>
            <Chip tone={STATE_TONE[d.lifecycleState]}>{LIFECYCLE_LABELS[d.lifecycleState]}</Chip>
            {d.ownership === 'customer' && <Chip tone="est">Customer-owned</Chip>}
          </span>
        }
        actions={
          canWrite && (
            <>
              {d.lifecycleState !== 'retired' && <Button onClick={() => setDialog('place')}>{d.location ? 'Move' : 'Place in rack'}</Button>}
              <Button onClick={() => setDialog('note')}>Add maintenance note</Button>
              <Link to={`/hardware/${d.id}/label`} className="inline-flex h-9 items-center rounded-lg border border-rule-strong bg-field px-3.5 font-medium hover:bg-panel">
                Print label
              </Link>
              {can('network.read') && (
                <Link to={`/network/devices/${d.id}`} className="inline-flex h-9 items-center rounded-lg border border-rule-strong bg-field px-3.5 font-medium hover:bg-panel">
                  Ports & network
                </Link>
              )}
              <Button variant="primary" onClick={() => setDialog('edit')}>
                Edit
              </Button>
            </>
          )
        }
      />
      {canWrite && !!transitions.data?.length && (
        <div className="glass mb-5 flex flex-wrap items-center gap-2 rounded-2xl px-4 py-3">
          <span className="mr-1 text-[13px] text-ink-2">Change state to</span>
          {transitions.data.map((s) => (
            <Button key={s} size="sm" variant={s === 'retired' ? 'ghost' : 'secondary'} onClick={() => setDialog({ to: s })}>
              {LIFECYCLE_LABELS[s]}
            </Button>
          ))}
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-5">
          <Panel title="Overview">
            <Facts
              items={[
                ['Category', CATEGORY_LABELS[d.category]],
                ['Size', `${d.model.uHeight}U${d.model.fullDepth ? '' : ', half-depth'}`],
                [
                  'Location',
                  d.location ? (
                    staff ? (
                      <Link to={`/racks/${d.location.rackId}`} className="text-accent hover:underline">
                        {d.location.datacenterCode} / {d.location.roomName} / {d.location.rackName}
                        {d.location.positionU ? ` U${d.location.positionU}${d.location.face === 'rear' ? ' (rear)' : ''}` : ' (0U)'}
                      </Link>
                    ) : (
                      `${d.location.datacenterCode}, rack ${d.location.rackName}${d.location.positionU ? ` U${d.location.positionU}` : ''}`
                    )
                  ) : (
                    'Not in a rack'
                  ),
                ],
                ['Customer', d.customerName],
                ['Serial number', d.serial && <span className="font-mono">{d.serial}</span>],
                ['Operating system', d.os],
                ...(staff
                  ? ([
                      ['Management', d.mgmtAddress ? <span className="font-mono">{`${d.mgmtType?.toUpperCase() ?? ''} ${d.mgmtAddress}`.trim()}</span> : null],
                      ['Firmware', [d.biosVersion && `BIOS ${d.biosVersion}`, d.bmcFirmware && `BMC ${d.bmcFirmware}`].filter(Boolean).join(', ')],
                    ] as [string, ReactNode][])
                  : []),
              ]}
            />
          </Panel>
          <Panel title="Hardware">
            <Facts
              items={[
                ['CPU', d.cpu ? `${d.cpuCount ? `${d.cpuCount} × ` : ''}${d.cpu}` : null],
                ['Memory', d.ramGb ? `${d.ramGb} GB${d.dimmLayout ? ` (${d.dimmLayout})` : ''}` : null],
                ['RAID', d.raid],
                ['Disks', d.disks.length ? `${d.disks.length} disk${d.disks.length === 1 ? '' : 's'}, ${Math.round(d.disks.reduce((a, x) => a + x.sizeGb, 0))} GB total` : null],
              ]}
            />
            {d.disks.length > 0 && (
              <ul className="mt-3 grid gap-1 text-[13px] sm:grid-cols-2">
                {d.disks.map((x, i) => (
                  <li key={i} className="rounded-md bg-sunken px-2 py-1">
                    {x.slot ? `Slot ${x.slot}: ` : ''}
                    {x.sizeGb} GB {x.type}
                    {x.model ? `, ${x.model}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {d.nics.length > 0 && (
              <>
                <p className="mt-4 mb-1 text-[12.5px] text-ink-3">Network adapters</p>
                <ul className="grid gap-1 text-[13px] sm:grid-cols-2">
                  {d.nics.map((n, i) => (
                    <li key={i} className="rounded-md bg-sunken px-2 py-1">
                      {n.name} <span className="font-mono text-ink-2">{n.mac ?? ''}</span> {n.speed ?? ''}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
          {can('power.read') && d.lifecycleState !== 'retired' && <DevicePowerPanel id={d.id} />}
          {staff && (
            <Panel title="Purchase and warranty">
              <Facts
                items={[
                  ['Supplier', d.supplier],
                  ['Purchased', d.purchaseDate],
                  ['Cost', d.purchaseCost != null ? `${d.currency ?? ''} ${d.purchaseCost.toLocaleString('en-IN')}`.trim() : null],
                  [
                    'Warranty',
                    d.warrantyExpires ? (
                      <span>
                        {d.warrantyExpires}{' '}
                        {warrantyDays !== null && warrantyDays < 0 ? <Chip tone="crit">Expired</Chip> : warrantyDays !== null && warrantyDays <= 90 ? <Chip tone="warn">{warrantyDays} days left</Chip> : null}
                      </span>
                    ) : null,
                  ],
                  ['End of life', d.eolDate],
                  ...Object.entries(d.custom ?? {}).map(([k, v]) => [k, String(v ?? '')] as [string, ReactNode]),
                ]}
              />
              {d.notes && <p className="mt-4 rounded-lg bg-sunken p-3 text-[13px] whitespace-pre-wrap">{d.notes}</p>}
            </Panel>
          )}
        </div>
        {staff && (
          <Panel title="History">
            <ol className="relative flex flex-col gap-3 border-l border-rule pl-4">
              {events.data?.map((e) => (
                <li key={e.id} className="relative">
                  <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-panel bg-accent" aria-hidden />
                  <p className="text-[13px]">
                    <span className="font-semibold">{EVENT_LABEL[e.kind] ?? e.kind}:</span> {e.summary}
                  </p>
                  <p className="text-[12px] text-ink-3" title={formatDateTime(e.occurredAt)}>
                    {e.actorLabel}, {relativeTime(e.occurredAt)}
                  </p>
                </li>
              ))}
            </ol>
          </Panel>
        )}
      </div>
      <Modal wide open={dialog === 'edit'} onOpenChange={(o) => !o && setDialog(null)} title={`Edit ${d.assetTag}`}>
        {dialog === 'edit' && <DeviceForm device={d} onClose={() => setDialog(null)} />}
      </Modal>
      <Modal open={dialog === 'place'} onOpenChange={(o) => !o && setDialog(null)} title={d.location ? 'Move device' : 'Place in rack'}>
        {dialog === 'place' && <PlacementForm device={d} onClose={() => setDialog(null)} />}
      </Modal>
      <Modal open={dialog === 'note'} onOpenChange={(o) => !o && setDialog(null)} title="Add to history">
        {dialog === 'note' && <NoteForm deviceId={d.id} onClose={() => setDialog(null)} />}
      </Modal>
      <Modal open={typeof dialog === 'object' && dialog !== null} onOpenChange={(o) => !o && setDialog(null)} title="Change state">
        {typeof dialog === 'object' && dialog !== null && <TransitionForm device={d} to={dialog.to} onClose={() => setDialog(null)} />}
      </Modal>
    </>
  );
}

/** Print-ready asset label with QR code (fits common 62 mm label printers and A4 sheets). */
export function DeviceLabelPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['dcim', 'label', id], queryFn: () => api.get<{ assetTag: string; hostname: string | null; serial: string | null; model: string; url: string; qrSvg: string; location: DeviceT['location'] }>(`/dcim/devices/${id}/label`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const l = q.data!;
  return (
    <>
      <style>{`@media print { body * { visibility: hidden; } #label, #label * { visibility: visible; } #label { position: absolute; left: 0; top: 0; box-shadow: none !important; } }`}</style>
      <PageHeader title="Asset label" description="Scanning the code opens this device in Crapplet DCIM." actions={<Button variant="primary" onClick={() => window.print()}>Print</Button>} />
      <div id="label" className="flex w-[62mm] gap-[3mm] rounded-md border border-black bg-white p-[3mm] text-black shadow-lg" style={{ fontFamily: 'var(--font-sans)' }}>
        <div className="size-[22mm] shrink-0 [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: l.qrSvg }} />
        <div className="min-w-0 leading-tight">
          <p className="text-[9pt] font-bold">{l.assetTag}</p>
          {l.hostname && <p className="truncate text-[7.5pt]">{l.hostname}</p>}
          <p className="truncate text-[6.5pt]">{l.model}</p>
          {l.serial && <p className="truncate font-mono text-[6.5pt]">S/N {l.serial}</p>}
          <p className="mt-[1mm] text-[6pt]">Crapplet Infotech</p>
        </div>
      </div>
      <p className="mt-3 text-[12.5px] text-ink-3">
        Link: <span className="font-mono">{l.url}</span>
      </p>
    </>
  );
}
