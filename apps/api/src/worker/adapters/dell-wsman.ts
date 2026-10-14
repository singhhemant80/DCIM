import { randomUUID } from 'node:crypto';
import type { HwHealth, HwMemory } from '@crapplet/shared';
import type { AdapterTarget } from '../../network/discovery/types';
import { basicAuth, deviceRequest } from './http';

/**
 * Dell iDRAC memory list over WS-Management, for iDRAC firmware whose Redfish
 * service has no Memory collection. Read-only: only WS-Man Enumerate/Pull of
 * the DCIM_MemoryView class (a SOAP POST that reads, never changes, anything).
 * No other class or action can be sent from here.
 */
const MEMORY_VIEW = 'http://schemas.dell.com/wbem/wscim/1/cim-schema/2/DCIM_MemoryView';
const ENUM = 'http://schemas.xmlsoap.org/ws/2004/09/enumeration';

const esc = (v: string) => v.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

function envelope(to: string, action: 'Enumerate' | 'Pull', context?: string) {
  const body =
    action === 'Enumerate'
      ? '<wsen:Enumerate><wsman:OptimizeEnumeration/><wsman:MaxElements>64</wsman:MaxElements></wsen:Enumerate>'
      : `<wsen:Pull><wsen:EnumerationContext>${esc(context ?? '')}</wsen:EnumerationContext><wsen:MaxElements>64</wsen:MaxElements></wsen:Pull>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:wsen="${ENUM}">
<s:Header>
<wsa:To s:mustUnderstand="true">${esc(to)}</wsa:To>
<wsman:ResourceURI s:mustUnderstand="true">${MEMORY_VIEW}</wsman:ResourceURI>
<wsa:ReplyTo><wsa:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>
<wsa:Action s:mustUnderstand="true">${ENUM}/${action}</wsa:Action>
<wsa:MessageID s:mustUnderstand="true">uuid:${randomUUID()}</wsa:MessageID>
<wsman:MaxEnvelopeSize s:mustUnderstand="true">512000</wsman:MaxEnvelopeSize>
<wsman:OperationTimeout>PT60S</wsman:OperationTimeout>
</s:Header>
<s:Body>${body}</s:Body>
</s:Envelope>`;
}

const unesc = (v: string) =>
  v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');

/** The DCIM_MemoryView items of a WS-Man answer, as field → text maps. */
export function memoryViewItems(xml: string): Record<string, string | null>[] {
  const out: Record<string, string | null>[] = [];
  const itemRe = /<(\w+:)?DCIM_MemoryView\b[^>]*>([\s\S]*?)<\/\1?DCIM_MemoryView>/g;
  for (const m of xml.matchAll(itemRe)) {
    const fields: Record<string, string | null> = {};
    for (const f of m[2]!.matchAll(/<(?:\w+:)?(\w+)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?\1>)/g)) {
      fields[f[1]!] = f[3] === undefined || /nil="true"/.test(f[2]!) ? null : unesc(f[3].trim());
    }
    out.push(fields);
  }
  return out;
}

// CIM_PhysicalMemory.MemoryType values used by Dell.
const MEMORY_TYPES: Record<string, string> = { '20': 'DDR', '21': 'DDR2', '24': 'DDR3', '26': 'DDR4', '34': 'DDR5' };
const num = (v: string | null | undefined) => (v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
function health(primaryStatus: string | null | undefined): HwHealth {
  switch (primaryStatus) {
    case '1':
      return 'OK';
    case '2':
      return 'Warning';
    case '3':
      return 'Critical';
    default:
      return null;
  }
}

export function memoryFromView(items: Record<string, string | null>[]): HwMemory[] {
  return items
    .filter((f) => (num(f.Size) ?? 1) > 0)
    .map((f) => ({
      slot: f.FQDD ?? f.InstanceID ?? f.DeviceDescription ?? 'DIMM',
      // Size is in MB.
      sizeGb: num(f.Size) !== null ? Math.round(num(f.Size)! / 1024) : null,
      type: (f.MemoryType && (MEMORY_TYPES[f.MemoryType] ?? (/^\d+$/.test(f.MemoryType) ? null : f.MemoryType))) || null,
      speedMhz: num(f.CurrentOperatingSpeed) ?? num(f.Speed),
      manufacturer: f.Manufacturer || null,
      partNumber: f.PartNumber || null,
      serial: f.SerialNumber || null,
      health: health(f.PrimaryStatus),
    }));
}

/** Reads the memory modules of a Dell iDRAC over WS-Man (Enumerate, then Pull until done). */
export async function dellMemoryViaWsman(t: AdapterTarget): Promise<HwMemory[]> {
  const scheme = t.params.scheme ?? 'https';
  const port = t.port ?? (scheme === 'https' ? 443 : 80);
  const to = `${scheme}://${t.host}:${port}/wsman`;
  const send = async (xml: string) => {
    const r = await deviceRequest(t, 'POST', '/wsman', { headers: { Authorization: basicAuth(t.username, t.secret.password) }, raw: { data: xml, contentType: 'application/soap+xml;charset=UTF-8' }, defaultPort: scheme === 'https' ? 443 : 80 });
    return r.text ?? '';
  };
  let xml = await send(envelope(to, 'Enumerate'));
  const items = memoryViewItems(xml);
  for (let pulls = 0; pulls < 5 && !/EndOfSequence/.test(xml); pulls++) {
    const ctx = /<(?:\w+:)?EnumerationContext[^>]*>([^<]+)</.exec(xml)?.[1];
    if (!ctx) break;
    xml = await send(envelope(to, 'Pull', unesc(ctx.trim())));
    items.push(...memoryViewItems(xml));
  }
  return memoryFromView(items);
}
