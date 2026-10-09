import { useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  CATEGORY_LABELS,
  DEVICE_CATEGORIES,
  LIFECYCLE_LABELS,
  LIFECYCLE_STATES,
  SPARE_PART_KINDS,
  SPARE_PART_LABELS,
  type DeviceCategory,
  type LifecycleState,
} from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import { daysUntil, STATE_TONE, useManufacturers, useModels, useTree, type DeviceT, type ModelT, type SparePartT } from '../lib/dcim';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Table, Textarea, cx } from '../components/ui';
import { useCustomerOptions } from './Racks';

/* ------------------------------------------------------------------ device form */

type DiskRow = { slot: string; type: string; sizeGb: string; model: string };
type NicRow = { name: string; mac: string; speed: string };

export function DeviceForm({ device, onClose }: { device?: DeviceT; onClose: (saved?: { id: string }) => void }) {
  const qc = useQueryClient();
  const models = useModels();
  const customers = useCustomerOptions();
  const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
  const [f, setF] = useState({
    modelId: device?.model.id ?? '',
    assetTag: device?.assetTag ?? '',
    hostname: s(device?.hostname),
    serial: s(device?.serial),
    ownership: device?.ownership ?? 'company',
    customerId: s(device?.customerId),
    initialState: 'planned',
    cpu: s(device?.cpu),
    cpuCount: s(device?.cpuCount),
    ramGb: s(device?.ramGb),
    dimmLayout: s(device?.dimmLayout),
    raid: s(device?.raid),
    mgmtType: s(device?.mgmtType),
    mgmtAddress: s(device?.mgmtAddress),
    biosVersion: s(device?.biosVersion),
    bmcFirmware: s(device?.bmcFirmware),
    os: s(device?.os),
    purchaseDate: s(device?.purchaseDate),
    supplier: s(device?.supplier),
    purchaseCost: s(device?.purchaseCost),
    currency: s(device?.currency),
    warrantyExpires: s(device?.warrantyExpires),
    eolDate: s(device?.eolDate),
    notes: s(device?.notes),
  });
  const [disks, setDisks] = useState<DiskRow[]>((device?.disks ?? []).map((d) => ({ slot: s(d.slot), type: d.type, sizeGb: String(d.sizeGb), model: s(d.model) })));
  const [nics, setNics] = useState<NicRow[]>((device?.nics ?? []).map((n) => ({ name: n.name, mac: s(n.mac), speed: s(n.speed) })));
  const [custom, setCustom] = useState<{ k: string; v: string }[]>(Object.entries(device?.custom ?? {}).map(([k, v]) => ({ k, v: s(v as string) })));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const n = (v: string) => (v.trim() === '' ? null : Number(v));
  const t = (v: string) => (v.trim() === '' ? null : v.trim());
  const m = useMutation({
    mutationFn: () => {
      const body = {
        modelId: f.modelId,
        assetTag: f.assetTag,
        hostname: t(f.hostname),
        serial: t(f.serial),
        ownership: f.ownership,
        customerId: t(f.customerId),
        cpu: t(f.cpu),
        cpuCount: n(f.cpuCount),
        ramGb: n(f.ramGb),
        dimmLayout: t(f.dimmLayout),
        disks: disks.filter((d) => d.type).map((d) => ({ slot: t(d.slot), type: d.type, sizeGb: Number(d.sizeGb || 0), model: t(d.model) })),
        raid: t(f.raid),
        nics: nics.filter((x) => x.name).map((x) => ({ name: x.name, mac: t(x.mac), speed: t(x.speed) })),
        mgmtType: t(f.mgmtType),
        mgmtAddress: t(f.mgmtAddress),
        biosVersion: t(f.biosVersion),
        bmcFirmware: t(f.bmcFirmware),
        os: t(f.os),
        purchaseDate: t(f.purchaseDate),
        supplier: t(f.supplier),
        purchaseCost: n(f.purchaseCost),
        currency: t(f.currency)?.toUpperCase() ?? null,
        warrantyExpires: t(f.warrantyExpires),
        eolDate: t(f.eolDate),
        notes: t(f.notes),
        custom: Object.fromEntries(custom.filter((c) => c.k.trim()).map((c) => [c.k.trim(), c.v])),
        ...(device ? {} : { initialState: f.initialState }),
      };
      return device ? api.patch<{ id: string }>(`/dcim/devices/${device.id}`, body) : api.post<{ id: string }>('/dcim/devices', body);
    },
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose(saved);
    },
  });
  const model = models.data?.find((x) => x.id === f.modelId);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 font-semibold">Identity</legend>
        <Field label="Model" hint={model ? `${model.uHeight}U${model.fullDepth ? '' : ', half-depth'}${model.depthMm ? `, ${model.depthMm} mm deep` : ''}` : 'Add models under the Models tab'}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} required value={f.modelId} onChange={set('modelId')}>
              <option value="">Choose a model</option>
              {models.data?.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.manufacturerName} {x.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Asset tag">{(id) => <Input id={id} required value={f.assetTag} onChange={set('assetTag')} className="font-mono" />}</Field>
        <Field label="Hostname">{(id) => <Input id={id} value={f.hostname} onChange={set('hostname')} />}</Field>
        <Field label="Serial number">{(id) => <Input id={id} value={f.serial} onChange={set('serial')} className="font-mono" />}</Field>
        <Field label="Owned by">
          {(id) => (
            <Select id={id} value={f.ownership} onChange={(e) => setF((x) => ({ ...x, ownership: e.target.value as 'company' | 'customer' }))}>
              <option value="company">Crapplet (company-owned)</option>
              <option value="customer">Customer (colocated equipment)</option>
            </Select>
          )}
        </Field>
        <Field label={f.ownership === 'customer' ? 'Customer (owner)' : 'Assigned to customer'} hint={f.ownership === 'company' ? 'Optional: the customer renting this server' : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} required={f.ownership === 'customer'} value={f.customerId} onChange={set('customerId')}>
              <option value="">{f.ownership === 'customer' ? 'Choose a customer' : 'Not assigned'}</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!device && (
          <Field label="Starting state">
            {(id) => (
              <Select id={id} value={f.initialState} onChange={set('initialState')}>
                <option value="planned">Planned (ordered, not yet here)</option>
                <option value="received">Received</option>
                <option value="inventory">In inventory</option>
              </Select>
            )}
          </Field>
        )}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Hardware</legend>
        <div className="sm:col-span-2">
          <Field label="CPU">{(id) => <Input id={id} value={f.cpu} onChange={set('cpu')} placeholder="e.g. Intel Xeon Gold 6230" />}</Field>
        </div>
        <Field label="Sockets">{(id) => <Input id={id} type="number" min={0} value={f.cpuCount} onChange={set('cpuCount')} />}</Field>
        <Field label="RAM (GB)">{(id) => <Input id={id} type="number" min={0} value={f.ramGb} onChange={set('ramGb')} />}</Field>
        <div className="sm:col-span-2">
          <Field label="DIMM layout">{(id) => <Input id={id} value={f.dimmLayout} onChange={set('dimmLayout')} placeholder="e.g. 12 × 32GB DDR4-2933" />}</Field>
        </div>
        <Field label="RAID">{(id) => <Input id={id} value={f.raid} onChange={set('raid')} placeholder="e.g. PERC H730, RAID 10" />}</Field>
        <Field label="Operating system">{(id) => <Input id={id} value={f.os} onChange={set('os')} />}</Field>
        <Field label="BIOS version">{(id) => <Input id={id} value={f.biosVersion} onChange={set('biosVersion')} />}</Field>
      </fieldset>

      <fieldset>
        <legend className="mb-2 font-semibold">Disks</legend>
        <div className="flex flex-col gap-2">
          {disks.map((d, i) => (
            <div key={i} className="grid grid-cols-[70px_100px_100px_1fr_auto] gap-2">
              <Input aria-label="Slot" placeholder="Slot" value={d.slot} onChange={(e) => setDisks((x) => x.map((y, j) => (j === i ? { ...y, slot: e.target.value } : y)))} />
              <Select aria-label="Type" value={d.type} onChange={(e) => setDisks((x) => x.map((y, j) => (j === i ? { ...y, type: e.target.value } : y)))}>
                {['SSD', 'NVMe', 'HDD', 'SAS'].map((tp) => (
                  <option key={tp}>{tp}</option>
                ))}
              </Select>
              <Input aria-label="Size in GB" type="number" min={0} placeholder="GB" value={d.sizeGb} onChange={(e) => setDisks((x) => x.map((y, j) => (j === i ? { ...y, sizeGb: e.target.value } : y)))} />
              <Input aria-label="Disk model" placeholder="Model" value={d.model} onChange={(e) => setDisks((x) => x.map((y, j) => (j === i ? { ...y, model: e.target.value } : y)))} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setDisks((x) => x.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" size="sm" onClick={() => setDisks((x) => [...x, { slot: String(x.length), type: 'SSD', sizeGb: '', model: '' }])}>
              Add disk
            </Button>
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 font-semibold">Network adapters and management</legend>
        <div className="flex flex-col gap-2">
          {nics.map((x, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.4fr_100px_auto] gap-2">
              <Input aria-label="Port name" placeholder="eno1" value={x.name} onChange={(e) => setNics((a) => a.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
              <Input aria-label="MAC address" placeholder="aa:bb:cc:dd:ee:ff" className="font-mono" value={x.mac} onChange={(e) => setNics((a) => a.map((y, j) => (j === i ? { ...y, mac: e.target.value } : y)))} />
              <Input aria-label="Speed" placeholder="10G" value={x.speed} onChange={(e) => setNics((a) => a.map((y, j) => (j === i ? { ...y, speed: e.target.value } : y)))} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setNics((a) => a.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" size="sm" onClick={() => setNics((a) => [...a, { name: `eno${a.length + 1}`, mac: '', speed: '' }])}>
              Add network adapter
            </Button>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Management controller">
            {(id) => (
              <Select id={id} value={f.mgmtType} onChange={set('mgmtType')}>
                <option value="">None</option>
                <option value="idrac">Dell iDRAC</option>
                <option value="ilo">HPE iLO</option>
                <option value="ipmi">IPMI</option>
                <option value="redfish">Redfish</option>
                <option value="other">Other</option>
              </Select>
            )}
          </Field>
          <Field label="Management address">{(id) => <Input id={id} value={f.mgmtAddress} onChange={set('mgmtAddress')} className="font-mono" placeholder="10.0.0.21" />}</Field>
          <Field label="BMC firmware">{(id) => <Input id={id} value={f.bmcFirmware} onChange={set('bmcFirmware')} />}</Field>
        </div>
        <p className="mt-2 text-[12.5px] text-ink-3">Management passwords are not stored here; they go into the encrypted credential store with the remote-management integration (Phase 6).</p>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 font-semibold">Purchase and warranty</legend>
        <Field label="Supplier">{(id) => <Input id={id} value={f.supplier} onChange={set('supplier')} />}</Field>
        <Field label="Purchase date">{(id) => <Input id={id} type="date" value={f.purchaseDate} onChange={set('purchaseDate')} />}</Field>
        <div className="grid grid-cols-[1fr_80px] gap-2">
          <Field label="Cost">{(id) => <Input id={id} type="number" min={0} step="0.01" value={f.purchaseCost} onChange={set('purchaseCost')} />}</Field>
          <Field label="Currency">{(id) => <Input id={id} maxLength={3} value={f.currency} onChange={set('currency')} placeholder="INR" className="uppercase" />}</Field>
        </div>
        <Field label="Warranty expires">{(id) => <Input id={id} type="date" value={f.warrantyExpires} onChange={set('warrantyExpires')} />}</Field>
        <Field label="End of life">{(id) => <Input id={id} type="date" value={f.eolDate} onChange={set('eolDate')} />}</Field>
      </fieldset>

      <fieldset>
        <legend className="mb-2 font-semibold">Custom fields</legend>
        <div className="flex flex-col gap-2">
          {custom.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.5fr_auto] gap-2">
              <Input aria-label="Field name" placeholder="Field" value={c.k} onChange={(e) => setCustom((a) => a.map((y, j) => (j === i ? { ...y, k: e.target.value } : y)))} />
              <Input aria-label="Value" placeholder="Value" value={c.v} onChange={(e) => setCustom((a) => a.map((y, j) => (j === i ? { ...y, v: e.target.value } : y)))} />
              <Button type="button" size="sm" variant="ghost" onClick={() => setCustom((a) => a.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" size="sm" onClick={() => setCustom((a) => [...a, { k: '', v: '' }])}>
              Add field
            </Button>
          </div>
        </div>
      </fieldset>

      <Field label="Notes" hint="Staff only, never shown to customers">
        {(id, d) => <Textarea id={id} aria-describedby={d} value={f.notes} onChange={set('notes')} />}
      </Field>
      <ErrorNote error={m.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => onClose()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          {device ? 'Save changes' : 'Add device'}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ import */

interface ImportResult {
  dryRun: boolean;
  total: number;
  created: number;
  failed: number;
  results: { line: number; assetTag: string; ok: boolean; message: string }[];
}

const TEMPLATE =
  'asset_tag,manufacturer,model,hostname,serial,state,customer_code,datacenter,room,rack,position_u,face,cpu,ram_gb,os,supplier,purchase_date,warranty_expires\n' +
  'SRV-0001,Dell,PowerEdge R640,web-01,ABC1234,active,,MUM1,Hall 1,A01,10,front,Xeon Gold 6230,128,Ubuntu 24.04,Dell India,2024-04-01,2027-03-31\n';

function ImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<ImportResult>('/dcim/devices/import', { csv, dryRun }),
    onSuccess: async (r) => {
      setResult(r);
      if (!r.dryRun) await qc.invalidateQueries({ queryKey: ['dcim'] });
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-2">
        Use the same columns as the export. Required: <code className="font-mono text-[12.5px]">asset_tag, manufacturer, model</code>. Rows with a rack, position and an in-service state (racked, active, maintenance) are placed and checked for conflicts.
      </p>
      <div className="flex flex-wrap gap-2">
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
                setResult(null);
              }
            }}
          />
        </label>
        <Button type="button" variant="ghost" onClick={() => (setCsv(TEMPLATE), setResult(null))}>
          Insert example
        </Button>
      </div>
      <Field label="CSV">
        {(id) => <Textarea id={id} value={csv} onChange={(e) => (setCsv(e.target.value), setResult(null))} className="min-h-40 font-mono text-[12px]" spellCheck={false} />}
      </Field>
      <ErrorNote error={run.error} />
      {result && (
        <div className="rounded-xl border border-rule bg-sunken p-3">
          <p className="font-medium">
            {result.dryRun ? 'Check complete: nothing has been saved yet. ' : 'Import finished. '}
            {result.created} of {result.total} row{result.total === 1 ? '' : 's'} {result.dryRun ? 'can be imported' : 'imported'}
            {result.failed ? `, ${result.failed} with problems` : ''}.
          </p>
          {result.failed > 0 && (
            <ul className="mt-2 max-h-48 overflow-y-auto text-[13px]">
              {result.results
                .filter((r) => !r.ok)
                .map((r) => (
                  <li key={r.line} className="text-crit">
                    Line {r.line} ({r.assetTag || 'no asset tag'}): {r.message}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {result && !result.dryRun ? 'Done' : 'Cancel'}
        </Button>
        <Button type="button" busy={run.isPending && run.variables === true} disabled={!csv.trim()} onClick={() => run.mutate(true)}>
          Check file
        </Button>
        <Button type="button" variant="primary" busy={run.isPending && run.variables === false} disabled={!result?.dryRun || result.created === 0} onClick={() => run.mutate(false)}>
          Import {result?.dryRun ? `${result.created} device${result.created === 1 ? '' : 's'}` : ''}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ bulk */

function BulkDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const customers = useCustomerOptions();
  const [customerId, setCustomer] = useState('__keep');
  const [state, setState] = useState('');
  const [supplier, setSupplier] = useState('');
  const [result, setResult] = useState<{ updated: number; failed: { assetTag: string; message: string }[] } | null>(null);
  const m = useMutation({
    mutationFn: () =>
      api.post<{ updated: number; failed: { assetTag: string; message: string }[] }>('/dcim/devices/bulk', {
        ids,
        set: { ...(customerId !== '__keep' && { customerId: customerId || null }), ...(supplier && { supplier }) },
        ...(state && { transitionTo: state }),
      }),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['dcim'] });
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
      <Field label="Assign to customer">
        {(id) => (
          <Select id={id} value={customerId} onChange={(e) => setCustomer(e.target.value)}>
            <option value="__keep">Keep as is</option>
            <option value="">Not assigned</option>
            {customers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Change state to" hint="Each device must allow this change; the ones that don’t are listed afterwards.">
        {(id, d) => (
          <Select id={id} aria-describedby={d} value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Keep as is</option>
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {LIFECYCLE_LABELS[s]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Supplier">{(id) => <Input id={id} value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Keep as is" />}</Field>
      <ErrorNote error={m.error} />
      {result && (
        <div className="rounded-xl border border-rule bg-sunken p-3 text-[13px]">
          <p className="font-medium">
            {result.updated} updated{result.failed.length ? `, ${result.failed.length} not changed:` : '.'}
          </p>
          <ul className="mt-1">
            {result.failed.map((f) => (
              <li key={f.assetTag} className="text-crit">
                {f.assetTag}: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {result ? 'Done' : 'Cancel'}
        </Button>
        {!result && (
          <Button type="submit" variant="primary" busy={m.isPending} disabled={customerId === '__keep' && !state && !supplier}>
            Apply to {ids.length} device{ids.length === 1 ? '' : 's'}
          </Button>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ devices tab */

function WarrantyCell({ date }: { date: string | null }) {
  const days = daysUntil(date);
  if (days === null) return <span className="text-ink-3">—</span>;
  if (days < 0) return <Chip tone="crit">Expired</Chip>;
  if (days <= 90) return <Chip tone="warn">{days} days</Chip>;
  return <span className="text-ink-2">{date}</span>;
}

function DevicesTab() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const tree = useTree();
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const page = Number(get('page') || 1);
  const query = { q: get('q'), state: get('state'), category: get('category'), datacenterId: get('datacenterId'), unracked: get('unracked'), warrantyWithinDays: get('warranty') };
  const [search, setSearch] = useState(query.q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<null | 'add' | 'import' | 'bulk'>(null);
  const list = useQuery({
    queryKey: ['dcim', 'devices', { page, ...query }],
    queryFn: () => api.get<Paginated<DeviceT>>(`/dcim/devices${qs({ page, pageSize: 50, ...query })}`),
    placeholderData: keepPreviousData,
  });
  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
    setSelected(new Set());
  };
  const items = list.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((d) => selected.has(d.id));
  const exportHref = `/api/v1/dcim/devices/export.csv${qs({ ...query })}`;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {can('dcim.write') && (
          <Button variant="primary" onClick={() => setDialog('add')}>
            Add device
          </Button>
        )}
        {can('dcim.write') && <Button onClick={() => setDialog('import')}>Import CSV</Button>}
        <a href={exportHref} className="inline-flex h-9 items-center rounded-lg border border-rule-strong bg-field px-3.5 font-medium hover:bg-panel" download>
          Export CSV
        </a>
        {selected.size > 0 && can('dcim.write') && (
          <Button onClick={() => setDialog('bulk')}>
            Edit {selected.size} selected
          </Button>
        )}
      </div>
      <Panel flush>
        <form
          role="search"
          className="flex flex-wrap gap-2 border-b border-rule p-3"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim() });
          }}
        >
          <label className="sr-only" htmlFor="dev-search">Search devices</label>
          <Input id="dev-search" placeholder="Asset tag, hostname, serial, model or BMC IP" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <Select aria-label="State" className="w-40" value={query.state} onChange={(e) => update({ state: e.target.value })}>
            <option value="">All states</option>
            {LIFECYCLE_STATES.map((s) => (
              <option key={s} value={s}>
                {LIFECYCLE_LABELS[s]}
              </option>
            ))}
          </Select>
          <Select aria-label="Category" className="w-40" value={query.category} onChange={(e) => update({ category: e.target.value })}>
            <option value="">All categories</option>
            {DEVICE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
          <Select aria-label="Datacenter" className="w-36" value={query.datacenterId} onChange={(e) => update({ datacenterId: e.target.value })}>
            <option value="">All sites</option>
            {tree.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code}
              </option>
            ))}
          </Select>
          <Select aria-label="Placement" className="w-40" value={query.unracked} onChange={(e) => update({ unracked: e.target.value })}>
            <option value="">Racked and not</option>
            <option value="false">In a rack</option>
            <option value="true">Not in a rack</option>
          </Select>
          <Select aria-label="Warranty" className="w-48" value={query.warrantyWithinDays} onChange={(e) => update({ warranty: e.target.value })}>
            <option value="">Any warranty</option>
            <option value="0">Warranty expired</option>
            <option value="90">Expires within 90 days</option>
          </Select>
          <Button type="submit">Search</Button>
        </form>
        {list.isLoading && <Loading />}
        <ErrorNote error={list.error} className="m-4" />
        {list.data && items.length === 0 && (
          <EmptyState title={params.toString() ? 'No devices match' : 'No devices yet'} action={!params.toString() && can('dcim.write') && <Button variant="primary" onClick={() => setDialog('add')}>Add device</Button>}>
            {params.toString() ? 'Try clearing a filter.' : 'Add devices one by one or import your existing inventory from CSV.'}
          </EmptyState>
        )}
        {items.length > 0 && (
          <>
            <Table label="Devices">
              <thead>
                <tr>
                  {can('dcim.write') && (
                    <th className="w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all on this page"
                        className="accent-[var(--accent)]"
                        checked={allSelected}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((d) => d.id)))}
                      />
                    </th>
                  )}
                  <th>Device</th>
                  <th>Model</th>
                  <th>Location</th>
                  <th>Customer</th>
                  <th>State</th>
                  <th>Warranty</th>
                </tr>
              </thead>
              <tbody>
                {items.map((d) => (
                  <tr key={d.id} className="cursor-pointer hover:bg-sunken/50" onClick={() => navigate(`/hardware/${d.id}`)}>
                    {can('dcim.write') && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${d.assetTag}`}
                          className="accent-[var(--accent)]"
                          checked={selected.has(d.id)}
                          onChange={() => {
                            const next = new Set(selected);
                            next.has(d.id) ? next.delete(d.id) : next.add(d.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                    )}
                    <td>
                      <Link to={`/hardware/${d.id}`} className="font-medium text-accent hover:underline" onClick={(e) => e.stopPropagation()}>
                        {d.hostname || d.assetTag}
                      </Link>
                      <span className="block font-mono text-[12px] text-ink-3">{d.assetTag}</span>
                    </td>
                    <td className="text-ink-2">
                      {d.model.manufacturer} {d.model.name}
                      <span className="block text-[12px] text-ink-3">{CATEGORY_LABELS[d.category]}</span>
                    </td>
                    <td className="text-ink-2">
                      {d.location ? (
                        <>
                          <span className="font-mono text-[12.5px]">{d.location.datacenterCode}</span> {d.location.rackName}
                          {d.location.positionU ? ` U${d.location.positionU}` : ' (0U)'}
                        </>
                      ) : (
                        <span className="text-ink-3">Not racked</span>
                      )}
                    </td>
                    <td className="text-ink-2">
                      {d.customerName ?? '—'}
                      {d.ownership === 'customer' && <span className="block text-[12px] text-est">Customer-owned</span>}
                    </td>
                    <td>
                      <Chip tone={STATE_TONE[d.lifecycleState]}>{LIFECYCLE_LABELS[d.lifecycleState]}</Chip>
                    </td>
                    <td>
                      <WarrantyCell date={d.warrantyExpires} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={list.data!.page} pageSize={list.data!.pageSize} total={list.data!.total} onPage={(pg) => update({ page: String(pg) })} />
          </>
        )}
      </Panel>
      <Modal wide open={dialog === 'add'} onOpenChange={(o) => !o && setDialog(null)} title="Add device">
        {dialog === 'add' && (
          <DeviceForm
            onClose={(saved) => {
              setDialog(null);
              if (saved) navigate(`/hardware/${saved.id}`);
            }}
          />
        )}
      </Modal>
      <Modal wide open={dialog === 'import'} onOpenChange={(o) => !o && setDialog(null)} title="Import devices from CSV">
        {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      </Modal>
      <Modal open={dialog === 'bulk'} onOpenChange={(o) => !o && (setDialog(null), setSelected(new Set()))} title={`Edit ${selected.size} devices`}>
        {dialog === 'bulk' && <BulkDialog ids={[...selected]} onClose={() => (setDialog(null), setSelected(new Set()))} />}
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ models tab */

function ModelForm({ model, onClose }: { model?: ModelT; onClose: () => void }) {
  const qc = useQueryClient();
  const manufacturers = useManufacturers();
  const s = (v: number | string | null | undefined) => (v == null ? '' : String(v));
  const [newMfr, setNewMfr] = useState('');
  const [f, setF] = useState({
    manufacturerId: model?.manufacturerId ?? '',
    name: model?.name ?? '',
    category: model?.category ?? ('server' as DeviceCategory),
    uHeight: s(model?.uHeight ?? 1),
    depthMm: s(model?.depthMm),
    fullDepth: model?.fullDepth ?? true,
    typicalPowerW: s(model?.typicalPowerW),
    idlePowerW: s(model?.idlePowerW),
    maxPowerW: s(model?.maxPowerW),
    psuCount: s(model?.psuCount),
    psuRatedW: s(model?.psuRatedW),
    weightKg: s(model?.weightKg),
    notes: model?.notes ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const n = (v: string) => (v.trim() === '' ? null : Number(v));
  const m = useMutation({
    mutationFn: async () => {
      let manufacturerId = f.manufacturerId;
      if (manufacturerId === '__new') {
        manufacturerId = (await api.post<{ id: string }>('/dcim/manufacturers', { name: newMfr })).id;
      }
      const body = {
        manufacturerId,
        name: f.name,
        category: f.category,
        uHeight: Number(f.uHeight),
        depthMm: n(f.depthMm),
        fullDepth: f.fullDepth,
        typicalPowerW: n(f.typicalPowerW),
        idlePowerW: n(f.idlePowerW),
        maxPowerW: n(f.maxPowerW),
        psuCount: n(f.psuCount),
        psuRatedW: n(f.psuRatedW),
        weightKg: n(f.weightKg),
        notes: f.notes || null,
      };
      return model ? api.patch(`/dcim/models/${model.id}`, body) : api.post('/dcim/models', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose();
    },
  });
  return (
    <form
      className="grid gap-4 sm:grid-cols-3"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Manufacturer">
        {(id) => (
          <Select id={id} required value={f.manufacturerId} onChange={set('manufacturerId')}>
            <option value="">Choose</option>
            {manufacturers.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            <option value="__new">Add a new manufacturer…</option>
          </Select>
        )}
      </Field>
      {f.manufacturerId === '__new' && <Field label="New manufacturer">{(id) => <Input id={id} required value={newMfr} onChange={(e) => setNewMfr(e.target.value)} autoFocus />}</Field>}
      <Field label="Model name">{(id) => <Input id={id} required value={f.name} onChange={set('name')} placeholder="e.g. PowerEdge R640" />}</Field>
      <Field label="Category">
        {(id) => (
          <Select id={id} value={f.category} onChange={set('category')}>
            {DEVICE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Height (U)" hint="0 for vertical PDUs and other 0U gear">
        {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} max={60} required value={f.uHeight} onChange={set('uHeight')} />}
      </Field>
      <Field label="Depth (mm)">{(id) => <Input id={id} type="number" min={0} max={1500} value={f.depthMm} onChange={set('depthMm')} />}</Field>
      <Field label="Mounting">
        {(id) => (
          <Select id={id} value={f.fullDepth ? 'full' : 'half'} onChange={(e) => setF((x) => ({ ...x, fullDepth: e.target.value === 'full' }))}>
            <option value="full">Full depth (blocks front and rear)</option>
            <option value="half">Half depth (one face only)</option>
          </Select>
        )}
      </Field>
      <div className="sm:col-span-3">
        <p className="mb-2 font-semibold">Power specification</p>
        <p className="mb-3 text-[12.5px] text-ink-3">From the datasheet. Used as estimates for power reporting, always labelled as such and never treated as measurements. PSU ratings are capacity, not consumption.</p>
      </div>
      <Field label="Typical draw (W)">{(id) => <Input id={id} type="number" min={0} value={f.typicalPowerW} onChange={set('typicalPowerW')} />}</Field>
      <Field label="Idle draw (W)">{(id) => <Input id={id} type="number" min={0} value={f.idlePowerW} onChange={set('idlePowerW')} />}</Field>
      <Field label="Maximum draw (W)">{(id) => <Input id={id} type="number" min={0} value={f.maxPowerW} onChange={set('maxPowerW')} />}</Field>
      <Field label="Power supplies">{(id) => <Input id={id} type="number" min={0} max={16} value={f.psuCount} onChange={set('psuCount')} />}</Field>
      <Field label="PSU rating (W each)">{(id) => <Input id={id} type="number" min={0} value={f.psuRatedW} onChange={set('psuRatedW')} />}</Field>
      <Field label="Weight (kg)">{(id) => <Input id={id} type="number" min={0} step="0.1" value={f.weightKg} onChange={set('weightKg')} />}</Field>
      <ErrorNote error={m.error} className="sm:col-span-3" />
      <div className="flex justify-end gap-2 sm:col-span-3">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          {model ? 'Save model' : 'Add model'}
        </Button>
      </div>
    </form>
  );
}

function ModelsTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const models = useModels();
  const [editing, setEditing] = useState<ModelT | 'new' | null>(null);
  const [deleting, setDeleting] = useState<ModelT | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/dcim/models/${id}`),
    onSuccess: async () => {
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ['dcim'] });
    },
  });
  return (
    <>
      {can('dcim.write') && (
        <div className="mb-4">
          <Button variant="primary" onClick={() => setEditing('new')}>
            Add model
          </Button>
        </div>
      )}
      <Panel flush>
        {models.isLoading && <Loading />}
        <ErrorNote error={models.error} className="m-4" />
        {models.data?.length === 0 && <EmptyState title="No models yet">A model describes a kind of equipment (size, depth, power specification). Add one before adding devices.</EmptyState>}
        {!!models.data?.length && (
          <Table label="Device models">
            <thead>
              <tr>
                <th>Model</th>
                <th>Category</th>
                <th>Size</th>
                <th>Typical power</th>
                <th>Devices</th>
                <th className="sr-only">Actions</th>
              </tr>
            </thead>
            <tbody>
              {models.data.map((m) => (
                <tr key={m.id}>
                  <td>
                    <span className="font-medium">{m.name}</span>
                    <span className="block text-[12.5px] text-ink-3">{m.manufacturerName}</span>
                  </td>
                  <td className="text-ink-2">{CATEGORY_LABELS[m.category]}</td>
                  <td className="text-ink-2">
                    {m.uHeight}U{m.fullDepth ? '' : ', half-depth'}
                    {m.depthMm ? `, ${m.depthMm} mm` : ''}
                  </td>
                  <td className="text-ink-2">{m.typicalPowerW ? `${m.typicalPowerW} W (spec)` : '—'}</td>
                  <td>
                    <Link to={`/hardware?q=${encodeURIComponent(m.name)}`} className="text-accent hover:underline">
                      {m.deviceCount}
                    </Link>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {can('dcim.write') && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(m)}>
                          Edit
                        </Button>
                        {m.deviceCount === 0 && (
                          <Button size="sm" variant="ghost" onClick={() => setDeleting(m)}>
                            Delete
                          </Button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Modal wide open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add device model' : `Edit ${editing?.name ?? ''}`}>
        {editing !== null && <ModelForm model={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && (setDeleting(null), del.reset())}
        title={`Delete ${deleting?.name}?`}
        body="Models in use can’t be deleted."
        confirmLabel="Delete model"
        busy={del.isPending}
        error={del.error}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ spare parts tab */

function SparePartForm({ part, onClose }: { part?: SparePartT; onClose: () => void }) {
  const qc = useQueryClient();
  const tree = useTree();
  const s = (v: number | string | null | undefined) => (v == null ? '' : String(v));
  const [f, setF] = useState({
    kind: part?.kind ?? 'ssd',
    manufacturer: s(part?.manufacturer),
    partNumber: part?.partNumber ?? '',
    description: part?.description ?? '',
    datacenterId: s(part?.datacenterId),
    location: s(part?.location),
    quantity: '0',
    minQuantity: s(part?.minQuantity ?? 0),
    unitCost: s(part?.unitCost),
    notes: s(part?.notes),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const m = useMutation({
    mutationFn: () => {
      const body = {
        kind: f.kind,
        manufacturer: f.manufacturer || null,
        partNumber: f.partNumber,
        description: f.description,
        datacenterId: f.datacenterId || null,
        location: f.location || null,
        quantity: Number(f.quantity || 0),
        minQuantity: Number(f.minQuantity || 0),
        unitCost: f.unitCost ? Number(f.unitCost) : null,
        notes: f.notes || null,
      };
      return part ? api.patch(`/dcim/spare-parts/${part.id}`, body) : api.post('/dcim/spare-parts', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim', 'spares'] });
      onClose();
    },
  });
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Type">
        {(id) => (
          <Select id={id} value={f.kind} onChange={set('kind')}>
            {SPARE_PART_KINDS.map((k) => (
              <option key={k} value={k}>
                {SPARE_PART_LABELS[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Manufacturer">{(id) => <Input id={id} value={f.manufacturer} onChange={set('manufacturer')} />}</Field>
      <Field label="Part number">{(id) => <Input id={id} required value={f.partNumber} onChange={set('partNumber')} className="font-mono" />}</Field>
      <Field label="Description">{(id) => <Input id={id} required value={f.description} onChange={set('description')} placeholder="e.g. 32GB DDR4 RDIMM" />}</Field>
      <Field label="Stored at">
        {(id) => (
          <Select id={id} value={f.datacenterId} onChange={set('datacenterId')}>
            <option value="">Central store</option>
            {tree.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} · {d.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Shelf or bin">{(id) => <Input id={id} value={f.location} onChange={set('location')} />}</Field>
      {!part && <Field label="Quantity in stock">{(id) => <Input id={id} type="number" min={0} value={f.quantity} onChange={set('quantity')} />}</Field>}
      <Field label="Reorder at" hint="Flagged as low stock at or below this">
        {(id, d) => <Input id={id} aria-describedby={d} type="number" min={0} value={f.minQuantity} onChange={set('minQuantity')} />}
      </Field>
      <Field label="Unit cost">{(id) => <Input id={id} type="number" min={0} step="0.01" value={f.unitCost} onChange={set('unitCost')} />}</Field>
      <ErrorNote error={m.error} className="sm:col-span-2" />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending}>
          {part ? 'Save part' : 'Add part'}
        </Button>
      </div>
    </form>
  );
}

function AdjustForm({ part, onClose }: { part: SparePartT; onClose: () => void }) {
  const qc = useQueryClient();
  const [direction, setDirection] = useState<'out' | 'in'>('out');
  const [amount, setAmount] = useState('1');
  const [reason, setReason] = useState('');
  const [deviceTag, setDeviceTag] = useState('');
  const movements = useQuery({ queryKey: ['dcim', 'spares', 'moves', part.id], queryFn: () => api.get<{ id: number; delta: number; quantityAfter: number; reason: string; actorLabel: string; occurredAt: string; deviceAssetTag: string | null }[]>(`/dcim/spare-parts/${part.id}/movements`) });
  const m = useMutation({
    mutationFn: async () => {
      let deviceId: string | null = null;
      if (deviceTag.trim()) {
        const found = await api.get<Paginated<DeviceT>>(`/dcim/devices${qs({ q: deviceTag.trim(), pageSize: 5 })}`);
        const match = found.items.find((d) => d.assetTag.toLowerCase() === deviceTag.trim().toLowerCase());
        if (!match) throw new Error(`No device with asset tag ${deviceTag}`);
        deviceId = match.id;
      }
      const delta = (direction === 'out' ? -1 : 1) * Number(amount);
      return api.post(`/dcim/spare-parts/${part.id}/adjust`, { delta, reason, deviceId });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['dcim', 'spares'] });
      onClose();
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-2">
        {part.description} <span className="font-mono text-[12.5px]">{part.partNumber}</span>: <strong>{part.quantity}</strong> in stock.
      </p>
      <form
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Change">
          {(id) => (
            <Select id={id} value={direction} onChange={(e) => setDirection(e.target.value as 'in' | 'out')}>
              <option value="out">Take out of stock</option>
              <option value="in">Add to stock</option>
            </Select>
          )}
        </Field>
        <Field label="Quantity">{(id) => <Input id={id} type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Reason">{(id) => <Input id={id} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder={direction === 'out' ? 'e.g. Replaced failed disk' : 'e.g. Delivery PO-1182'} />}</Field>
        <Field label="Used in device (asset tag)" hint="Optional">
          {(id, d) => <Input id={id} aria-describedby={d} value={deviceTag} onChange={(e) => setDeviceTag(e.target.value)} className="font-mono" />}
        </Field>
        <ErrorNote error={m.error} className="col-span-2" />
        <div className="col-span-2 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.isPending} disabled={!reason || Number(amount) < 1}>
            Save change
          </Button>
        </div>
      </form>
      <div>
        <p className="mb-1 font-semibold">Recent movements</p>
        <ul className="max-h-48 overflow-y-auto text-[13px]">
          {movements.data?.map((mv) => (
            <li key={mv.id} className="flex justify-between gap-3 border-b border-rule py-1.5 last:border-0">
              <span>
                <strong className={mv.delta < 0 ? 'text-crit' : 'text-ok'}>{mv.delta > 0 ? `+${mv.delta}` : mv.delta}</strong> {mv.reason}
                {mv.deviceAssetTag ? ` (${mv.deviceAssetTag})` : ''}
              </span>
              <span className="text-right text-ink-3">
                {mv.quantityAfter} left, {formatDateTime(mv.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function SparesTab() {
  const { can } = useAuth();
  const [lowOnly, setLowOnly] = useState(false);
  const [search, setSearch] = useState('');
  const parts = useQuery({ queryKey: ['dcim', 'spares', lowOnly, search], queryFn: () => api.get<SparePartT[]>(`/dcim/spare-parts${qs({ lowStock: lowOnly ? 'true' : '', q: search })}`), placeholderData: keepPreviousData });
  const [editing, setEditing] = useState<SparePartT | 'new' | null>(null);
  const [adjusting, setAdjusting] = useState<SparePartT | null>(null);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {can('dcim.write') && (
          <Button variant="primary" onClick={() => setEditing('new')}>
            Add part
          </Button>
        )}
        <Input aria-label="Search parts" placeholder="Part number or description" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="accent-[var(--accent)]" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Low stock only
        </label>
      </div>
      <Panel flush>
        {parts.isLoading && <Loading />}
        <ErrorNote error={parts.error} className="m-4" />
        {parts.data?.length === 0 && <EmptyState title={lowOnly || search ? 'Nothing matches' : 'No spare parts yet'}>Track RAM, disks, PSUs, transceivers and other spares, with every withdrawal logged.</EmptyState>}
        {!!parts.data?.length && (
          <Table label="Spare parts">
            <thead>
              <tr>
                <th>Part</th>
                <th>Type</th>
                <th>Stored at</th>
                <th>In stock</th>
                <th>Reorder at</th>
                <th className="sr-only">Actions</th>
              </tr>
            </thead>
            <tbody>
              {parts.data.map((pt) => (
                <tr key={pt.id}>
                  <td>
                    <span className="font-medium">{pt.description}</span>
                    <span className="block font-mono text-[12px] text-ink-3">
                      {pt.manufacturer ? `${pt.manufacturer} ` : ''}
                      {pt.partNumber}
                    </span>
                  </td>
                  <td className="text-ink-2">{SPARE_PART_LABELS[pt.kind as keyof typeof SPARE_PART_LABELS] ?? pt.kind}</td>
                  <td className="text-ink-2">
                    {pt.datacenterCode ?? 'Central'}
                    {pt.location ? `, ${pt.location}` : ''}
                  </td>
                  <td>
                    <span className={cx('font-semibold', pt.lowStock && 'text-warn')}>{pt.quantity}</span> {pt.lowStock && <Chip tone="warn">Low</Chip>}
                  </td>
                  <td className="text-ink-2">{pt.minQuantity}</td>
                  <td className="text-right whitespace-nowrap">
                    {can('dcim.write') && (
                      <>
                        <Button size="sm" onClick={() => setAdjusting(pt)}>
                          Stock in/out
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(pt)}>
                          Edit
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
      <Modal wide open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add spare part' : 'Edit spare part'}>
        {editing !== null && <SparePartForm part={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </Modal>
      <Modal wide open={!!adjusting} onOpenChange={(o) => !o && setAdjusting(null)} title="Stock in or out">
        {adjusting && <AdjustForm part={adjusting} onClose={() => setAdjusting(null)} />}
      </Modal>
    </>
  );
}

/* ------------------------------------------------------------------ page */

const TABS = [
  { key: 'devices', label: 'Devices' },
  { key: 'models', label: 'Models' },
  { key: 'spares', label: 'Spare parts' },
] as const;

export function HardwarePage() {
  const { me } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as (typeof TABS)[number]['key']) ?? 'devices';
  if (me?.user.userType === 'customer') return <CustomerEquipment />;
  return (
    <>
      <PageHeader title="Servers and hardware" description="Every physical asset, from order to retirement, with its location, specification and history." />
      <div role="tablist" aria-label="Hardware sections" className="mb-4 flex w-fit gap-1 rounded-xl border border-rule bg-sunken p-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setParams(t.key === 'devices' ? {} : { tab: t.key }, { replace: true })}
            className={cx('h-8 rounded-lg px-3.5 text-[13.5px]', tab === t.key ? 'bg-panel font-semibold text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'devices' && <DevicesTab />}
      {tab === 'models' && <ModelsTab />}
      {tab === 'spares' && <SparesTab />}
    </>
  );
}

/** Customer portal view: only their own equipment, no internal data. */
export function CustomerEquipment({ embedded }: { embedded?: boolean }) {
  const list = useQuery({ queryKey: ['dcim', 'devices', 'mine'], queryFn: () => api.get<Paginated<DeviceT>>('/dcim/devices?pageSize=200') });
  const body = (
    <Panel title={embedded ? 'Your equipment' : undefined} flush>
      {list.isLoading && <Loading />}
      <ErrorNote error={list.error} className="m-4" />
      {list.data?.items.length === 0 && <EmptyState title="No equipment yet">Servers and colocated equipment assigned to your account appear here.</EmptyState>}
      {!!list.data?.items.length && (
        <Table label="Your equipment">
          <thead>
            <tr>
              <th>Device</th>
              <th>Model</th>
              <th>Location</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/hardware/${d.id}`} className="font-medium text-accent hover:underline">
                    {d.hostname || d.assetTag}
                  </Link>
                  <span className="block font-mono text-[12px] text-ink-3">{d.assetTag}</span>
                </td>
                <td className="text-ink-2">
                  {d.model.manufacturer} {d.model.name}
                </td>
                <td className="text-ink-2">{d.location ? `${d.location.datacenterCode}, rack ${d.location.rackName}${d.location.positionU ? ` U${d.location.positionU}` : ''}` : 'Not installed'}</td>
                <td>
                  <Chip tone={STATE_TONE[d.lifecycleState as LifecycleState]}>{LIFECYCLE_LABELS[d.lifecycleState]}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
  if (embedded) return body;
  return (
    <>
      <PageHeader title="Your equipment" description="Servers and colocated equipment on your account." />
      {body}
    </>
  );
}
