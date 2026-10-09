import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTree, type BuildingT, type DatacenterT, type RoomT, type RowT } from '../lib/dcim';
import { Button, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table, Textarea } from '../components/ui';

const invalidateDcim = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: ['dcim'] });

/* ------------------------------------------------------------------ datacenters */

function DatacenterForm({ dc, onClose }: { dc?: DatacenterT; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: dc?.code ?? '', name: dc?.name ?? '', address: dc?.address ?? '', city: dc?.city ?? '', country: dc?.country ?? '', timezone: dc?.timezone ?? '', notes: dc?.notes ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => {
      const body = { ...f, address: f.address || null, city: f.city || null, country: f.country || null, timezone: f.timezone || null, notes: f.notes || null };
      return dc ? api.patch(`/dcim/datacenters/${dc.id}`, body) : api.post('/dcim/datacenters', body);
    },
    onSuccess: async () => {
      await invalidateDcim(qc);
      onClose();
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
      <Field label="Code" hint="Short site code used in labels and exports, e.g. MUM1.">
        {(id, d) => <Input id={id} aria-describedby={d} required value={f.code} onChange={set('code')} className="font-mono uppercase" autoFocus />}
      </Field>
      <Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} />}</Field>
      <div className="sm:col-span-2">
        <Field label="Address">{(id) => <Input id={id} value={f.address} onChange={set('address')} />}</Field>
      </div>
      <Field label="City">{(id) => <Input id={id} value={f.city} onChange={set('city')} />}</Field>
      <Field label="Country">{(id) => <Input id={id} value={f.country} onChange={set('country')} />}</Field>
      <Field label="Time zone" hint="Optional, e.g. Asia/Kolkata">
        {(id, d) => <Input id={id} aria-describedby={d} value={f.timezone} onChange={set('timezone')} />}
      </Field>
      <div className="sm:col-span-2">
        <Field label="Notes">{(id) => <Textarea id={id} value={f.notes} onChange={set('notes')} />}</Field>
      </div>
      <ErrorNote error={m.error} className="sm:col-span-2" />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          {dc ? 'Save changes' : 'Add datacenter'}
        </Button>
      </div>
    </form>
  );
}

export function DatacentersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['dcim', 'datacenters'], queryFn: () => api.get<DatacenterT[]>('/dcim/datacenters') });
  const [editing, setEditing] = useState<DatacenterT | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DatacenterT | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/dcim/datacenters/${id}`),
    onSuccess: async () => {
      setDeleting(null);
      await invalidateDcim(qc);
    },
  });
  return (
    <>
      <PageHeader
        title="Datacenters"
        description="Sites you operate. Each one contains buildings, rooms, rows and racks."
        actions={can('dcim.write') && <Button variant="primary" onClick={() => setEditing('new')}>Add datacenter</Button>}
      />
      <Panel flush>
        {list.isLoading && <Loading />}
        <ErrorNote error={list.error} className="m-4" />
        {list.data?.length === 0 && (
          <EmptyState title="No datacenters yet" action={can('dcim.write') && <Button variant="primary" onClick={() => setEditing('new')}>Add datacenter</Button>}>
            Start with your first site, then add its buildings and rooms.
          </EmptyState>
        )}
        {!!list.data?.length && (
          <Table label="Datacenters">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Location</th>
                <th>Buildings</th>
                <th>Rooms</th>
                <th>Racks</th>
                <th>Racked devices</th>
                <th className="sr-only">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((dc) => (
                <tr key={dc.id} className="hover:bg-sunken/50">
                  <td className="font-mono text-[13px] font-medium">{dc.code}</td>
                  <td>
                    <Link to={`/racks?datacenterId=${dc.id}`} className="font-medium text-accent hover:underline">
                      {dc.name}
                    </Link>
                  </td>
                  <td className="text-ink-2">{[dc.city, dc.country].filter(Boolean).join(', ') || '—'}</td>
                  <td>{dc.counts?.buildings}</td>
                  <td>{dc.counts?.rooms}</td>
                  <td>{dc.counts?.racks}</td>
                  <td>{dc.counts?.devices}</td>
                  <td className="text-right whitespace-nowrap">
                    {can('dcim.write') && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(dc)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(dc)}>
                          Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Modal wide open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add datacenter' : `Edit ${editing?.name ?? ''}`}>
        {editing !== null && <DatacenterForm dc={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && (setDeleting(null), del.reset())}
        title={`Delete ${deleting?.name}?`}
        body="Only empty datacenters can be deleted. This can’t be undone."
        confirmLabel="Delete datacenter"
        busy={del.isPending}
        error={del.error}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ buildings, rooms, rows */

type Editing =
  | { kind: 'building'; datacenterId: string; item?: BuildingT }
  | { kind: 'room'; buildingId: string; item?: RoomT }
  | { kind: 'row'; roomId: string; item?: RowT };

function HierarchyForm({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const qc = useQueryClient();
  const item = editing.item as (BuildingT & RoomT & RowT) | undefined;
  const [name, setName] = useState(item?.name ?? '');
  const [floor, setFloor] = useState(item?.floor ?? '');
  const [cols, setCols] = useState(String(item?.gridCols ?? 20));
  const [rows, setRows] = useState(String(item?.gridRows ?? 12));
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [position, setPosition] = useState(String(item?.position ?? 0));
  const m = useMutation({
    mutationFn: () => {
      if (editing.kind === 'building') {
        const body = { datacenterId: editing.datacenterId, name, notes: notes || null };
        return item ? api.patch(`/dcim/buildings/${item.id}`, body) : api.post('/dcim/buildings', body);
      }
      if (editing.kind === 'room') {
        const body = { buildingId: editing.buildingId, name, floor: floor || null, gridCols: Number(cols), gridRows: Number(rows), notes: notes || null };
        return item ? api.patch(`/dcim/rooms/${item.id}`, body) : api.post('/dcim/rooms', body);
      }
      const body = { roomId: editing.roomId, name, position: Number(position) };
      return item ? api.patch(`/dcim/rows/${item.id}`, body) : api.post('/dcim/rows', body);
    },
    onSuccess: async () => {
      await invalidateDcim(qc);
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
      <Field label="Name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
      {editing.kind === 'room' && (
        <>
          <Field label="Floor">{(id) => <Input id={id} value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="e.g. 2 or Ground" />}</Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Floor plan width" hint="Tiles across (1–200)">
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={200} value={cols} onChange={(e) => setCols(e.target.value)} />}
            </Field>
            <Field label="Floor plan depth" hint="Tiles deep (1–200)">
              {(id, d) => <Input id={id} aria-describedby={d} type="number" min={1} max={200} value={rows} onChange={(e) => setRows(e.target.value)} />}
            </Field>
          </div>
        </>
      )}
      {editing.kind === 'row' && (
        <Field label="Sort position" hint="Lower numbers are listed first">
          {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} value={position} onChange={(e) => setPosition(e.target.value)} />}
        </Field>
      )}
      {editing.kind !== 'row' && <Field label="Notes">{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>}
      <ErrorNote error={m.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          {item ? 'Save changes' : `Add ${editing.kind}`}
        </Button>
      </div>
    </form>
  );
}

export function RoomsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const tree = useTree();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'building' | 'room' | 'row'; id: string; name: string } | null>(null);
  const [dcFilter, setDcFilter] = useState('');
  const write = can('dcim.write');
  const del = useMutation({
    mutationFn: (d: { kind: string; id: string }) => api.delete(`/dcim/${d.kind === 'row' ? 'rows' : `${d.kind}s`}/${d.id}`),
    onSuccess: async () => {
      setDeleting(null);
      await invalidateDcim(qc);
    },
  });

  const dcs = (tree.data ?? []).filter((d) => !dcFilter || d.id === dcFilter);
  return (
    <>
      <PageHeader
        title="Buildings and rooms"
        description="The layout inside each datacenter. Rows group racks within a room; a room’s floor plan size sets where racks can stand."
        actions={
          (tree.data?.length ?? 0) > 1 && (
            <Select aria-label="Datacenter" className="w-56" value={dcFilter} onChange={(e) => setDcFilter(e.target.value)}>
              <option value="">All datacenters</option>
              {tree.data!.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code} · {d.name}
                </option>
              ))}
            </Select>
          )
        }
      />
      {tree.isLoading && <Loading />}
      <ErrorNote error={tree.error} />
      {tree.data?.length === 0 && (
        <Panel>
          <EmptyState title="Add a datacenter first" action={<Link to="/datacenters" className="text-accent hover:underline">Go to Datacenters</Link>}>
            Buildings and rooms belong to a datacenter.
          </EmptyState>
        </Panel>
      )}
      <div className="flex flex-col gap-5">
        {dcs.map((dc) => (
          <Panel
            key={dc.id}
            title={
              <span>
                <span className="font-mono">{dc.code}</span> <span className="font-normal text-ink-2">{dc.name}</span>
              </span>
            }
            actions={write && <Button size="sm" onClick={() => setEditing({ kind: 'building', datacenterId: dc.id })}>Add building</Button>}
          >
            {dc.buildings.length === 0 && <p className="text-ink-2">No buildings yet.</p>}
            <div className="flex flex-col gap-4">
              {dc.buildings.map((b) => (
                <section key={b.id} className="rounded-xl border border-rule bg-sunken p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">{b.name}</h3>
                    {write && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: 'room', buildingId: b.id })}>
                          Add room
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: 'building', datacenterId: dc.id, item: b })}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting({ kind: 'building', id: b.id, name: b.name })}>
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                  {b.rooms.length === 0 ? (
                    <p className="mt-1 text-[13px] text-ink-3">No rooms yet.</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-rule rounded-lg border border-rule bg-panel">
                      {b.rooms.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5">
                          <div className="min-w-48 flex-1">
                            <Link to={`/floor-plans?roomId=${r.id}`} className="font-medium text-accent hover:underline">
                              {r.name}
                            </Link>
                            <span className="ml-2 text-[12.5px] text-ink-3">
                              {r.floor ? `Floor ${r.floor}, ` : ''}
                              {r.gridCols} × {r.gridRows} tiles, {r.rackCount} rack{r.rackCount === 1 ? '' : 's'}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {r.rows.map((row) => (
                              <span key={row.id} className="inline-flex items-center gap-1 rounded-md border border-rule px-1.5 py-0.5 text-[12.5px]">
                                Row {row.name}
                                {write && (
                                  <>
                                    <button className="text-ink-3 hover:text-ink" aria-label={`Edit row ${row.name}`} onClick={() => setEditing({ kind: 'row', roomId: r.id, item: row })}>
                                      ✎
                                    </button>
                                    <button className="text-ink-3 hover:text-crit" aria-label={`Delete row ${row.name}`} onClick={() => setDeleting({ kind: 'row', id: row.id, name: `row ${row.name}` })}>
                                      ×
                                    </button>
                                  </>
                                )}
                              </span>
                            ))}
                            {write && (
                              <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: 'row', roomId: r.id })}>
                                Add row
                              </Button>
                            )}
                          </div>
                          {write && (
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: 'room', buildingId: b.id, item: r })}>
                                Edit
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setDeleting({ kind: 'room', id: r.id, name: r.name })}>
                                Delete
                              </Button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </Panel>
        ))}
      </div>
      <Modal open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing ? `${editing.item ? 'Edit' : 'Add'} ${editing.kind}` : ''}>
        {editing && <HierarchyForm editing={editing} onClose={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && (setDeleting(null), del.reset())}
        title={`Delete ${deleting?.name}?`}
        body={deleting?.kind === 'row' ? 'Racks in this row stay in the room without a row.' : `Only an empty ${deleting?.kind} can be deleted.`}
        confirmLabel="Delete"
        busy={del.isPending}
        error={del.error}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </>
  );
}
