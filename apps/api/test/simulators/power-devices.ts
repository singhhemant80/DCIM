import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Simulated power sources, built from the published Redfish schema and the
 * documented `ipmitool dcmi power reading` output. They are simulators, not
 * captures from a specific BMC firmware.
 */

export interface MockRedfish {
  port: number;
  /** Change the reported PowerConsumedWatts. */
  setWatts: (w: number | null) => void;
  requests: { method: string; url: string }[];
  close: () => Promise<void>;
}

/** Dell-iDRAC-shaped Redfish service with one system and one chassis. */
export async function startRedfish(
  user: string,
  pass: string,
  opts: {
    watts?: number;
    environmentMetricsOnly?: boolean;
    port?: number;
    expand?: boolean;
    maxConcurrent?: number;
    noMemoryLink?: boolean;
    /** Like early iDRAC 9 firmware: no Memory or Storage collection, disks only under SimpleStorage. */ oldIdrac?: boolean;
    wsmanMemory?: boolean;
    /** Answer the /Systems collection with this error status (as a stuck iDRAC web service does), while the system itself still works. */ systemsError?: number;
  } = {},
): Promise<MockRedfish> {
  let watts: number | null = opts.watts ?? 312;
  const requests: { method: string; url: string }[] = [];
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const S = '/redfish/v1/Systems/System.Embedded.1';
  const M = '/redfish/v1/Managers/iDRAC.Embedded.1';
  const link = (p: string) => ({ '@odata.id': p });
  const coll = (ps: string[]) => ({ Members: ps.map(link) });
  const ok = { State: 'Enabled', Health: 'OK' };
  const dimms = ['A1', 'A2', 'B1', 'B2'];
  const sel = Array.from({ length: 5 }, (_, i) => ({
    Id: String(i + 1),
    Created: `2026-10-1${i}T08:00:00+00:00`,
    Severity: i === 4 ? 'Critical' : i === 3 ? 'Warning' : 'OK',
    Message: i === 4 ? 'The power supply PS2 is not receiving power.' : i === 3 ? 'Correctable memory error rate exceeded for DIMM A2.' : 'Log cleared.',
    MessageId: i === 4 ? 'PSU0003' : i === 3 ? 'MEM0702' : 'SEL9901',
  }));
  const docs = (): Record<string, unknown> => ({
    '/redfish/v1/Systems': coll([S]),
    [S]: {
      Manufacturer: 'Dell Inc.',
      Model: 'PowerEdge R650',
      SerialNumber: 'CN7XXXX',
      SKU: 'HH90TAG',
      PowerState: 'On',
      HostName: 'srv-01',
      BiosVersion: '1.10.2',
      Status: { State: 'Enabled', Health: 'Warning', HealthRollup: 'Warning' },
      ProcessorSummary: { Count: 2, Model: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', LogicalProcessorCount: 128 },
      MemorySummary: { TotalSystemMemoryGiB: 128 },
      Processors: link(`${S}/Processors`),
      ...(opts.noMemoryLink || opts.oldIdrac ? {} : { Memory: link(`${S}/Memory`) }),
      ...(opts.oldIdrac ? { SimpleStorage: link(`${S}/SimpleStorage`) } : { Storage: link(`${S}/Storage`) }),
      EthernetInterfaces: link(`${S}/EthernetInterfaces`),
      LogServices: link(`${S}/LogServices`),
    },
    ...(opts.oldIdrac
      ? {
          [`${S}/SimpleStorage`]: coll([`${S}/SimpleStorage/RAID.Integrated.1-1`]),
          [`${S}/SimpleStorage/RAID.Integrated.1-1`]: { Id: 'RAID.Integrated.1-1', Name: 'PERC H730 Mini', Status: ok, Devices: [{ Name: 'Solid State Disk 0:1:0', Model: 'INTEL SSDSC2KB01', CapacityBytes: 1920383410176, Status: ok }] },
        }
      : {}),
    [`${S}/Processors`]: coll([`${S}/Processors/CPU.Socket.1`, `${S}/Processors/CPU.Socket.2`]),
    [`${S}/Processors/CPU.Socket.1`]: { Socket: 'CPU.Socket.1', ProcessorType: 'CPU', Model: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', TotalCores: 32, TotalThreads: 64, MaxSpeedMHz: 4000, Status: ok },
    [`${S}/Processors/CPU.Socket.2`]: { Socket: 'CPU.Socket.2', ProcessorType: 'CPU', Model: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', TotalCores: 32, TotalThreads: 64, MaxSpeedMHz: 4000, Status: ok },
    [`${S}/Memory`]: coll([...dimms.map((d) => `${S}/Memory/DIMM.Socket.${d}`), `${S}/Memory/DIMM.Socket.C1`]),
    ...Object.fromEntries(
      dimms.map((d) => [
        `${S}/Memory/DIMM.Socket.${d}`,
        {
          DeviceLocator: `DIMM.Socket.${d}`,
          CapacityMiB: 32768,
          MemoryDeviceType: 'DDR4',
          OperatingSpeedMhz: 3200,
          Manufacturer: 'Hynix',
          PartNumber: 'HMA84GR7DJR4N-XN',
          SerialNumber: `S${d}`,
          Status: d === 'A2' ? { State: 'Enabled', Health: 'Warning' } : ok,
        },
      ]),
    ),
    [`${S}/Memory/DIMM.Socket.C1`]: { DeviceLocator: 'DIMM.Socket.C1', CapacityMiB: 0, Status: { State: 'Absent' } },
    [`${S}/Storage`]: coll([`${S}/Storage/RAID.Integrated.1-1`]),
    [`${S}/Storage/RAID.Integrated.1-1`]: {
      Id: 'RAID.Integrated.1-1',
      Name: 'PERC H755',
      StorageControllers: [{ Name: 'PERC H755 Front', Model: 'PERC H755 Front', FirmwareVersion: '52.16.1-4405', Status: ok }],
      Drives: [link(`${S}/Storage/Drives/Disk.Bay.0`), link(`${S}/Storage/Drives/Disk.Bay.1`)],
      Volumes: link(`${S}/Storage/RAID.Integrated.1-1/Volumes`),
    },
    [`${S}/Storage/Drives/Disk.Bay.0`]: {
      Name: 'SSD 0',
      Model: 'MZ7LH960HBJR0D3',
      SerialNumber: 'SSD0SER',
      MediaType: 'SSD',
      Protocol: 'SATA',
      CapacityBytes: 960197124096,
      PredictedMediaLifeLeftPercent: 97,
      FailurePredicted: false,
      PhysicalLocation: { PartLocation: { LocationOrdinalValue: 0 } },
      Status: ok,
    },
    [`${S}/Storage/Drives/Disk.Bay.1`]: {
      Name: 'SSD 1',
      Model: 'MZ7LH960HBJR0D3',
      SerialNumber: 'SSD1SER',
      MediaType: 'SSD',
      Protocol: 'SATA',
      CapacityBytes: 960197124096,
      PredictedMediaLifeLeftPercent: 12,
      FailurePredicted: true,
      PhysicalLocation: { PartLocation: { LocationOrdinalValue: 1 } },
      Status: { State: 'Enabled', Health: 'Warning' },
    },
    [`${S}/Storage/RAID.Integrated.1-1/Volumes`]: coll([`${S}/Storage/Volumes/Disk.Virtual.0`]),
    [`${S}/Storage/Volumes/Disk.Virtual.0`]: { Name: 'VD0', RAIDType: 'RAID1', CapacityBytes: 959656755200, Status: ok },
    [`${S}/EthernetInterfaces`]: coll([`${S}/EthernetInterfaces/NIC.Slot.1-1-1`]),
    [`${S}/EthernetInterfaces/NIC.Slot.1-1-1`]: { Id: 'NIC.Slot.1-1-1', MACAddress: 'B8:CE:F6:00:11:22', SpeedMbps: 25000, LinkStatus: 'LinkUp', Status: ok },
    [`${S}/LogServices`]: coll([]),
    '/redfish/v1/Chassis': coll(['/redfish/v1/Chassis/System.Embedded.1']),
    '/redfish/v1/Chassis/System.Embedded.1': opts.environmentMetricsOnly
      ? { EnvironmentMetrics: link('/redfish/v1/Chassis/System.Embedded.1/EnvironmentMetrics') }
      : { Power: link('/redfish/v1/Chassis/System.Embedded.1/Power'), Thermal: link('/redfish/v1/Chassis/System.Embedded.1/Thermal') },
    '/redfish/v1/Chassis/System.Embedded.1/Power': {
      PowerControl: [{ Name: 'System Power Control', PowerConsumedWatts: watts, PowerCapacityWatts: 1400 }],
      PowerSupplies: [
        { Name: 'PS1 Status', Model: 'PWR SPLY,800W,RDNT,LTON', SerialNumber: 'PS1SER', PowerCapacityWatts: 800, PowerInputWatts: 190, LastPowerOutputWatts: 170, FirmwareVersion: '00.1D.7D', Status: ok },
        { Name: 'PS2 Status', Model: 'PWR SPLY,800W,RDNT,LTON', SerialNumber: 'PS2SER', PowerCapacityWatts: 800, PowerInputWatts: 0, LastPowerOutputWatts: 0, FirmwareVersion: '00.1D.7D', Status: { State: 'Enabled', Health: 'Critical' } },
      ],
    },
    '/redfish/v1/Chassis/System.Embedded.1/Thermal': {
      Fans: [{ Name: 'System Board Fan1A', Reading: 7800, ReadingUnits: 'RPM', Status: ok }],
      Temperatures: [
        { Name: 'CPU1 Temp', ReadingCelsius: 54, UpperThresholdCritical: 98, Status: ok },
        { Name: 'Inlet Temp', ReadingCelsius: 23, UpperThresholdCritical: 47, Status: ok },
      ],
    },
    '/redfish/v1/Chassis/System.Embedded.1/EnvironmentMetrics': { PowerWatts: { Reading: watts } },
    '/redfish/v1/Managers': coll([M]),
    [M]: { Model: '15G Monolithic', FirmwareVersion: '7.00.00.171', LogServices: link(`${M}/LogServices`) },
    [`${M}/LogServices`]: coll([`${M}/LogServices/Sel`, `${M}/LogServices/Lclog`]),
    [`${M}/LogServices/Sel`]: { Id: 'Sel', Entries: link(`${M}/LogServices/Sel/Entries`) },
    [`${M}/LogServices/Lclog`]: { Id: 'Lclog', Entries: link(`${M}/LogServices/Lclog/Entries`) },
    // Two pages, to check that paging is followed.
    [`${M}/LogServices/Sel/Entries`]: { Members: sel.slice(0, 3), 'Members@odata.nextLink': `${M}/LogServices/Sel/Entries?$skip=3` },
    [`${M}/LogServices/Sel/Entries?$skip=3`]: { Members: sel.slice(3) },
    [`${M}/LogServices/Lclog/Entries`]: { Members: [{ Id: 'lc1', Message: 'Lifecycle noise', Severity: 'OK' }] },
  });
  let inFlight = 0;
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url! });
    inFlight++;
    const send = (status: number, body?: unknown) => {
      // Answers are a little delayed so concurrent requests overlap.
      setTimeout(() => {
        inFlight--;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      }, 5);
    };
    // A busy BMC refuses requests beyond what it can handle at once.
    if (opts.maxConcurrent && inFlight > opts.maxConcurrent) return send(503, { error: 'Service unavailable' });
    if (req.method === 'POST' && req.url === '/wsman' && opts.wsmanMemory) {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const reply = (status: number, xml: string) =>
          setTimeout(() => {
            inFlight--;
            res.writeHead(status, { 'Content-Type': 'application/soap+xml;charset=UTF-8' });
            res.end(xml);
          }, 5);
        if (req.headers.authorization !== expected) return reply(401, '');
        if (!body.includes('DCIM_MemoryView')) return reply(400, '<fault>unsupported resource</fault>');
        const dimm = (slot: string, health: string) =>
          `<n1:DCIM_MemoryView><n1:BankLabel>A</n1:BankLabel><n1:CurrentOperatingSpeed>2666</n1:CurrentOperatingSpeed><n1:DeviceDescription>DIMM ${slot}</n1:DeviceDescription><n1:FQDD>DIMM.Socket.${slot}</n1:FQDD><n1:InstanceID>DIMM.Socket.${slot}</n1:InstanceID><n1:LastSystemInventoryTime xsi:nil="true"/><n1:Manufacturer>Samsung</n1:Manufacturer><n1:MemoryType>26</n1:MemoryType><n1:PartNumber>M393A4K40CB2-CTD</n1:PartNumber><n1:PrimaryStatus>${health}</n1:PrimaryStatus><n1:SerialNumber>SN${slot}</n1:SerialNumber><n1:Size>32768</n1:Size><n1:Speed>2666</n1:Speed></n1:DCIM_MemoryView>`;
        const wrap = (inner: string) =>
          `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsen="http://schemas.xmlsoap.org/ws/2004/09/enumeration" xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:n1="http://schemas.dell.com/wbem/wscim/1/cim-schema/2/DCIM_MemoryView" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><s:Header/><s:Body>${inner}</s:Body></s:Envelope>`;
        // Two modules in the first answer, the third after a Pull, as a real iDRAC pages them.
        if (body.includes('enumeration/Enumerate'))
          return reply(200, wrap(`<wsen:EnumerateResponse><wsen:EnumerationContext>ctx-1</wsen:EnumerationContext><wsman:Items>${dimm('A1', '1')}${dimm('A2', '2')}</wsman:Items></wsen:EnumerateResponse>`));
        if (body.includes('enumeration/Pull') && body.includes('ctx-1')) return reply(200, wrap(`<wsen:PullResponse><wsen:Items>${dimm('B1', '1')}</wsen:Items><wsen:EndOfSequence/></wsen:PullResponse>`));
        return reply(400, '<fault>bad request</fault>');
      });
      return;
    }
    if (req.method !== 'GET') return send(405, { error: 'Method not allowed' });
    if (req.headers.authorization !== expected) return send(401, { error: 'Unauthorized' });
    const all = docs();
    // iDRAC 9 style $expand: collection members are returned in full.
    if (opts.expand && /\?\$expand=/.test(req.url!)) {
      const c = all[req.url!.split('?')[0]!] as { Members?: { '@odata.id': string }[] } | undefined;
      if (c && Array.isArray(c.Members)) return send(200, { ...c, Members: c.Members.map((m) => ({ '@odata.id': m['@odata.id'], ...(all[m['@odata.id']] as object) })) });
    }
    if (opts.systemsError && req.url!.split('?')[0] === '/redfish/v1/Systems')
      return send(opts.systemsError, {
        error: {
          code: 'Base.1.8.GeneralError',
          message: 'A general error has occurred. See ExtendedInfo for more information.',
          '@Message.ExtendedInfo': [{ MessageId: 'IDRAC.2.8.SYS446', Message: 'Unable to complete the operation because of an internal error.', Resolution: 'Retry the operation. If the issue persists, reset iDRAC.' }],
        },
      });
    if (opts.oldIdrac && /^\/redfish\/v1\/Systems\/System\.Embedded\.1\/(Memory|Storage)\b/.test(req.url!)) return send(404, { error: 'Not found' });
    const doc = all[req.url!] ?? all[req.url!.split('?')[0]!];
    return doc === undefined ? send(404, { error: 'Not found' }) : send(200, doc);
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, setWatts: (w) => (watts = w), requests, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * A stand-in `ipmitool` executable: answers `mc info` and `dcmi power reading`
 * like the real tool, checks the password from the IPMI_PASSWORD environment
 * variable, and records its argument list so tests can check the password is
 * never on the command line.
 */
export function fakeIpmitool(password: string, opts: { watts?: number; deactivated?: boolean } = {}): { path: string; argsFile: string; setWatts: (w: number) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cdcim-ipmi-'));
  const argsFile = join(dir, 'args.log');
  const wattsFile = join(dir, 'watts');
  writeFileSync(wattsFile, String(opts.watts ?? 245));
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args) + '\\n');
if (process.env.IPMI_PASSWORD !== ${JSON.stringify(password)}) {
  process.stderr.write('Error: Unable to establish IPMI v2 / RMCP+ session\\nRAKP 2 HMAC is invalid\\n');
  process.exit(1);
}
const cmd = args.slice(-3).join(' ');
if (args.slice(-2).join(' ') === 'mc info') {
  process.stdout.write('Device ID                 : 32\\nFirmware Revision         : 7.00\\nManufacturer Name         : DELL Inc\\nProduct Name              : iDRAC\\n');
} else if (cmd === 'dcmi power reading') {
  const w = fs.readFileSync(${JSON.stringify(wattsFile)}, 'utf8').trim();
  process.stdout.write('\\n    Instantaneous power reading:                   ' + w + ' Watts\\n    Minimum during sampling period:                 180 Watts\\n    Maximum during sampling period:                 410 Watts\\n    Average power reading over sample period:       240 Watts\\n    IPMI timestamp:                           Sat Oct 10 04:00:00 2026\\n    Sampling period:                          00000005 Seconds.\\n    Power reading state is:                   ${opts.deactivated ? 'deactivated' : 'activated'}\\n');
} else {
  process.stderr.write('Invalid command\\n');
  process.exit(1);
}
`;
  const path = join(dir, 'ipmitool');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, argsFile, setWatts: (w) => writeFileSync(wattsFile, String(w)) };
}

/** RouterOS /system/health (v7 list form) and NX-OS `show environment power` bodies. */
export const ROUTEROS_HEALTH = [
  { '.id': '*1', name: 'voltage', value: '24.1', type: 'V' },
  { '.id': '*2', name: 'power-consumption', value: '38.5', type: 'W' },
  { '.id': '*3', name: 'temperature', value: '41', type: 'C' },
];
export const NXOS_POWER = {
  power_summary: { ps_redun_mode: 'Redundant', tot_pow_capacity: '1100.00 W', tot_pow_input_actual_draw: '287.00 W', tot_pow_out_actual_draw: '262.00 W' },
  powersup: {
    TABLE_psinfo: {
      ROW_psinfo: [
        { psnum: 1, psmodel: 'NXA-PAC-650W-PE', actual_input: '144 W', actual_out: '131 W', ps_status: 'Ok' },
        { psnum: 2, psmodel: 'NXA-PAC-650W-PE', actual_input: '143 W', actual_out: '131 W', ps_status: 'Ok' },
      ],
    },
  },
};
