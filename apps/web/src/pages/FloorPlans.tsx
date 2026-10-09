import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { roomOptions, useRacks, useTree, type RackT } from '../lib/dcim';
import { Button, EmptyState, ErrorNote, Loading, Modal, PageHeader, Panel, Select, cx } from '../components/ui';
import { OccupancyBar, RackForm } from './Racks';

const TILE = 46;
const DND = 'application/x-cdcim-rack';

function rackFill(r: RackT) {
  if (r.status === 'decommissioned') return 'bg-sunken text-ink-3 border-rule';
  const pct = r.usedU / r.uHeight;
  if (r.customerId) return 'bg-est-soft border-est text-ink';
  if (pct >= 0.9) return 'bg-crit-soft border-crit/60 text-ink';
  if (pct >= 0.75) return 'bg-warn-soft border-warn/60 text-ink';
  return 'bg-accent-soft border-accent/50 text-ink';
}

/**
 * Room floor plan: a tile grid with racks placed on it. Racks can be dragged
 * to a free tile, or picked from the side list and then placed by clicking a
 * tile (keyboard-friendly). Every move is saved and recorded in rack history.
 */
export function FloorPlansPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const tree = useTree();
  const rooms = roomOptions(tree.data);
  const [params, setParams] = useSearchParams();
  const roomId = params.get('roomId') ?? rooms[0]?.id ?? '';
  const room = rooms.find((r) => r.id === roomId);
  const racks = useRacks(qs({ roomId }));
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const canWrite = can('dcim.write');

  const move = useMutation({
    mutationFn: (v: { rack: RackT; x: number | null; y: number | null }) =>
      api.post(`/dcim/racks/${v.rack.id}/move`, { roomId, rowId: v.rack.rowId, gridX: v.x, gridY: v.y, reason: 'Floor plan' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['dcim'] }),
    onSuccess: () => setSelected(null),
  });

  if (tree.isLoading) return <Loading />;
  if (!rooms.length) {
    return (
      <>
        <PageHeader title="Floor plans" />
        <Panel>
          <EmptyState title="No rooms yet" action={<Link className="text-accent hover:underline" to="/rooms">Add buildings and rooms</Link>}>
            A floor plan belongs to a room.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const placed = (racks.data ?? []).filter((r) => r.gridX !== null && r.gridY !== null);
  const unplaced = (racks.data ?? []).filter((r) => r.gridX === null || r.gridY === null);
  const at = new Map(placed.map((r) => [`${r.gridX},${r.gridY}`, r]));
  const cols = room?.room.gridCols ?? 1;
  const rows = room?.room.gridRows ?? 1;
  const rackById = (id: string) => racks.data?.find((r) => r.id === id);

  const dropOn = (x: number, y: number, rackId: string) => {
    const rack = rackById(rackId);
    if (!rack || at.has(`${x},${y}`)) return;
    move.mutate({ rack, x, y });
  };

  return (
    <>
      <PageHeader
        title="Floor plans"
        description="Where each rack stands in the room. Colour shows how full a rack is; violet racks are dedicated to a customer."
        actions={
          <>
            <Select aria-label="Room" className="w-72" value={roomId} onChange={(e) => (setParams({ roomId: e.target.value }), setSelected(null))}>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
            {canWrite && <Button variant="primary" onClick={() => setAdding(true)}>Add rack</Button>}
          </>
        }
      />
      <ErrorNote error={move.error} className="mb-4" />
      <div className="grid gap-5 xl:grid-cols-[1fr_260px]">
        <Panel title={`${room?.label} (${cols} × ${rows} tiles)`} flush>
          {racks.isLoading ? (
            <Loading />
          ) : (
            <div className="overflow-auto p-4">
              <div
                className="relative grid rounded-lg border border-rule bg-[linear-gradient(var(--rule)_1px,transparent_1px),linear-gradient(90deg,var(--rule)_1px,transparent_1px)]"
                style={{ gridTemplateColumns: `repeat(${cols}, ${TILE}px)`, gridTemplateRows: `repeat(${rows}, ${TILE}px)`, backgroundSize: `${TILE}px ${TILE}px`, width: cols * TILE, height: rows * TILE }}
                role="grid"
                aria-label="Room floor plan"
              >
                {Array.from({ length: rows }, (_, y) =>
                  Array.from({ length: cols }, (_, x) => {
                    const r = at.get(`${x},${y}`);
                    const key = `${x},${y}`;
                    if (r) {
                      return (
                        <Link
                          key={key}
                          to={`/racks/${r.id}`}
                          role="gridcell"
                          draggable={canWrite}
                          onDragStart={(e) => e.dataTransfer.setData(DND, r.id)}
                          title={`${r.name}: ${r.usedU}/${r.uHeight}U used${r.customerName ? `, dedicated to ${r.customerName}` : ''}`}
                          className={cx('m-[3px] flex flex-col items-center justify-center rounded-md border text-[11px] leading-tight font-semibold shadow-sm hover:brightness-105', rackFill(r), selected === r.id && 'ring-2 ring-accent')}
                          style={{ gridColumn: x + 1, gridRow: y + 1 }}
                        >
                          <span className="max-w-full truncate px-0.5">{r.name}</span>
                          <span className="text-[9.5px] font-normal text-ink-2">{Math.round((r.usedU / r.uHeight) * 100)}%</span>
                        </Link>
                      );
                    }
                    return (
                      <button
                        key={key}
                        type="button"
                        role="gridcell"
                        aria-label={`Empty tile ${x + 1}, ${y + 1}${selected ? ': place selected rack here' : ''}`}
                        disabled={!canWrite || !selected}
                        onClick={() => selected && dropOn(x, y, selected)}
                        onDragOver={(e) => {
                          if (!canWrite) return;
                          e.preventDefault();
                          setHover(key);
                        }}
                        onDragLeave={() => setHover((h) => (h === key ? null : h))}
                        onDrop={(e) => {
                          e.preventDefault();
                          setHover(null);
                          const id = e.dataTransfer.getData(DND);
                          if (id) dropOn(x, y, id);
                        }}
                        className={cx('m-px rounded-sm', hover === key && 'bg-ok/30', selected && canWrite && 'hover:bg-accent-soft')}
                        style={{ gridColumn: x + 1, gridRow: y + 1 }}
                      />
                    );
                  }),
                )}
              </div>
            </div>
          )}
        </Panel>
        <div className="flex flex-col gap-5">
          <Panel title="Not on the floor plan">
            {unplaced.length === 0 ? (
              <p className="text-[13px] text-ink-3">Every rack in this room has a position.</p>
            ) : (
              <>
                {canWrite && <p className="mb-2 text-[12.5px] text-ink-3">Drag a rack onto a tile, or select it and click a tile.</p>}
                <ul className="flex flex-col gap-1.5">
                  {unplaced.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        draggable={canWrite}
                        onDragStart={(e) => e.dataTransfer.setData(DND, r.id)}
                        onClick={() => setSelected(selected === r.id ? null : r.id)}
                        aria-pressed={selected === r.id}
                        className={cx('w-full rounded-lg border px-2.5 py-1.5 text-left', selected === r.id ? 'border-accent bg-accent-soft' : 'border-rule bg-field', canWrite && 'cursor-grab')}
                      >
                        <span className="block text-[13px] font-medium">{r.name}</span>
                        <OccupancyBar rack={r} className="mt-1" />
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Panel>
          {canWrite && placed.length > 0 && (
            <Panel title="Remove from plan">
              <p className="mb-2 text-[12.5px] text-ink-3">Takes a rack off the floor plan without moving its equipment.</p>
              <Select
                aria-label="Rack to remove from plan"
                value=""
                onChange={(e) => {
                  const r = rackById(e.target.value);
                  if (r) move.mutate({ rack: r, x: null, y: null });
                }}
              >
                <option value="">Choose a rack</option>
                {placed.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Panel>
          )}
          <Panel title="Legend">
            <ul className="flex flex-col gap-1.5 text-[12.5px] text-ink-2">
              <li className="flex items-center gap-2"><span className="size-3 rounded-sm border border-accent/50 bg-accent-soft" />Under 75% full</li>
              <li className="flex items-center gap-2"><span className="size-3 rounded-sm border border-warn/60 bg-warn-soft" />75–90% full</li>
              <li className="flex items-center gap-2"><span className="size-3 rounded-sm border border-crit/60 bg-crit-soft" />Over 90% full</li>
              <li className="flex items-center gap-2"><span className="size-3 rounded-sm border border-est bg-est-soft" />Dedicated to a customer</li>
            </ul>
          </Panel>
        </div>
      </div>
      <Modal wide open={adding} onOpenChange={setAdding} title="Add rack">
        {adding && <RackForm defaultRoomId={roomId} onClose={() => setAdding(false)} />}
      </Modal>
    </>
  );
}
