import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ACCESSORY_LABELS, CATEGORY_LABELS, formatBitRate, formatKwh, formatWattsShort, IP_STATUS_LABELS, LIFECYCLE_LABELS, type AccessoryKind, type HardwareInventory, type HwHealth, type IpStatus } from '@crapplet/shared';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { DeviceT } from '../lib/dcim';
import type { DevicePowerT, EnergyT } from '../lib/power';
import type { PortRateT } from '../lib/monitoring';
import { Button, ErrorNote, Loading } from '../components/ui';
import { photoUrl } from '../components/DevicePhoto';

/**
 * Equipment datasheet: everything about one device on A4 paper, with a QR
 * code that opens the device in NexoraDC. Customers get the same sheet for
 * their own equipment (the API decides what they may see).
 */

interface LabelT {
  url: string;
  qrSvg: string;
}
interface HardwareT {
  fetchedAt: string | null;
  health: HwHealth;
  inventory: HardwareInventory | null;
}
interface AccessoryT {
  id: string;
  kind: AccessoryKind;
  quantity: number;
  description: string | null;
  lengthM: number | null;
  partNumber: string | null;
  serial: string | null;
}
interface AddrT {
  id: string;
  address: string;
  prefix: string | null;
  status: IpStatus;
  dnsName: string | null;
  interfaceName: string | null;
}

// Printed on A4 portrait: the app around the sheet is hidden, margins fixed, page numbers in the footer.
const PRINT_CSS = `
@page { size: A4 portrait; margin: 12mm 12mm 14mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt system-ui, sans-serif; color: #555; } }
@media print {
  html, body { background: #fff !important; }
  body::before, body::after, #root::before, #root::after { display: none !important; }
  body * { visibility: hidden; }
  body *:not(#sheets):not(#sheets *) { background: transparent !important; box-shadow: none !important; backdrop-filter: none !important; }
  #sheets, #sheets * { visibility: visible; }
  #sheets { position: absolute; left: 0; top: 0; width: 100%; }
  .sheet { zoom: 1 !important; width: 100% !important; box-shadow: none !important; margin: 0 !important; padding: 0 !important; border: 0 !important; }
  .sheet + .sheet { break-before: page; }
  .no-print { display: none !important; }
  .sheet-section { break-inside: avoid; }
  .sheet table { break-inside: auto; }
  .sheet tr { break-inside: avoid; }
}
.sheet { zoom: var(--sheet-zoom, 1); color: #111; font-family: var(--font-sans), system-ui, sans-serif; font-size: 8.5pt; line-height: 1.3; }
.sheet h2 { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1.2pt solid #111; padding-bottom: .8mm; margin: 2.6mm 0 1mm; }
.sheet table { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
.sheet th { text-align: left; font-weight: 600; background: #f1f1f4; border: .5pt solid #bbb; padding: .45mm 1.5mm; }
.sheet td { border: .5pt solid #ccc; padding: .45mm 1.5mm; vertical-align: top; }
.sheet .mono { font-family: var(--font-mono), ui-monospace, monospace; }
.sheet dl { display: grid; grid-template-columns: 34mm 1fr 34mm 1fr; border: .5pt solid #ccc; }
.sheet dt { background: #f6f6f8; font-weight: 600; padding: .6mm 1.5mm; border-bottom: .5pt solid #ddd; }
.sheet dt.blank { background: none; }
.sheet dd { padding: .6mm 1.5mm; border-bottom: .5pt solid #ddd; margin: 0; min-width: 0; overflow-wrap: anywhere; }
`;

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
const gbText = (gb: number | null | undefined) => (gb == null ? '—' : gb >= 1000 ? `${(gb / 1000).toFixed(2)} TB` : `${Math.round(gb)} GB`);
const healthText = (h: HwHealth | null | undefined) => h ?? '—';

/** Two label/value pairs per row. */
function Facts({ items }: { items: [string, ReactNode][] }) {
  const shown = items.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false);
  if (shown.length % 2) shown.push(['', '']);
  return (
    <dl>
      {shown.map(([k, v], i) => (
        <span key={i} className="contents">
          <dt className={k ? undefined : 'blank'}>{k}</dt>
          <dd>{v === '' ? '' : v}</dd>
        </span>
      ))}
    </dl>
  );
}

/** One device's datasheet (one A4 page, or more for very large servers). */
interface PowerDetailT {
  spec: { typicalW: number | null; idleW: number | null; maxW: number | null; psuCount: number | null; psuRatedW: number | null } | null;
  outlets: { id: string; outlet_number: number; name: string | null; label: string | null; pdu_name: string | null; last_watts: number | null }[];
}
interface NoteEventT {
  id: number;
  kind: string;
  summary: string;
  actorLabel: string | null;
  occurredAt?: string;
  createdAt?: string;
}

function DeviceSheet({ id, withNotes }: { id: string; withNotes: boolean }) {
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  const dev = useQuery({ queryKey: ['dcim', 'device', id], queryFn: () => api.get<DeviceT>(`/dcim/devices/${id}`) });
  const label = useQuery({ queryKey: ['dcim', 'label', id], queryFn: () => api.get<LabelT>(`/dcim/devices/${id}/label`) });
  const isServer = ['server', 'gpu_server', 'storage'].includes(dev.data?.category ?? '');
  const hw = useQuery({ queryKey: ['dcim', 'device-hardware', id], queryFn: () => api.get<HardwareT>(`/dcim/devices/${id}/hardware`), enabled: isServer });
  const acc = useQuery({ queryKey: ['dcim', 'device-accessories', id], queryFn: () => api.get<AccessoryT[]>(`/dcim/devices/${id}/accessories`) });
  const addrs = useQuery({ queryKey: ['ipam', 'addresses', 'device', id], queryFn: () => api.get<{ items: AddrT[] }>(`/ipam/addresses?deviceId=${id}&pageSize=200`), enabled: can('ipam.read') });
  const ports = useQuery({
    queryKey: ['monitoring', 'ports', 'serving', id],
    queryFn: () => api.get<{ items: (PortRateT & { peer: string | null })[] }>(`/monitoring/ports?servingDeviceId=${id}&pageSize=50&sort=name`),
    enabled: can('monitoring.read'),
  });
  const power = useQuery({
    queryKey: ['power', 'sheet', id],
    queryFn: () => api.get<{ items: (DevicePowerT & { energy: EnergyT | null })[] }>(`/power/devices${qs({ deviceId: id, period: '30d', pageSize: 1 })}`),
    enabled: can('power.read'),
    retry: false,
  });

  const powerDetail = useQuery({ queryKey: ['power', 'device', id], queryFn: () => api.get<PowerDetailT>(`/power/devices/${id}`), enabled: can('power.read'), retry: false });
  const notes = useQuery({
    queryKey: ['dcim', 'device-events', id],
    queryFn: () => api.get<NoteEventT[]>(`/dcim/devices/${id}/events`),
    enabled: staff && withNotes,
  });

  if (dev.isLoading || label.isLoading) return <div className="no-print"><Loading /></div>;
  if (dev.error) return <div className="no-print"><ErrorNote error={dev.error} /></div>;
  const d = dev.data!;
  const inv = hw.data?.inventory ?? null;
  const p = power.data?.items[0];
  const energy = p?.energy ? p.energy.measuredKwh + p.energy.estimatedKwh : null;
  const title = d.hostname || d.assetTag;
  const loc = d.location;
  const reach = d.reachability;
  const spec = powerDetail.data?.spec ?? null;
  const outlets = staff ? (powerDetail.data?.outlets ?? []) : [];
  const psus = inv?.psus.length ? inv.psus.map((x) => `${x.name.replace(/ Status$/, '')}${x.capacityW ? ` ${x.capacityW} W` : ''}`).join(', ') : null;
  const noteEvents = (notes.data ?? []).filter((e) => e.kind === 'maintenance' || e.kind === 'note').slice(0, 5);
  const events = (inv?.logs ?? []).filter((e) => e.severity && e.severity !== 'OK').slice(0, 6);

  return (
    <>
      <div className="sheet mx-auto mb-6 w-[210mm] rounded-md bg-white p-[12mm] shadow-xl">
        {/* Header */}
        <div className="flex items-start gap-[5mm] border-b-[2pt] border-black pb-[3mm]">
          <div className="min-w-0 flex-1">
            <div className="flex items-end justify-between gap-[4mm]" style={{ marginBottom: '2.5mm' }}>
              <img src="/brand-logo.png" alt={me?.organization.name ?? 'Logo'} style={{ height: '12mm', width: 'auto', flexShrink: 0 }} />
              <p style={{ fontSize: '8pt', letterSpacing: '.06em', textTransform: 'uppercase', color: '#444', textAlign: 'right', minWidth: '30mm' }}>
                <span style={{ whiteSpace: 'nowrap' }}>Equipment datasheet</span>
                <span style={{ display: 'block', textTransform: 'none', letterSpacing: 0 }}>{me?.organization.name}</span>
              </p>
            </div>
            <p style={{ fontSize: '17pt', fontWeight: 700, lineHeight: 1.15, marginTop: '1mm' }} className="truncate">
              {title}
            </p>
            <p style={{ fontSize: '9.5pt', marginTop: '1mm' }}>
              {d.model.manufacturer} {d.model.name} · {CATEGORY_LABELS[d.category]} · {d.model.uHeight}U
            </p>
            <p style={{ fontSize: '9pt', marginTop: '1.5mm' }}>
              <b>Asset tag</b> <span className="mono">{d.assetTag}</span>
              {d.serial && (
                <>
                  {'  ·  '}
                  <b>Serial</b> <span className="mono">{d.serial}</span>
                </>
              )}
              {'  ·  '}
              <b>State</b> {LIFECYCLE_LABELS[d.lifecycleState]}
            </p>
          </div>
          {d.photoUpdatedAt && (
            <figure className="shrink-0 self-end text-center" style={{ margin: 0, maxWidth: '56mm' }}>
              <img src={photoUrl(d.id, d.photoUpdatedAt)} alt="Front of the device" style={{ maxHeight: '27mm', maxWidth: '56mm', margin: '0 auto', objectFit: 'contain', border: '.5pt solid #ccc' }} />
              <figcaption style={{ fontSize: '6.5pt', color: '#444', marginTop: '1mm' }}>Front view</figcaption>
            </figure>
          )}
          {label.data && (
            <div className="shrink-0 text-center">
              <div className="size-[26mm] [&_svg]:size-full" dangerouslySetInnerHTML={{ __html: label.data.qrSvg }} />
              <p style={{ fontSize: '6.5pt', marginTop: '1mm', color: '#444' }}>Scan to open in NexoraDC</p>
            </div>
          )}
        </div>

        <section className="sheet-section">
          <h2>Location, ownership and warranty</h2>
          <Facts
            items={[
              ['Datacenter', loc?.datacenterCode ?? 'Not in a rack'],
              ['Room', loc?.roomName],
              ['Rack', loc?.rackName],
              ['Position', loc ? (loc.positionU ? `U${loc.positionU}${d.model.uHeight > 1 ? `–U${loc.positionU + d.model.uHeight - 1}` : ''}${loc.face === 'rear' ? ' (rear)' : ''}` : '0U') : null],
              ['Customer', d.customerName ?? (staff ? 'Company equipment' : null)],
              ['Ownership', d.ownership === 'customer' ? 'Customer-owned' : 'Company-owned'],
              ['Warranty until', d.warrantyExpires],
              ...(staff
                ? ([
                    ['Supplier', d.supplier],
                    ['Purchased', d.purchaseDate],
                    ['End of life', d.eolDate],
                  ] as [string, ReactNode][])
                : []),
            ]}
          />
        </section>

        <section className="sheet-section">
          <h2>Management and network</h2>
          <Facts
            items={[
              ['BMC', d.mgmtAddress ? <span className="mono">{`${d.mgmtType?.toUpperCase() ?? ''} ${d.mgmtAddress}`.trim()}</span> : '—'],
              ['BMC status', reach ? reach.mgmt.state.toUpperCase() : null],
              ['Server address', d.serverAddress ? <span className="mono">{d.serverAddress}</span> : '—'],
              ['Server status', reach ? reach.server.state.toUpperCase() : null],
              ['Operating system', dash(d.os)],
              ['Firmware', [d.biosVersion && `BIOS ${d.biosVersion}`, d.bmcFirmware && `BMC ${d.bmcFirmware}`].filter(Boolean).join(' · ') || '—'],
            ]}
          />
          {!!addrs.data?.items.length && (
            <table style={{ marginTop: '2mm' }}>
              <thead>
                <tr>
                  <th>IP address</th>
                  <th>Subnet</th>
                  <th>Name</th>
                  <th>Port</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {addrs.data.items.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{a.address}</td>
                    <td className="mono">{dash(a.prefix)}</td>
                    <td>{dash(a.dnsName)}</td>
                    <td>{dash(a.interfaceName)}</td>
                    <td>{IP_STATUS_LABELS[a.status] ?? a.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!!ports.data?.items.length && (
            <table style={{ marginTop: '2mm' }}>
              <thead>
                <tr>
                  <th>Switch / router port</th>
                  <th>Connected to</th>
                  <th>Speed</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {ports.data.items.map((x) => (
                  <tr key={x.interfaceId}>
                    <td>
                      <span className="mono">{x.name}</span> on {x.deviceName}
                    </td>
                    <td>{dash(x.peer)}</td>
                    <td>{x.speedBps ? formatBitRate(x.speedBps) : '—'}</td>
                    <td>{x.operUp === null ? '—' : x.operUp ? 'Up' : 'Down'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="sheet-section">
          <h2>Hardware</h2>
          <Facts
            items={[
              ['CPU', inv?.processors.length ? `${inv.processors.length} × ${inv.processors[0]!.model ?? 'CPU'}` : d.cpu ? `${d.cpuCount ? `${d.cpuCount} × ` : ''}${d.cpu}` : '—'],
              ['Cores / threads', inv?.processors.length ? `${inv.processors.reduce((a, c) => a + (c.cores ?? 0), 0)} / ${inv.processors.reduce((a, c) => a + (c.threads ?? 0), 0)}` : null],
              ['Memory', inv?.memory.length ? `${inv.memory.reduce((a, m) => a + (m.sizeGb ?? 0), 0)} GB in ${inv.memory.length} modules` : d.ramGb ? `${d.ramGb} GB${d.dimmLayout ? ` (${d.dimmLayout})` : ''}` : '—'],
              ['RAID', dash(d.raid ?? (inv?.volumes[0]?.raid ?? null))],
              ['Drives', inv?.drives.length ? `${inv.drives.length}, ${gbText(inv.drives.reduce((a, x) => a + (x.capacityGb ?? 0), 0))} total` : d.disks.length ? `${d.disks.length}, ${gbText(d.disks.reduce((a, x) => a + x.sizeGb, 0))} total` : '—'],
              ['Health (BMC)', inv ? healthText(hw.data?.health) : null],
              ['Read from BMC', hw.data?.fetchedAt ? formatDateTime(hw.data.fetchedAt) : null],
            ]}
          />
          {!!inv?.memory.length && (
            <table style={{ marginTop: '2mm' }}>
              <thead>
                <tr>
                  <th>Memory slot</th>
                  <th>Size</th>
                  <th>Type / speed</th>
                  <th>Part number</th>
                  <th>Serial</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {inv.memory.map((m) => (
                  <tr key={m.slot}>
                    <td className="mono">{m.slot}</td>
                    <td>{m.sizeGb ? `${m.sizeGb} GB` : '—'}</td>
                    <td>
                      {dash(m.type)}
                      {m.speedMhz ? ` · ${m.speedMhz} MHz` : ''}
                    </td>
                    <td className="mono">{dash(m.partNumber)}</td>
                    <td className="mono">{dash(m.serial)}</td>
                    <td>{healthText(m.health)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {(inv?.drives.length ? inv.drives.length : d.disks.length) > 0 && (
            <table style={{ marginTop: '2mm' }}>
              <thead>
                <tr>
                  <th>Drive slot</th>
                  <th>Model</th>
                  <th>Type</th>
                  <th>Capacity</th>
                  <th>Serial</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {inv?.drives.length
                  ? inv.drives.map((x, i) => (
                      <tr key={i}>
                        <td className="mono">{dash(x.slot)}</td>
                        <td>{dash(x.model ?? x.name)}</td>
                        <td>{[x.mediaType, x.protocol].filter(Boolean).join(' / ') || '—'}</td>
                        <td>{gbText(x.capacityGb)}</td>
                        <td className="mono">{dash(x.serial)}</td>
                        <td>
                          {healthText(x.health)}
                          {x.lifeLeftPercent !== null ? ` · ${x.lifeLeftPercent}% life` : ''}
                        </td>
                      </tr>
                    ))
                  : d.disks.map((x, i) => (
                      <tr key={i}>
                        <td className="mono">{dash(x.slot)}</td>
                        <td>{dash(x.model)}</td>
                        <td>{x.type}</td>
                        <td>{gbText(x.sizeGb)}</td>
                        <td>—</td>
                        <td>—</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          )}
          {(inv?.nics.length || d.nics.length) > 0 && (
            <table style={{ marginTop: '2mm' }}>
              <thead>
                <tr>
                  <th>Network adapter</th>
                  <th>MAC address</th>
                  <th>Speed</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {inv?.nics.length
                  ? inv.nics.map((n) => (
                      <tr key={n.name}>
                        <td className="mono">{n.name}</td>
                        <td className="mono">{dash(n.mac)}</td>
                        <td>{n.speedMbps ? (n.speedMbps >= 1000 ? `${n.speedMbps / 1000} Gbit/s` : `${n.speedMbps} Mbit/s`) : '—'}</td>
                        <td>{dash(n.linkStatus)}</td>
                      </tr>
                    ))
                  : d.nics.map((n, i) => (
                      <tr key={i}>
                        <td className="mono">{n.name}</td>
                        <td className="mono">{dash(n.mac)}</td>
                        <td>{dash(n.speed)}</td>
                        <td>—</td>
                      </tr>
                    ))}
              </tbody>
            </table>
          )}
        </section>

        {(p || can('power.read')) && (
          <section className="sheet-section">
            <h2>Power</h2>
            <Facts
              items={[
                ['Power now', p ? (p.watts !== null ? `${formatWattsShort(p.watts)} (${p.quality}${p.source ? `, ${p.source}` : ''})` : 'Not measured') : '—'],
                ['Energy, last 30 days', energy !== null ? `${formatKwh(energy)}${p?.energy && p.energy.estimatedKwh > 0 ? ` (${formatKwh(p.energy.estimatedKwh)} estimated)` : ''}` : '—'],
                ['Typical / maximum draw', spec && (spec.typicalW || spec.maxW) ? `${spec.typicalW ? formatWattsShort(spec.typicalW) : '—'} / ${spec.maxW ? formatWattsShort(spec.maxW) : '—'} (model)` : null],
                ['Estimate used', p?.estimateW && p.quality !== 'measured' ? `${formatWattsShort(p.estimateW)} (${p.estimateKind === 'admin' ? 'set for this device' : 'from the model'})` : null],
                ['Power supplies', psus ?? (spec?.psuCount ? `${spec.psuCount}${spec.psuRatedW ? ` × ${formatWattsShort(spec.psuRatedW)}` : ''} (model)` : null)],
                ['Power reading', p?.polling && p.quality !== 'measured' ? `${p.polling.credentialKind.toUpperCase()} ${p.polling.enabled ? (p.polling.lastError ? 'failing' : 'not answered yet') : 'paused'}` : null],
                ['Fed from (PDU outlets)', outlets.length ? outlets.map((o) => `${o.pdu_name ?? 'PDU'} outlet ${o.outlet_number}${o.label ? ` (${o.label})` : ''}`).join(', ') : null],
              ]}
            />
          </section>
        )}

        <section className="sheet-section">
          <h2>Fitted items</h2>
          {acc.data?.length ? (
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Qty</th>
                  <th>Description</th>
                  <th>Length</th>
                  <th>Part / serial</th>
                </tr>
              </thead>
              <tbody>
                {acc.data.map((a) => (
                  <tr key={a.id}>
                    <td>{ACCESSORY_LABELS[a.kind] ?? a.kind}</td>
                    <td>{a.quantity}</td>
                    <td>{dash(a.description)}</td>
                    <td>{a.lengthM !== null ? `${a.lengthM} m` : '—'}</td>
                    <td className="mono">{[a.partNumber, a.serial].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ color: '#555' }}>None recorded (rails, cables, transceivers and other items fitted with the device are listed here once added on its page).</p>
          )}
        </section>

        {events.length > 0 && (
          <section className="sheet-section">
            <h2>Recent BMC warnings</h2>
            <table>
              <thead>
                <tr>
                  <th style={{ width: '36mm' }}>When</th>
                  <th style={{ width: '18mm' }}>Severity</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={`${e.log}-${e.id}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>{e.created ? formatDateTime(e.created) : '—'}</td>
                    <td>{e.severity}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="sheet-section">
          <h2>Notes</h2>
          {withNotes && staff && (d.notes || noteEvents.length > 0) ? (
            <div style={{ border: '.5pt solid #ccc', padding: '1.5mm 2mm' }}>
              {d.notes && <p style={{ whiteSpace: 'pre-wrap', marginBottom: noteEvents.length ? '1.5mm' : 0 }}>{d.notes}</p>}
              {noteEvents.map((e) => (
                <p key={e.id} style={{ marginTop: '.6mm' }}>
                  <b>{formatDateTime(e.occurredAt ?? e.createdAt ?? null).split(',')[0]}</b> · {e.kind === 'maintenance' ? 'Maintenance' : 'Note'}: {e.summary}
                  {e.actorLabel && <span style={{ color: '#555' }}> ({e.actorLabel})</span>}
                </p>
              ))}
            </div>
          ) : null}
          {/* Lines to write on by hand. */}
          {Array.from({ length: withNotes && staff && (d.notes || noteEvents.length) ? 2 : 3 }, (_, i) => (
            <div key={i} style={{ borderBottom: '.5pt solid #bbb', height: '6.5mm' }} />
          ))}
        </section>

        <section className="sheet-section" style={{ marginTop: '5mm' }}>
          <div className="grid grid-cols-2 gap-[10mm]" style={{ fontSize: '8pt' }}>
            <div>
              <div style={{ borderBottom: '.6pt solid #111', height: '8mm' }} />
              <p style={{ marginTop: '1mm' }}>Checked by (name, signature, date)</p>
            </div>
            <div>
              <div style={{ borderBottom: '.6pt solid #111', height: '8mm' }} />
              <p style={{ marginTop: '1mm' }}>{d.customerName ? 'Customer acknowledgement' : 'Approved by'}</p>
            </div>
          </div>
          <p style={{ fontSize: '6.5pt', color: '#555', marginTop: '3mm' }}>
            Generated by NexoraDC on {formatDateTime(new Date().toISOString())} by {me?.user.email}. Figures are as recorded and as last read from the equipment; estimates are marked. {label.data?.url}
          </p>
        </section>
      </div>
    </>
  );
}

function Toolbar({ back, count, notes }: { back: ReactNode; count?: number; notes: [boolean, (v: boolean) => void] }) {
  const { me } = useAuth();
  return (
    <div className="no-print mb-4 flex flex-wrap items-center gap-3">
      {back}
      <span className="flex-1" />
      {me?.user.userType === 'staff' && (
        <label className="flex items-center gap-2 text-[13px]" title="Internal notes and maintenance notes are for staff; untick before handing the sheet to a customer.">
          <input type="checkbox" checked={notes[0]} onChange={(e) => notes[1](e.target.checked)} />
          Include internal notes
        </label>
      )}
      <span className="text-[12.5px] text-ink-3">
        {count ? `${count} datasheet${count === 1 ? '' : 's'}, each on its own A4 page. ` : 'A4 portrait. '}In the print dialog, turn off “Headers and footers” for a clean page.
      </span>
      <Button variant="primary" onClick={() => window.print()}>
        Print / Save as PDF
      </Button>
    </div>
  );
}

/**
 * On a narrow screen (a phone) the A4 sheet is shown whole and scaled down, like a
 * PDF preview, instead of squeezing its columns; printing always uses full size.
 */
function SheetsFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const A4_PX = (210 / 25.4) * 96;
    const fit = () => el.style.setProperty('--sheet-zoom', String(Math.min(1, el.clientWidth / A4_PX)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div id="sheets" ref={ref}>
      {children}
    </div>
  );
}

export function DeviceSheetPage() {
  const { id = '' } = useParams();
  const notes = useState(true);
  return (
    <>
      <style>{PRINT_CSS}</style>
      <Toolbar
        notes={notes}
        back={
          <Link to={`/hardware/${id}`} className="text-[13px] text-accent hover:underline">
            ← Back to the device
          </Link>
        }
      />
      <SheetsFrame>
        <DeviceSheet id={id} withNotes={notes[0]} />
      </SheetsFrame>
    </>
  );
}

/** Datasheets of several devices (?ids=a,b,c), each starting on a new page. */
export function DeviceSheetsPage() {
  const [params] = useSearchParams();
  const notes = useState(true);
  const ids = [...new Set((params.get('ids') ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 100);
  return (
    <>
      <style>{PRINT_CSS}</style>
      <Toolbar
        notes={notes}
        count={ids.length}
        back={
          <Link to="/hardware" className="text-[13px] text-accent hover:underline">
            ← Servers and hardware
          </Link>
        }
      />
      {!ids.length && <p className="text-[13px] text-ink-2">Select devices in the list first.</p>}
      <SheetsFrame>
        {ids.map((id) => (
          <DeviceSheet key={id} id={id} withNotes={notes[0]} />
        ))}
      </SheetsFrame>
    </>
  );
}
