import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CATEGORY_LABELS, LIFECYCLE_LABELS, type RackFace } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { roomOptions, STATE_TONE, useRacks, useTree, type DeviceT, type ElevationDevice, type ElevationT, type EventT, type RackT } from '../lib/dcim';
import type { Customer } from '../lib/types';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table, Textarea, cx } from '../components/ui';

export function useCustomerOptions(enabled = true) {
  return useQuery({ queryKey: ['customers', 'options'], queryFn: () => api.get<Paginated<Customer>>('/customers?pageSize=200'), enabled });
}

/** Occupancy bar: used units solid, reserved hatched, the rest free. */
export function OccupancyBar({ rack, className }: { rack: Pick<RackT, 'uHeight' | 'usedU' | 'reservedU'>; className?: string }) {
  const used = (rack.usedU / rack.uHeight) * 100;
  const reserved = Math.min(100 - used, (rack.reservedU / rack.uHeight) * 100);
  const tone = used >= 90 ? 'bg-crit' : used >= 75 ? 'bg-warn' : 'bg-accent';
  return (
    <div className={cx('flex h-2 w-full overflow-hidden rounded-full bg-sunken', className)} role="img" aria-label={`${rack.usedU} of ${rack.uHeight} units used, ${rack.reservedU} reserved`}>
      <div className={tone} style={{ width: `${used}%` }} />
      <div className="bg-[repeating-linear-gradient(135deg,var(--est)_0_3px,transparent_3px_6px)] opacity-70" style={{ width: `${reserved}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ rack form */

export function RackForm({ rack, defaultRoomId, onClose }: { rack?: RackT; defaultRoomId?: string; onClose: (saved?: { id: string }) => void }) {
  const qc = useQueryClient();
  const tree = useTree();
  const customers = useCustomerOptions();
  const rooms = roomOptions(tree.data);
  const [f, setF] = useState({
    roomId: rack?.roomId ?? defaultRoomId ?? '',
    rowId: rack?.rowId ?? '',
    name: rack?.name ?? '',
    uHeight: String(rack?.uHeight ?? 42),
    depthMm: String(rack?.depthMm ?? 1070),
    maxPowerW: rack?.maxPowerW != null ? String(rack.maxPowerW) : '',
    status: rack?.status ?? 'active',
    numbering: rack?.numbering ?? 'bottom_up',
    customerId: rack?.customerId ?? '',
    assetTag: rack?.assetTag ?? '',
    serial: rack?.serial ?? '',
    notes: rack?.notes ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const room = rooms.find((r) => r.id === f.roomId)?.room;
  const m = useMutation({
    mutationFn: () => {
      const body = {
        roomId: f.roomId,
        rowId: f.rowId || null,
        name: f.name,
        uHeight: Number(f.uHeight),
        depthMm: Number(f.depthMm),
        maxPowerW: f.maxPowerW ? Number(f.maxPowerW) : null,
        status: f.status,
        numbering: f.numbering,
        customerId: f.customerId || null,
        gridX: rack?.gridX ?? null,
        gridY: rack?.gridY ?? null,
        assetTag: f.assetTag || null,
        serial: f.serial || null,
        notes: f.notes || null,
      };
      return rack ? api.patch<{ id: string }>(`/dcim/racks/${rack.id}`, body) : api.post<{ id: string }>('/dcim/racks', body);
    },
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose(saved);
    },
  });
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Room" hint={rack ? 'Use “Move rack” to change the room.' : undefined}>
        {(id, d) => (
          <Select id={id} aria-describedby={d} required disabled={!!rack} value={f.roomId} onChange={(e) => setF((s) => ({ ...s, roomId: e.target.value, rowId: '' }))}>
            <option value="">Choose a room</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Row">
        {(id) => (
          <Select id={id} value={f.rowId} onChange={set('rowId')} disabled={!room}>
            <option value="">No row</option>
            {room?.rows.map((r) => (
              <option key={r.id} value={r.id}>
                Row {r.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Rack name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} placeholder="e.g. A01" autoFocus={!rack} />}</Field>
      <Field label="Status">
        {(id) => (
          <Select id={id} value={f.status} onChange={set('status')}>
            <option value="active">Active</option>
            <option value="planned">Planned</option>
            <option value="reserved">Reserved</option>
            <option value="decommissioned">Decommissioned (takes no new equipment)</option>
          </Select>
        )}
      </Field>
      <Field label="Height (units)">{(id) => <Input id={id} type="number" min={1} max={60} required value={f.uHeight} onChange={set('uHeight')} />}</Field>
      <Field label="Usable depth (mm)" hint="Deeper equipment is refused">
        {(id, d) => <Input id={id} aria-describedby={d} type="number" min={300} max={1500} required value={f.depthMm} onChange={set('depthMm')} />}
      </Field>
      <Field label="Unit numbering">
        {(id) => (
          <Select id={id} value={f.numbering} onChange={set('numbering')}>
            <option value="bottom_up">U1 at the bottom</option>
            <option value="top_down">U1 at the top</option>
          </Select>
        )}
      </Field>
      <Field label="Power budget (W)" hint="Optional; used for power planning">
        {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} value={f.maxPowerW} onChange={set('maxPowerW')} />}
      </Field>
      <Field label="Dedicated to customer" hint="Only this customer’s equipment can be placed">
        {(id, d) => (
          <Select id={id} aria-describedby={d} value={f.customerId} onChange={set('customerId')}>
            <option value="">Not dedicated</option>
            {customers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Asset tag">{(id) => <Input id={id} value={f.assetTag} onChange={set('assetTag')} />}</Field>
      <div className="sm:col-span-2">
        <Field label="Notes">{(id) => <Textarea id={id} value={f.notes} onChange={set('notes')} className="min-h-14" />}</Field>
      </div>
      <ErrorNote error={m.error} className="sm:col-span-2" />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={() => onClose()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          {rack ? 'Save changes' : 'Add rack'}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ list */

export function RacksPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tree = useTree();
  const datacenterId = params.get('datacenterId') ?? '';
  const [search, setSearch] = useState('');
  const racks = useRacks(qs({ datacenterId }));
  const [creating, setCreating] = useState(false);
  const shown = (racks.data ?? []).filter((r) => !search || `${r.name} ${r.location.roomName} ${r.location.datacenterCode} ${r.customerName ?? ''}`.toLowerCase().includes(search.toLowerCase()));
  const total = shown.reduce((a, r) => ({ u: a.u + r.uHeight, used: a.used + r.usedU }), { u: 0, used: 0 });

  return (
    <>
      <PageHeader
        title="Racks"
        description={racks.data ? `${shown.length} racks, ${total.used} of ${total.u} units in use (${total.u ? Math.round((total.used / total.u) * 100) : 0}%).` : 'Rack capacity and elevations.'}
        actions={can('dcim.write') && <Button variant="primary" onClick={() => setCreating(true)}>Add rack</Button>}
      />
      <Panel flush>
        <div className="flex flex-wrap gap-2 border-b border-rule p-3">
          <label className="sr-only" htmlFor="rack-search">Search racks</label>
          <Input id="rack-search" placeholder="Search rack, room or customer" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <label className="sr-only" htmlFor="rack-dc">Datacenter</label>
          <Select id="rack-dc" className="w-56" value={datacenterId} onChange={(e) => setParams(e.target.value ? { datacenterId: e.target.value } : {}, { replace: true })}>
            <option value="">All datacenters</option>
            {tree.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} · {d.name}
              </option>
            ))}
          </Select>
        </div>
        {racks.isLoading && <Loading />}
        <ErrorNote error={racks.error} className="m-4" />
        {racks.data && shown.length === 0 && (
          <EmptyState title={racks.data.length ? 'No racks match' : 'No racks yet'} action={!racks.data.length && can('dcim.write') && <Button variant="primary" onClick={() => setCreating(true)}>Add rack</Button>}>
            {racks.data.length ? 'Try a different search.' : 'Add racks to a room, then place equipment in them.'}
          </EmptyState>
        )}
        {shown.length > 0 && (
          <Table label="Racks">
            <thead>
              <tr>
                <th>Rack</th>
                <th>Location</th>
                <th className="w-[28%]">Occupancy</th>
                <th>Free</th>
                <th>Devices</th>
                <th>Customer</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="cursor-pointer hover:bg-sunken/50" onClick={() => navigate(`/racks/${r.id}`)}>
                  <td>
                    <Link to={`/racks/${r.id}`} className="font-medium text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                      {r.name}
                    </Link>
                  </td>
                  <td className="text-ink-2">
                    <span className="font-mono text-[12.5px]">{r.location.datacenterCode}</span> {r.location.roomName}
                    {r.location.rowName ? `, row ${r.location.rowName}` : ''}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <OccupancyBar rack={r} />
                      <span className="w-16 text-right text-[12.5px] text-ink-2">
                        {r.usedU}/{r.uHeight}U
                      </span>
                    </div>
                  </td>
                  <td>{r.freeU}U</td>
                  <td>{r.deviceCount}</td>
                  <td className="text-ink-2">{r.customerName ?? '—'}</td>
                  <td>{r.status === 'active' ? <Chip tone="ok">Active</Chip> : r.status === 'decommissioned' ? <Chip>Decommissioned</Chip> : <Chip tone="est">{r.status === 'planned' ? 'Planned' : 'Reserved'}</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Modal wide open={creating} onOpenChange={setCreating} title="Add rack">
        {creating && (
          <RackForm
            onClose={(saved) => {
              setCreating(false);
              if (saved) navigate(`/racks/${saved.id}`);
            }}
          />
        )}
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ elevation */

const UNIT_PX = 24;
const DND_TYPE = 'application/x-cdcim-device';

function unitRow(rack: RackT, u: number) {
  // CSS grid row (1-based) for unit u, so U1 sits at the bottom (or top, for top-down racks).
  return rack.numbering === 'bottom_up' ? rack.uHeight - u + 1 : u;
}

/** Solid fills: the rack interior is always dark, so translucent theme tints would wash out. */
function deviceTone(d: ElevationDevice) {
  if (d.lifecycleState === 'maintenance') return 'border-[#f0c46a] bg-[#a8720f] text-white';
  if (d.ownership === 'customer') return 'border-[#b9adf5] bg-[#5f4fb0] text-white';
  if (d.lifecycleState === 'active') return 'border-[#6fd9a6] bg-[#1f7a52] text-white';
  return 'border-[#9fb0ff] bg-[#3149b8] text-white';
}

function RackFaceView({
  data,
  face,
  canWrite,
  dragging,
  onDropDevice,
  onPickUnit,
}: {
  data: ElevationT;
  face: RackFace;
  canWrite: boolean;
  dragging: { id: string; uHeight: number } | null;
  onDropDevice: (deviceId: string, u: number, face: RackFace) => void;
  onPickUnit: (u: number, face: RackFace) => void;
}) {
  const { rack } = data;
  const [hoverU, setHoverU] = useState<number | null>(null);
  const units = Array.from({ length: rack.uHeight }, (_, i) => i + 1);
  const onFace = data.devices.filter((d) => d.fullDepth || d.face === face);
  const otherFaceOnly = data.devices.filter((d) => !d.fullDepth && d.face !== face);
  const occupied = new Set(onFace.flatMap((d) => Array.from({ length: d.uHeight }, (_, i) => d.positionU! + i)));
  const previewOk = (u: number) => {
    if (!dragging) return false;
    for (let i = 0; i < dragging.uHeight; i++) {
      const unit = u + i;
      if (unit > rack.uHeight) return false;
      const holder = onFace.find((d) => unit >= d.positionU! && unit < d.positionU! + d.uHeight);
      if (holder && holder.id !== dragging.id) return false;
    }
    return true;
  };
  const drop = (e: DragEvent, u: number) => {
    e.preventDefault();
    setHoverU(null);
    const id = e.dataTransfer.getData(DND_TYPE);
    if (id) onDropDevice(id, u, face);
  };

  return (
    <figure className="min-w-0 flex-1">
      <figcaption className="mb-2 text-center text-[13px] font-semibold text-ink-2">{face === 'front' ? 'Front' : 'Rear'}</figcaption>
      <div className="rounded-xl border border-rule-strong bg-[#141c28] p-2 shadow-[inset_0_2px_10px_rgb(0_0_0/0.4)]">
        <div className="relative grid" style={{ gridTemplateColumns: '28px 1fr 28px', gridTemplateRows: `repeat(${rack.uHeight}, ${UNIT_PX}px)` }}>
          {units.map((u) => {
            const row = unitRow(rack, u);
            const reservation = data.reservations.find((r) => !r.expired && u >= r.startU && u <= r.endU);
            const isHover = hoverU !== null && dragging && u >= hoverU && u < hoverU + dragging.uHeight;
            return (
              <div key={u} className="contents">
                <span className="flex items-center justify-center font-mono text-[10.5px] text-white/45" style={{ gridRow: row, gridColumn: 1 }}>
                  {u}
                </span>
                <button
                  type="button"
                  aria-label={`${face} U${u}${occupied.has(u) ? ' (occupied)' : reservation ? ` (reserved: ${reservation.reason})` : ' (empty)'}`}
                  disabled={!canWrite || occupied.has(u)}
                  onClick={() => onPickUnit(u, face)}
                  onDragOver={(e) => {
                    if (!canWrite || !dragging) return;
                    e.preventDefault();
                    setHoverU(u);
                  }}
                  onDragLeave={() => setHoverU((h) => (h === u ? null : h))}
                  onDrop={(e) => drop(e, u)}
                  className={cx(
                    'border-b border-white/[0.06] text-left transition-colors',
                    reservation ? 'bg-[repeating-linear-gradient(135deg,rgb(171_158_240/0.22)_0_4px,transparent_4px_8px)]' : 'bg-white/[0.03]',
                    canWrite && !occupied.has(u) && 'hover:bg-white/[0.1]',
                    isHover && (previewOk(hoverU!) ? 'bg-ok/35!' : 'bg-crit/40!'),
                  )}
                  style={{ gridRow: row, gridColumn: 2 }}
                  title={reservation ? `Reserved${reservation.customerName ? ` for ${reservation.customerName}` : ''}: ${reservation.reason}` : undefined}
                />
                <span className="flex items-center justify-center font-mono text-[10.5px] text-white/45" style={{ gridRow: row, gridColumn: 3 }}>
                  {u}
                </span>
              </div>
            );
          })}
          {otherFaceOnly.map((d) => {
            const top = unitRow(rack, d.positionU! + d.uHeight - 1);
            const bottom = unitRow(rack, d.positionU!);
            return (
              <div
                key={`ghost-${d.id}`}
                aria-hidden
                className="pointer-events-none mx-0.5 my-px rounded border border-dashed border-white/20"
                style={{ gridColumn: 2, gridRow: `${Math.min(top, bottom)} / ${Math.max(top, bottom) + 1}` }}
              />
            );
          })}
          {onFace.map((d) => {
            const top = unitRow(rack, d.positionU! + d.uHeight - 1);
            const bottom = unitRow(rack, d.positionU!);
            return (
              <Link
                key={d.id}
                to={`/hardware/${d.id}`}
                draggable={canWrite}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_TYPE, d.id);
                  e.dataTransfer.effectAllowed = 'move';
                  window.dispatchEvent(new CustomEvent('cdcim-drag', { detail: { id: d.id, uHeight: d.uHeight } }));
                }}
                onDragEnd={() => window.dispatchEvent(new CustomEvent('cdcim-drag', { detail: null }))}
                className={cx('z-10 mx-0.5 my-px flex min-w-0 items-center gap-2 overflow-hidden rounded-[5px] border px-2 text-[12px] shadow-[inset_0_1px_0_rgb(255_255_255/0.18)] hover:brightness-110', deviceTone(d), canWrite && 'cursor-grab active:cursor-grabbing')}
                style={{ gridColumn: 2, gridRow: `${Math.min(top, bottom)} / ${Math.max(top, bottom) + 1}` }}
                title={`${d.assetTag} — ${d.manufacturerName} ${d.modelName}, ${LIFECYCLE_LABELS[d.lifecycleState]}${d.customerName ? `, ${d.customerName}` : ''}`}
              >
                <span className="truncate font-semibold">{d.hostname || d.assetTag}</span>
                <span className="hidden truncate text-white/75 sm:inline">{d.modelName}</span>
                {!d.fullDepth && <span className="ml-auto shrink-0 text-[10.5px] text-white/70" title="Half-depth">½</span>}
              </Link>
            );
          })}
        </div>
      </div>
    </figure>
  );
}

function PlaceDialog({ rack, preset, onClose }: { rack: RackT; preset: { u: number; face: RackFace; deviceId?: string } | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [deviceId, setDeviceId] = useState(preset?.deviceId ?? '');
  const [u, setU] = useState(String(preset?.u ?? 1));
  const [face, setFace] = useState<RackFace>(preset?.face ?? 'front');
  const candidates = useQuery({
    queryKey: ['dcim', 'devices', 'unracked', search],
    queryFn: () => api.get<Paginated<DeviceT>>(`/dcim/devices${qs({ unracked: 'true', q: search, pageSize: 50, sort: 'updated' })}`),
  });
  const m = useMutation({
    mutationFn: () => api.post(`/dcim/devices/${deviceId}/placement`, { rackId: rack.id, positionU: Number(u), face }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose();
    },
  });
  const list = (candidates.data?.items ?? []).filter((d) => d.lifecycleState !== 'retired');
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Find equipment that isn’t in a rack">{(id) => <Input id={id} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Asset tag, hostname, serial or model" autoFocus />}</Field>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-rule bg-sunken" role="listbox" aria-label="Unracked equipment">
        {candidates.isLoading && <Loading />}
        {list.length === 0 && !candidates.isLoading && <p className="p-3 text-[13px] text-ink-3">No unracked equipment matches.</p>}
        {list.map((d) => (
          <label key={d.id} className={cx('flex cursor-pointer items-center gap-2.5 border-b border-rule px-3 py-2 last:border-0', deviceId === d.id && 'bg-accent-soft')}>
            <input type="radio" name="device" className="accent-[var(--accent)]" checked={deviceId === d.id} onChange={() => setDeviceId(d.id)} />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{d.hostname || d.assetTag}</span> <span className="text-[12.5px] text-ink-3">{d.assetTag}</span>
              <span className="block truncate text-[12.5px] text-ink-2">
                {d.model.manufacturer} {d.model.name}, {d.model.uHeight}U{!d.model.fullDepth ? ' half-depth' : ''}
              </span>
            </span>
            <Chip tone={STATE_TONE[d.lifecycleState]}>{LIFECYCLE_LABELS[d.lifecycleState]}</Chip>
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field label="Lowest unit" hint={`1–${rack.uHeight}`}>
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={rack.uHeight} value={u} onChange={(e) => setU(e.target.value)} />}
        </Field>
        <Field label="Face" hint="Full-depth equipment uses both">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={face} onChange={(e) => setFace(e.target.value as RackFace)}>
              <option value="front">Front</option>
              <option value="rear">Rear</option>
            </Select>
          )}
        </Field>
      </div>
      <ErrorNote error={m.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending} disabled={!deviceId}>
          Place in rack
        </Button>
      </div>
    </form>
  );
}

function MoveRackForm({ rack, onClose }: { rack: RackT; onClose: () => void }) {
  const qc = useQueryClient();
  const tree = useTree();
  const rooms = roomOptions(tree.data);
  const [roomId, setRoomId] = useState(rack.roomId);
  const [rowId, setRowId] = useState(rack.rowId ?? '');
  const [reason, setReason] = useState('');
  const room = rooms.find((r) => r.id === roomId)?.room;
  const m = useMutation({
    mutationFn: () => api.post(`/dcim/racks/${rack.id}/move`, { roomId, rowId: rowId || null, gridX: roomId === rack.roomId ? rack.gridX : null, gridY: roomId === rack.roomId ? rack.gridY : null, reason: reason || undefined }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
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
      <p className="text-ink-2">The rack moves with all of its equipment. Place it on the new room’s floor plan afterwards.</p>
      <Field label="Room">
        {(id) => (
          <Select id={id} value={roomId} onChange={(e) => (setRoomId(e.target.value), setRowId(''))}>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Row">
        {(id) => (
          <Select id={id} value={rowId} onChange={(e) => setRowId(e.target.value)}>
            <option value="">No row</option>
            {room?.rows.map((r) => (
              <option key={r.id} value={r.id}>
                Row {r.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Reason">{(id) => <Input id={id} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Hall 1 consolidation" />}</Field>
      <ErrorNote error={m.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          Move rack
        </Button>
      </div>
    </form>
  );
}

function ReserveForm({ rack, onClose }: { rack: RackT; onClose: () => void }) {
  const qc = useQueryClient();
  const customers = useCustomerOptions();
  const [startU, setStart] = useState('1');
  const [endU, setEnd] = useState('1');
  const [customerId, setCustomer] = useState('');
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const m = useMutation({
    mutationFn: () => api.post(`/dcim/racks/${rack.id}/reservations`, { startU: Number(startU), endU: Number(endU), customerId: customerId || null, reason, expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose();
    },
  });
  return (
    <form
      className="grid grid-cols-2 gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="From unit">{(id) => <Input id={id} type="number" min={1} max={rack.uHeight} value={startU} onChange={(e) => setStart(e.target.value)} autoFocus />}</Field>
      <Field label="To unit">{(id) => <Input id={id} type="number" min={1} max={rack.uHeight} value={endU} onChange={(e) => setEnd(e.target.value)} />}</Field>
      <div className="col-span-2">
        <Field label="Reserved for" hint="Only this customer’s equipment can use these units. Leave empty for an internal hold.">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={customerId} onChange={(e) => setCustomer(e.target.value)}>
              <option value="">Internal hold (company equipment only)</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="col-span-2">
        <Field label="Reason">{(id) => <Input id={id} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Order #1042, 4U colocation" />}</Field>
      </div>
      <Field label="Expires" hint="Optional">
        {(id, d) => <Input id={id} aria-describedby={d} type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />}
      </Field>
      <ErrorNote error={m.error} className="col-span-2" />
      <div className="col-span-2 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          Reserve units
        </Button>
      </div>
    </form>
  );
}

export function RackDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canWrite = can('dcim.write');
  const elev = useQuery({ queryKey: ['dcim', 'elevation', id], queryFn: () => api.get<ElevationT>(`/dcim/racks/${id}/elevation`) });
  const events = useQuery({ queryKey: ['dcim', 'rack-events', id], queryFn: () => api.get<EventT[]>(`/dcim/racks/${id}/events`) });
  const unracked = useQuery({
    queryKey: ['dcim', 'devices', 'unracked', ''],
    queryFn: () => api.get<Paginated<DeviceT>>(`/dcim/devices${qs({ unracked: 'true', pageSize: 30, sort: 'updated' })}`),
    enabled: canWrite,
    placeholderData: keepPreviousData,
  });
  const [dialog, setDialog] = useState<null | 'edit' | 'move' | 'reserve' | 'delete'>(null);
  const [placing, setPlacing] = useState<{ u: number; face: RackFace; deviceId?: string } | null>(null);
  const [dragging, setDragging] = useState<{ id: string; uHeight: number } | null>(null);
  const [dropError, setDropError] = useState<unknown>(null);

  useEffect(() => {
    const h = (e: Event) => setDragging((e as CustomEvent).detail);
    window.addEventListener('cdcim-drag', h);
    return () => window.removeEventListener('cdcim-drag', h);
  }, []);

  const placeMut = useMutation({
    mutationFn: (v: { deviceId: string; u: number; face: RackFace }) => api.post(`/dcim/devices/${v.deviceId}/placement`, { rackId: id, positionU: v.u, face: v.face }),
    onMutate: () => setDropError(null),
    onError: (e) => setDropError(e),
    onSettled: () => qc.invalidateQueries({ queryKey: ['dcim'] }),
  });
  const removeReservation = useMutation({
    mutationFn: (rid: string) => api.delete(`/dcim/racks/${id}/reservations/${rid}`),
    onSettled: () => qc.invalidateQueries({ queryKey: ['dcim'] }),
  });
  const del = useMutation({
    mutationFn: () => api.delete(`/dcim/racks/${id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
      navigate('/racks');
    },
  });

  if (elev.isLoading) return <Loading />;
  if (elev.error) return <ErrorNote error={elev.error} />;
  const data = elev.data!;
  const { rack } = data;
  const onDrop = (deviceId: string, u: number, face: RackFace) => placeMut.mutate({ deviceId, u, face });

  return (
    <>
      <PageHeader
        title={`Rack ${rack.name}`}
        description={
          <>
            <span className="font-mono">{rack.location.datacenterCode}</span> / {rack.location.buildingName} / {rack.location.roomName}
            {rack.location.rowName ? ` / row ${rack.location.rowName}` : ''}. {rack.uHeight}U, {rack.depthMm} mm deep
            {rack.customerName ? `, dedicated to ${rack.customerName}` : ''}.
          </>
        }
        actions={
          canWrite && (
            <>
              <Button onClick={() => setPlacing({ u: 1, face: 'front' })}>Place equipment</Button>
              <Button onClick={() => setDialog('reserve')}>Reserve units</Button>
              <Button onClick={() => setDialog('move')}>Move rack</Button>
              <Button onClick={() => setDialog('edit')}>Edit</Button>
              <Button variant="ghost" onClick={() => setDialog('delete')}>
                Delete
              </Button>
            </>
          )
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Units used', String(rack.usedU)],
          ['Units free', String(rack.freeU)],
          ['Units reserved', String(rack.reservedU)],
          ['Devices', String(rack.deviceCount)],
        ].map(([label, value]) => (
          <div key={label} className="glass rounded-2xl px-4 py-3">
            <p className="text-[13px] text-ink-2">{label}</p>
            <p className="text-[22px] font-semibold tracking-[-0.02em]">{value}</p>
          </div>
        ))}
      </div>
      {dropError ? <ErrorNote error={dropError} className="mb-4" /> : null}
      <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
        <Panel
          title="Elevation"
          actions={
            <span className="flex flex-wrap items-center gap-3 text-[12px] text-ink-2">
              <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm border border-[#6fd9a6] bg-[#1f7a52]" />Active</span>
              <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm border border-[#9fb0ff] bg-[#3149b8]" />Company</span>
              <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm border border-[#b9adf5] bg-[#5f4fb0]" />Customer-owned</span>
              <span className="flex items-center gap-1"><span className="size-2.5 rounded-sm border border-[#f0c46a] bg-[#a8720f]" />Maintenance</span>
            </span>
          }
        >
          {canWrite && <p className="mb-3 text-[13px] text-ink-3">Drag equipment onto a unit to place or move it, or click an empty unit to choose what goes there. Placements are checked by the server: overlaps, height and depth are refused.</p>}
          <div className="flex flex-col gap-5 overflow-x-auto sm:flex-row">
            {(['front', 'rear'] as const).map((face) => (
              <RackFaceView key={face} data={data} face={face} canWrite={canWrite} dragging={dragging} onDropDevice={onDrop} onPickUnit={(u, f) => setPlacing({ u, face: f })} />
            ))}
          </div>
          {placeMut.isPending && <p className="mt-2 text-[13px] text-ink-3" role="status">Saving placement…</p>}
        </Panel>
        <div className="flex flex-col gap-5">
          {canWrite && (
            <Panel title="Not in a rack" flush>
              <p className="px-4 pt-3 text-[12.5px] text-ink-3">Drag onto the elevation.</p>
              <ul className="max-h-80 overflow-y-auto p-2">
                {(unracked.data?.items ?? [])
                  .filter((d) => d.lifecycleState !== 'retired')
                  .map((d) => (
                    <li
                      key={d.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DND_TYPE, d.id);
                        setDragging({ id: d.id, uHeight: d.model.uHeight });
                      }}
                      onDragEnd={() => setDragging(null)}
                      className="mb-1 cursor-grab rounded-lg border border-rule bg-field px-2.5 py-1.5 active:cursor-grabbing"
                    >
                      <span className="block truncate text-[13px] font-medium">{d.hostname || d.assetTag}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {d.model.name}, {d.model.uHeight}U{!d.model.fullDepth ? ' ½' : ''}
                      </span>
                    </li>
                  ))}
                {unracked.data?.items.length === 0 && <li className="p-2 text-[13px] text-ink-3">Everything is racked.</li>}
              </ul>
            </Panel>
          )}
          {data.zeroU.length > 0 && (
            <Panel title="0U equipment">
              <ul className="flex flex-col gap-1.5 text-[13px]">
                {data.zeroU.map((d) => (
                  <li key={d.id}>
                    <Link to={`/hardware/${d.id}`} className="text-accent hover:underline">
                      {d.hostname || d.assetTag}
                    </Link>{' '}
                    <span className="text-ink-3">{CATEGORY_LABELS[d.category]}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title="Reservations">
            {data.reservations.length === 0 ? (
              <p className="text-[13px] text-ink-3">No reserved units.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-[13px]">
                {data.reservations.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-2">
                    <span>
                      <strong>
                        U{r.startU}–U{r.endU}
                      </strong>{' '}
                      {r.customerName ?? 'Internal hold'}
                      <span className="block text-ink-3">
                        {r.reason}
                        {r.expiresAt ? `, ${r.expired ? 'expired' : 'until'} ${new Date(r.expiresAt).toLocaleDateString()}` : ''}
                      </span>
                    </span>
                    {canWrite && (
                      <Button size="sm" variant="ghost" busy={removeReservation.isPending && removeReservation.variables === r.id} onClick={() => removeReservation.mutate(r.id)}>
                        Release
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="History">
            <ol className="flex flex-col gap-2.5 text-[13px]">
              {(events.data ?? []).slice(0, 12).map((e) => (
                <li key={e.id}>
                  <span className="text-ink">{e.summary}</span>
                  <span className="block text-[12px] text-ink-3">
                    {e.actorLabel}, {relativeTime(e.occurredAt)}
                  </span>
                </li>
              ))}
              {events.data?.length === 0 && <li className="text-ink-3">No history yet.</li>}
            </ol>
          </Panel>
        </div>
      </div>
      <Modal wide open={dialog === 'edit'} onOpenChange={(o) => !o && setDialog(null)} title={`Edit rack ${rack.name}`}>
        {dialog === 'edit' && <RackForm rack={rack} onClose={() => setDialog(null)} />}
      </Modal>
      <Modal open={dialog === 'move'} onOpenChange={(o) => !o && setDialog(null)} title={`Move rack ${rack.name}`}>
        {dialog === 'move' && <MoveRackForm rack={rack} onClose={() => setDialog(null)} />}
      </Modal>
      <Modal open={dialog === 'reserve'} onOpenChange={(o) => !o && setDialog(null)} title="Reserve rack units">
        {dialog === 'reserve' && <ReserveForm rack={rack} onClose={() => setDialog(null)} />}
      </Modal>
      <Modal wide open={!!placing} onOpenChange={(o) => !o && setPlacing(null)} title={`Place equipment in ${rack.name}`}>
        {placing && <PlaceDialog rack={rack} preset={placing} onClose={() => setPlacing(null)} />}
      </Modal>
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && (setDialog(null), del.reset())}
        title={`Delete rack ${rack.name}?`}
        body="Only empty racks can be deleted. Its reservations and history are removed too."
        confirmLabel="Delete rack"
        busy={del.isPending}
        error={del.error}
        onConfirm={() => del.mutate()}
      />
    </>
  );
}
