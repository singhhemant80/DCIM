import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCESSORY_KINDS, ACCESSORY_LABELS, type AccessoryKind, type HardwareInventory, type HwHealth } from '@crapplet/shared';
import { api } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { Tabs } from '../pages/Network';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Modal, Panel, Select, Table, Textarea } from './ui';

interface HardwareT {
  hasRedfish: boolean;
  status: 'idle' | 'running' | 'failed' | 'pending' | 'not_configured';
  requestedAt: string | null;
  fetchedAt: string | null;
  nextAt: string | null;
  lastError: string | null;
  health: HwHealth;
  inventory: HardwareInventory | null;
  differences: { field: string; key: string; current: unknown; fromBmc: unknown }[];
}

function Health({ h }: { h: HwHealth | string | null }) {
  if (!h) return <span className="text-ink-3">—</span>;
  return <Chip tone={h === 'OK' ? 'ok' : h === 'Warning' ? 'warn' : 'crit'}>{h}</Chip>;
}
const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const size = (gb: number | null) => (gb === null ? '—' : gb >= 1000 ? `${(gb / 1000).toFixed(gb >= 10_000 ? 0 : 2)} TB` : `${Math.round(gb)} GB`);

const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'cpu', label: 'CPU & memory' },
  { key: 'storage', label: 'Storage' },
  { key: 'power', label: 'Power supplies' },
  { key: 'thermal', label: 'Fans & temperatures' },
  { key: 'nics', label: 'Network' },
  { key: 'logs', label: 'Event log' },
] as const;

const FIELD_LABELS: Record<string, string> = { serial: 'Serial / service tag', cpu: 'CPU', ram: 'Memory', disks: 'Disks', nics: 'Network adapters', firmware: 'BIOS and BMC firmware' };

function ApplyDialog({ deviceId, diffs, onClose }: { deviceId: string; diffs: HardwareT['differences']; onClose: () => void }) {
  const qc = useQueryClient();
  const fields = [...new Set(diffs.map((d) => d.field))];
  const [chosen, setChosen] = useState<Set<string>>(new Set(fields));
  const show = (v: unknown) => (Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : dash(v));
  const m = useMutation({
    mutationFn: () => api.post<{ changed: string[] }>(`/dcim/devices/${deviceId}/hardware/apply`, { fields: [...chosen] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose();
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-2">Choose what to copy from the last BMC reading into this device's record. Nothing is changed on the server.</p>
      {fields.map((f) => (
        <label key={f} className="flex items-start gap-2 rounded-lg border border-rule p-2.5 text-[13px]">
          <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={chosen.has(f)} onChange={() => setChosen((s) => (s.has(f) ? new Set([...s].filter((x) => x !== f)) : new Set([...s, f])))} />
          <span className="flex-1">
            <span className="font-medium">{FIELD_LABELS[f] ?? f}</span>
            {diffs
              .filter((d) => d.field === f)
              .map((d) => (
                <span key={d.key} className="block text-ink-2">
                  {d.key}: <span className="text-ink-3 line-through">{show(d.current)}</span> → <span className="font-mono">{show(d.fromBmc)}</span>
                </span>
              ))}
          </span>
        </label>
      ))}
      <ErrorNote error={m.error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" busy={m.isPending} disabled={!chosen.size} onClick={() => m.mutate()}>
          Copy to record
        </Button>
      </div>
    </div>
  );
}

/** Hardware read from the server's BMC over Redfish: components, health and event log. */
export function BmcHardwarePanel({ deviceId, canWrite, staff }: { deviceId: string; canWrite: boolean; staff: boolean }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('summary');
  const [applying, setApplying] = useState(false);
  const q = useQuery({
    queryKey: ['dcim', 'device-hardware', deviceId],
    queryFn: () => api.get<HardwareT>(`/dcim/devices/${deviceId}/hardware`),
    refetchInterval: (query) => (query.state.data?.requestedAt || query.state.data?.status === 'running' || query.state.data?.status === 'pending' ? 4000 : 60_000),
  });
  const refresh = useMutation({ mutationFn: () => api.post(`/dcim/devices/${deviceId}/hardware/refresh`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['dcim', 'device-hardware', deviceId] }) });
  const h = q.data;
  if (!h) return q.error ? <ErrorNote error={q.error} /> : null;
  if (h.status === 'not_configured')
    return staff ? (
      <Panel title="Hardware from the BMC">
        <p className="text-[13px] text-ink-2">Add a Redfish credential (iDRAC, iLO, XClarity) under Ports & network → Read-only access, and NexoraDC reads the CPUs, memory, drives, power supplies, fans, temperatures, network ports, firmware and event log automatically, then once a day.</p>
      </Panel>
    ) : null;
  const inv = h.inventory;
  const busy = !!h.requestedAt || h.status === 'running' || h.status === 'pending';
  const logs = inv?.logs ?? [];
  const tabs = TABS.map((t) => (t.key === 'logs' && logs.length ? { ...t, label: `Event log (${logs.length})` } : t));
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          Hardware from the BMC <Health h={h.health} />
        </span>
      }
      actions={
        <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
          {busy ? 'Reading the BMC…' : h.fetchedAt ? <span title={formatDateTime(h.fetchedAt)}>Read {relativeTime(h.fetchedAt)}</span> : null}
          {canWrite && staff && (
            <Button size="sm" busy={refresh.isPending} disabled={busy} onClick={() => refresh.mutate()}>
              Read now
            </Button>
          )}
          {canWrite && staff && !!h.differences.length && (
            <Button size="sm" variant="primary" onClick={() => setApplying(true)}>
              Copy to record ({h.differences.length})
            </Button>
          )}
        </span>
      }
    >
      <ErrorNote error={refresh.error} className="mb-3" />
      {h.lastError && <p className={`mb-3 rounded-md px-3 py-2 text-[13px] ${h.status === 'failed' ? 'bg-crit-soft text-crit' : 'bg-warn-soft text-warn'}`}>{h.status === 'failed' ? `Last read failed: ${h.lastError}${inv ? ' (showing the previous reading)' : ''}` : h.lastError}</p>}
      {!inv ? (
        <p className="text-[13px] text-ink-3">{busy ? 'The worker is reading the BMC; this takes up to a minute.' : 'Nothing read yet.'}</p>
      ) : (
        <>
          <Tabs tabs={tabs} value={tab} onChange={setTab} label="Hardware" />
          {tab === 'summary' && <Summary inv={inv} />}
          {tab === 'cpu' && <CpuMemory inv={inv} />}
          {tab === 'storage' && <Storage inv={inv} />}
          {tab === 'power' && (
            <Table label="Power supplies">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Serial</th>
                  <th className="text-right">Rated</th>
                  <th className="text-right">Input now</th>
                  <th>Firmware</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {inv.psus.map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td>{dash(p.model)}</td>
                    <td className="font-mono text-[12.5px]">{dash(p.serial)}</td>
                    <td className="text-right">{p.capacityW ? `${p.capacityW} W` : '—'}</td>
                    <td className="text-right">{p.inputW !== null ? `${p.inputW} W` : '—'}</td>
                    <td className="font-mono text-[12.5px]">{dash(p.firmware)}</td>
                    <td>
                      <Health h={p.health} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {tab === 'thermal' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Table label="Fans">
                <thead>
                  <tr>
                    <th>Fan</th>
                    <th className="text-right">Reading</th>
                    <th>Health</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.fans.map((f) => (
                    <tr key={f.name}>
                      <td>{f.name}</td>
                      <td className="text-right">{f.reading !== null ? `${f.reading} ${f.units ?? ''}` : '—'}</td>
                      <td>
                        <Health h={f.health} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Table label="Temperatures">
                <thead>
                  <tr>
                    <th>Sensor</th>
                    <th className="text-right">Now</th>
                    <th className="text-right">Critical at</th>
                    <th>Health</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.temperatures.map((t) => (
                    <tr key={t.name}>
                      <td>{t.name}</td>
                      <td className="text-right">{t.celsius !== null ? `${t.celsius} °C` : '—'}</td>
                      <td className="text-right text-ink-3">{t.upperCritical !== null ? `${t.upperCritical} °C` : '—'}</td>
                      <td>
                        <Health h={t.health} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          {tab === 'nics' && (
            <Table label="Network ports">
              <thead>
                <tr>
                  <th>Port</th>
                  <th>MAC</th>
                  <th>Speed</th>
                  <th>Link</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {inv.nics.map((n) => (
                  <tr key={n.name}>
                    <td className="font-mono text-[12.5px]">{n.name}</td>
                    <td className="font-mono text-[12.5px]">{dash(n.mac)}</td>
                    <td>{n.speedMbps ? (n.speedMbps >= 1000 ? `${n.speedMbps / 1000} Gbit/s` : `${n.speedMbps} Mbit/s`) : '—'}</td>
                    <td>{n.linkStatus === 'LinkUp' ? <Chip tone="ok">Up</Chip> : n.linkStatus ? <Chip>{n.linkStatus === 'LinkDown' ? 'Down' : n.linkStatus}</Chip> : '—'}</td>
                    <td>
                      <Health h={n.health} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {tab === 'logs' && (logs.length ? <LogTable logs={logs} /> : <EmptyState title="The BMC event log is empty" />)}
          {staff && inv.warnings.length > 0 && (
            <details className="mt-3 text-[12.5px] text-ink-3">
              <summary className="cursor-pointer">{inv.warnings.length} part(s) of the BMC could not be read</summary>
              <ul className="mt-1 list-disc pl-5">
                {inv.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-3 text-[12px] text-ink-3">Read-only: Redfish GET requests (and on older Dell iDRACs a WS-Man read of the memory list); nothing on the server is changed. Read again automatically once a day.</p>
        </>
      )}
      <Modal open={applying} onOpenChange={(o) => !o && setApplying(false)} title="Copy from the BMC to the record" wide>
        {applying && <ApplyDialog deviceId={deviceId} diffs={h.differences} onClose={() => setApplying(false)} />}
      </Modal>
    </Panel>
  );
}

function Summary({ inv }: { inv: HardwareInventory }) {
  const s = inv.system;
  const ram = inv.memory.reduce((a, m) => a + (m.sizeGb ?? 0), 0) || s.memoryGb;
  const ssd = inv.drives.filter((d) => /ssd/i.test(d.mediaType ?? '') || d.protocol === 'NVMe').length;
  const hdd = inv.drives.filter((d) => /hdd/i.test(d.mediaType ?? '')).length;
  const issues = [...inv.processors, ...inv.memory, ...inv.drives, ...inv.psus, ...inv.fans, ...inv.temperatures, ...inv.controllers, ...inv.volumes].filter((x) => x.health === 'Warning' || x.health === 'Critical').map((x) => ('mediaType' in x ? x.name : 'slot' in x && x.slot ? x.slot : 'socket' in x ? x.socket : 'name' in x ? x.name : 'component').replace(/ Status$/, ''));
  const failing = inv.drives.filter((d) => d.failurePredicted || (d.lifeLeftPercent !== null && d.lifeLeftPercent < 20));
  const items: [string, string][] = [
    ['System', [s.manufacturer, s.model].filter(Boolean).join(' ') || '—'],
    ['Service tag / serial', [s.sku, s.serial].filter(Boolean).join(' · ') || '—'],
    ['Power', dash(s.powerState)],
    ['CPU', s.cpuCount ? `${inv.processors.length || s.cpuCount} × ${inv.processors[0]?.model ?? s.cpuModel ?? 'CPU'}${s.logicalCpus ? ` (${s.logicalCpus} threads)` : ''}` : '—'],
    ['Memory', ram ? (inv.memory.length ? `${ram} GB in ${inv.memory.length} module${inv.memory.length === 1 ? '' : 's'}` : `${ram} GB (modules not listed by the BMC)`) : '—'],
    ['Drives', inv.drives.length ? `${inv.drives.length} (${[ssd && `${ssd} SSD`, hdd && `${hdd} HDD`].filter(Boolean).join(', ') || 'type not reported'}), ${size(inv.drives.reduce((a, d) => a + (d.capacityGb ?? 0), 0))}` : '—'],
    ['Power supplies', inv.psus.length ? inv.psus.map((p) => `${p.name.replace(/ Status$/, '')}${p.capacityW ? ` ${p.capacityW} W` : ''}`).join(', ') : '—'],
    ['BIOS / BMC firmware', [s.biosVersion && `BIOS ${s.biosVersion}`, inv.bmc?.firmware && `BMC ${inv.bmc.firmware}`].filter(Boolean).join(' · ') || '—'],
  ];
  return (
    <>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[12.5px] text-ink-3">{k}</dt>
            <dd className="text-[13.5px]">{v}</dd>
          </div>
        ))}
      </dl>
      {(issues.length > 0 || failing.length > 0) && (
        <div className="mt-4 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
          {issues.length > 0 && <p>Needs attention: {issues.join(', ')}.</p>}
          {failing.length > 0 && <p>Drive wear or predicted failure: {failing.map((d) => `${d.name}${d.lifeLeftPercent !== null ? ` (${d.lifeLeftPercent}% life left)` : ''}`).join(', ')}.</p>}
        </div>
      )}
    </>
  );
}

function CpuMemory({ inv }: { inv: HardwareInventory }) {
  return (
    <div className="flex flex-col gap-4">
      <Table label="Processors">
        <thead>
          <tr>
            <th>Socket</th>
            <th>Model</th>
            <th className="text-right">Cores / threads</th>
            <th className="text-right">Max speed</th>
            <th>Health</th>
          </tr>
        </thead>
        <tbody>
          {inv.processors.map((c) => (
            <tr key={c.socket}>
              <td>{c.socket}</td>
              <td>{dash(c.model)}</td>
              <td className="text-right">
                {dash(c.cores)} / {dash(c.threads)}
              </td>
              <td className="text-right">{c.maxSpeedMhz ? `${(c.maxSpeedMhz / 1000).toFixed(1)} GHz` : '—'}</td>
              <td>
                <Health h={c.health} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Table label="Memory modules">
        <thead>
          <tr>
            <th>Slot</th>
            <th className="text-right">Size</th>
            <th>Type</th>
            <th className="text-right">Speed</th>
            <th>Part number</th>
            <th>Serial</th>
            <th>Health</th>
          </tr>
        </thead>
        <tbody>
          {!inv.memory.length && (
            <tr>
              <td colSpan={7} className="text-ink-3">
                The BMC did not list the memory modules{inv.system.memoryGb ? ` (it reports ${inv.system.memoryGb} GB in total)` : ''}. See the details below.
              </td>
            </tr>
          )}
          {inv.memory.map((m) => (
            <tr key={m.slot}>
              <td className="font-mono text-[12.5px]">{m.slot}</td>
              <td className="text-right">{m.sizeGb ? `${m.sizeGb} GB` : '—'}</td>
              <td>{dash(m.type)}</td>
              <td className="text-right">{m.speedMhz ? `${m.speedMhz} MHz` : '—'}</td>
              <td className="font-mono text-[12.5px]">
                {dash(m.partNumber)}
                {m.manufacturer && <span className="block font-sans text-[12px] text-ink-3">{m.manufacturer}</span>}
              </td>
              <td className="font-mono text-[12.5px]">{dash(m.serial)}</td>
              <td>
                <Health h={m.health} />
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {inv.memorySource && <p className="text-[12px] text-ink-3">Memory modules read over {inv.memorySource}: this BMC firmware does not list them in Redfish.</p>}
    </div>
  );
}

function Storage({ inv }: { inv: HardwareInventory }) {
  return (
    <div className="flex flex-col gap-4">
      <Table label="Drives">
        <thead>
          <tr>
            <th>Slot</th>
            <th>Drive</th>
            <th>Type</th>
            <th className="text-right">Capacity</th>
            <th className="text-right">Life left</th>
            <th>Serial</th>
            <th>Health</th>
          </tr>
        </thead>
        <tbody>
          {inv.drives.map((d) => (
            <tr key={`${d.name}-${d.serial}`}>
              <td>{dash(d.slot)}</td>
              <td>
                {d.name}
                <span className="block text-[12px] text-ink-3">{dash(d.model)}</span>
              </td>
              <td>{[d.mediaType, d.protocol].filter(Boolean).join(' · ') || '—'}</td>
              <td className="text-right">{size(d.capacityGb)}</td>
              <td className={`text-right ${d.lifeLeftPercent !== null && d.lifeLeftPercent < 20 ? 'text-crit' : ''}`}>{d.lifeLeftPercent !== null ? `${d.lifeLeftPercent}%` : '—'}</td>
              <td className="font-mono text-[12.5px]">{dash(d.serial)}</td>
              <td>
                <span className="flex flex-wrap gap-1">
                  <Health h={d.health} />
                  {d.failurePredicted && <Chip tone="crit">Failure predicted</Chip>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {(inv.volumes.length > 0 || inv.controllers.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Table label="Controllers">
            <thead>
              <tr>
                <th>Controller</th>
                <th>Firmware</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {inv.controllers.map((c) => (
                <tr key={c.name}>
                  <td>
                    {c.name}
                    {c.model && c.model !== c.name && <span className="block text-[12px] text-ink-3">{c.model}</span>}
                  </td>
                  <td className="font-mono text-[12.5px]">{dash(c.firmware)}</td>
                  <td>
                    <Health h={c.health} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Table label="Volumes">
            <thead>
              <tr>
                <th>Volume</th>
                <th>RAID</th>
                <th className="text-right">Size</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {inv.volumes.map((v) => (
                <tr key={v.name}>
                  <td>{v.name}</td>
                  <td>{dash(v.raid)}</td>
                  <td className="text-right">{size(v.capacityGb)}</td>
                  <td>
                    <Health h={v.health} />
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}

function LogTable({ logs }: { logs: HardwareInventory['logs'] }) {
  const [sev, setSev] = useState('');
  const shown = logs.filter((l) => !sev || (sev === 'problems' ? l.severity === 'Warning' || l.severity === 'Critical' : l.severity === sev));
  return (
    <>
      <Select aria-label="Severity" className="mb-3 w-48" value={sev} onChange={(e) => setSev(e.target.value)}>
        <option value="">All entries</option>
        <option value="problems">Warnings and critical</option>
        <option value="Critical">Critical</option>
        <option value="Warning">Warning</option>
      </Select>
      <Table label="BMC event log">
        <thead>
          <tr>
            <th>When</th>
            <th>Severity</th>
            <th>Message</th>
            <th>Log</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l, i) => (
            <tr key={`${l.log}-${l.id}-${i}`}>
              <td className="whitespace-nowrap text-[12.5px]">{l.created ? formatDateTime(l.created) : '—'}</td>
              <td>{l.severity ? <Health h={l.severity === 'OK' ? 'OK' : l.severity} /> : '—'}</td>
              <td className="text-[13px]">
                {l.message}
                {l.messageId && <span className="ml-1 font-mono text-[11.5px] text-ink-3">{l.messageId}</span>}
              </td>
              <td className="text-[12.5px] text-ink-3">{l.log}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

/* ------------------------------------------------------------------ accessories */

interface AccessoryT {
  id: string;
  kind: AccessoryKind;
  quantity: number;
  description: string | null;
  lengthM: number | null;
  partNumber: string | null;
  serial: string | null;
  notes: string | null;
  sparePartId: string | null;
  sparePartNumber: string | null;
}
interface SpareT {
  id: string;
  kind: string;
  partNumber: string;
  description: string;
  quantity: number;
}

function AccessoryForm({ deviceId, current, onClose }: { deviceId: string; current?: AccessoryT; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    kind: current?.kind ?? ('dac_cable' as AccessoryKind),
    quantity: String(current?.quantity ?? 1),
    description: current?.description ?? '',
    lengthM: current?.lengthM != null ? String(current.lengthM) : '',
    partNumber: current?.partNumber ?? '',
    serial: current?.serial ?? '',
    notes: current?.notes ?? '',
    sparePartId: '',
  });
  const spares = useQuery({ queryKey: ['dcim', 'spares', 'all'], queryFn: () => api.get<SpareT[]>('/dcim/spare-parts'), enabled: !current });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const t = (v: string) => (v.trim() ? v.trim() : null);
  const save = useMutation({
    mutationFn: () => {
      const body = { kind: f.kind, quantity: Number(f.quantity), description: t(f.description), lengthM: f.lengthM ? Number(f.lengthM) : null, partNumber: t(f.partNumber), serial: t(f.serial), notes: t(f.notes), ...(current ? {} : { sparePartId: f.sparePartId || null }) };
      return current ? api.put(`/dcim/devices/${deviceId}/accessories/${current.id}`, body) : api.post(`/dcim/devices/${deviceId}/accessories`, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dcim'] });
      onClose();
    },
  });
  const cableLike = /cable/.test(f.kind);
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Type">
        {(id) => (
          <Select id={id} value={f.kind} onChange={set('kind')}>
            {ACCESSORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {ACCESSORY_LABELS[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Quantity">{(id) => <Input id={id} type="number" min={1} max={10000} required value={f.quantity} onChange={set('quantity')} />}</Field>
      <Field label="Description" hint={cableLike ? 'e.g. SFP28 25G passive, OM4 LC-LC, Cat6' : 'e.g. ReadyRails II sliding'}>
        {(id, d) => <Input id={id} aria-describedby={d} value={f.description} onChange={set('description')} />}
      </Field>
      <Field label="Length (m)">{(id) => <Input id={id} type="number" min={0} step="0.1" value={f.lengthM} onChange={set('lengthM')} disabled={!cableLike} />}</Field>
      <Field label="Part number">{(id) => <Input id={id} value={f.partNumber} onChange={set('partNumber')} className="font-mono" />}</Field>
      <Field label="Serial">{(id) => <Input id={id} value={f.serial} onChange={set('serial')} className="font-mono" />}</Field>
      {!current && (
        <Field label="Take from spare stock" hint="Optional: reduces that stock line by the quantity, with a movement in its history">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={f.sparePartId} onChange={set('sparePartId')}>
              <option value="">No, record only</option>
              {(spares.data ?? []).map((s) => (
                <option key={s.id} value={s.id} disabled={s.quantity < 1}>
                  {s.partNumber} — {s.description} ({s.quantity} in stock)
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <div className="sm:col-span-2">
        <Field label="Notes">{(id) => <Textarea id={id} rows={2} value={f.notes} onChange={set('notes')} />}</Field>
      </div>
      <ErrorNote error={save.error} className="sm:col-span-2" />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Cables, transceivers, rail kits, trays… fitted with this device. */
export function AccessoriesPanel({ deviceId, canWrite }: { deviceId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dcim', 'device-accessories', deviceId], queryFn: () => api.get<AccessoryT[]>(`/dcim/devices/${deviceId}/accessories`) });
  const [editing, setEditing] = useState<AccessoryT | 'new' | null>(null);
  const [removing, setRemoving] = useState<AccessoryT | null>(null);
  const del = useMutation({
    mutationFn: ({ a, back }: { a: AccessoryT; back: boolean }) => api.delete(`/dcim/devices/${deviceId}/accessories/${a.id}${back ? '?returnToStock=true' : ''}`),
    onSuccess: () => {
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: ['dcim'] });
    },
  });
  const items = q.data ?? [];
  // Read-only viewers (customers) only see the panel when something is recorded.
  if (!canWrite && q.data && !items.length) return null;
  const totals = ACCESSORY_KINDS.map((k) => [k, items.filter((a) => a.kind === k).reduce((s, a) => s + a.quantity, 0)] as const).filter(([, n]) => n > 0);
  return (
    <Panel
      title="Equipment & accessories"
      flush
      actions={
        canWrite && (
          <Button size="sm" onClick={() => setEditing('new')}>
            Add
          </Button>
        )
      }
    >
      <ErrorNote error={q.error} className="m-4" />
      {q.data && !items.length && <EmptyState title="No accessories recorded">DAC, fiber and LAN cables, power cables, transceivers, rail kits, trays and cable arms that belong with this device.</EmptyState>}
      {items.length > 0 && (
        <>
          <p className="flex flex-wrap gap-2 border-b border-rule px-4 py-2.5 text-[13px]">
            {totals.map(([k, n]) => (
              <span key={k} className="rounded-md bg-sunken px-2 py-0.5">
                {n} × {ACCESSORY_LABELS[k]}
              </span>
            ))}
          </p>
          <Table label="Accessories">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">Qty</th>
                <th>Details</th>
                <th>Part / serial</th>
                {canWrite && <th />}
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>{ACCESSORY_LABELS[a.kind] ?? a.kind}</td>
                  <td className="text-right">{a.quantity}</td>
                  <td className="text-[13px]">
                    {[a.description, a.lengthM != null ? `${a.lengthM} m` : null].filter(Boolean).join(', ') || '—'}
                    {a.notes && <span className="block text-[12px] text-ink-3">{a.notes}</span>}
                    {a.sparePartNumber && <span className="block text-[12px] text-ink-3">From stock {a.sparePartNumber}</span>}
                  </td>
                  <td className="font-mono text-[12.5px]">{[a.partNumber, a.serial].filter(Boolean).join(' · ') || '—'}</td>
                  {canWrite && (
                    <td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(a)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(a)}>
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      <Modal wide open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Add accessory' : 'Edit accessory'}>
        {editing && <AccessoryForm deviceId={deviceId} current={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </Modal>
      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title="Remove accessory"
          body={
            removing.sparePartId
              ? `Remove ${removing.quantity} × ${ACCESSORY_LABELS[removing.kind]}? It came from spare stock; choose "Return to stock" to put the ${removing.quantity} back.`
              : `Remove ${removing.quantity} × ${ACCESSORY_LABELS[removing.kind]} from this device?`
          }
          confirmLabel={removing.sparePartId ? 'Return to stock' : 'Remove'}
          busy={del.isPending}
          onConfirm={() => del.mutate({ a: removing, back: !!removing.sparePartId })}
        />
      )}
    </Panel>
  );
}
