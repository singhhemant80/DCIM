import { Link } from 'react-router-dom';
import { relativeTime } from '../lib/format';
import { OsIcon } from './OsIcon';

/**
 * Who uses an IP address: the server or device (brand, model, BMC), the VM
 * (OS, size, node), the server whose BMC it is, and — for addresses no record
 * points at — what your routers and DNS show (MAC, vendor, DHCP name, PTR).
 */
export interface AddressDetailsT {
  device: { hostname: string | null; assetTag: string | null; category: string | null; brand: string | null; model: string | null; bmc: { type: string | null; address: string | null } | null } | null;
  vm: { os: string | null; status: string | null; virtType: string | null; platform: string | null; cpus: number | null; memBytes: number | null; node: string | null; nodeDeviceId: string | null; nodeDeviceName: string | null } | null;
  bmcOf: { deviceId: string; name: string; type: string | null; brand: string | null; model: string | null } | null;
  observed: { mac: string | null; vendor: string | null; dhcpHostName: string | null; ptr: string | null; router: string | null; interface: string | null; seenAt: string | null } | null;
}

const BMC: Record<string, string> = { idrac: 'iDRAC', ilo: 'iLO', irmc: 'iRMC', ipmi: 'IPMI', redfish: 'BMC', other: 'BMC' };
const PLATFORM: Record<string, string> = { virtualizor: 'Virtualizor', proxmox: 'Proxmox' };
const gb = (b: number) => (b >= 1024 ** 3 ? `${Math.round(b / 1024 ** 3)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
/** "Dell PowerEdge R630", without repeating the brand when the model already starts with it. */
const brandModel = (brand: string | null, model: string | null) => (brand && model && model.toLowerCase().startsWith(brand.toLowerCase().split(/\s/)[0]!) ? model : [brand, model].filter(Boolean).join(' '));

export function AddressHolder({
  a,
  staff,
}: {
  a: { address: string; deviceId: string | null; deviceName: string | null; interfaceName: string | null; guestId: string | null; guestName: string | null; source: string; dnsName: string | null; details?: AddressDetailsT };
  staff: boolean;
}) {
  const d = a.details;
  const line = 'block text-[12px] text-ink-3';
  const ptr = d?.observed?.ptr && d.observed.ptr !== a.dnsName ? d.observed.ptr : null;
  return (
    <div className="min-w-0 text-[13px]">
      {a.deviceName && (
        <div>
          {staff && a.deviceId ? (
            <Link to={`/hardware/${a.deviceId}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
              {a.deviceName}
            </Link>
          ) : (
            a.deviceName
          )}
          {a.interfaceName && <span className="font-mono"> {a.interfaceName}</span>}
          {d?.device && (d.device.brand || d.device.model) && <span className={line}>{brandModel(d.device.brand, d.device.model)}</span>}
          {d?.device?.hostname && d.device.hostname !== a.deviceName && <span className={line}>Hostname {d.device.hostname}</span>}
          {d?.device?.bmc && (d.device.bmc.address || d.device.bmc.type) && (
            <span className={line}>
              {BMC[d.device.bmc.type ?? ''] ?? 'BMC'}
              {d.device.bmc.address ? <span className="font-mono"> {d.device.bmc.address}</span> : null}
            </span>
          )}
        </div>
      )}
      {a.guestName && (
        <div className={a.deviceName ? 'mt-1' : undefined}>
          <span className="inline-flex items-center gap-1.5">
            {d?.vm && <OsIcon osName={d.vm.os} size={13} />}
            <span>
              VM <span className="font-medium">{a.guestName}</span>
            </span>
          </span>
          {d?.vm?.os && <span className={line}>{d.vm.os}</span>}
          {d?.vm && (d.vm.cpus || d.vm.memBytes) && <span className={line}>{[d.vm.cpus ? `${d.vm.cpus} vCPU` : null, d.vm.memBytes ? gb(d.vm.memBytes) : null, d.vm.virtType?.toUpperCase()].filter(Boolean).join(' · ')}</span>}
          {d?.vm?.node && (
            <span className={line}>
              on {PLATFORM[d.vm.platform ?? ''] ?? 'node'} {d.vm.node}
              {d.vm.nodeDeviceId && staff ? (
                <>
                  {' '}
                  (
                  <Link to={`/hardware/${d.vm.nodeDeviceId}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
                    {d.vm.nodeDeviceName}
                  </Link>
                  )
                </>
              ) : null}
            </span>
          )}
          {a.source === 'hypervisor' && <span className={line}>from hypervisor sync</span>}
        </div>
      )}
      {d?.bmcOf && (
        <div className={a.deviceName || a.guestName ? 'mt-1' : undefined}>
          {BMC[d.bmcOf.type ?? ''] ?? 'BMC'} of{' '}
          <Link to={`/hardware/${d.bmcOf.deviceId}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
            {d.bmcOf.name}
          </Link>
          {(d.bmcOf.brand || d.bmcOf.model) && <span className={line}>{brandModel(d.bmcOf.brand, d.bmcOf.model)}</span>}
        </div>
      )}
      {staff && d?.observed && (d.observed.mac || d.observed.dhcpHostName) && (
        <div
          className={a.deviceName || a.guestName || d.bmcOf ? 'mt-1' : undefined}
          title={d.observed.router ? `Seen on ${d.observed.router}${d.observed.interface ? ` ${d.observed.interface}` : ''}${d.observed.seenAt ? `, ${relativeTime(d.observed.seenAt)}` : ''}` : undefined}
        >
          {d.observed.dhcpHostName && (
            <span className="block">
              {d.observed.dhcpHostName} <span className="text-[12px] text-ink-3">(DHCP)</span>
            </span>
          )}
          {d.observed.mac && (
            <span className={line}>
              <span className="font-mono">{d.observed.mac}</span>
              {d.observed.vendor ? ` · ${d.observed.vendor}` : ''}
            </span>
          )}
          {d.observed.router && (
            <span className={line}>
              seen on {d.observed.router}
              {d.observed.interface ? ` ${d.observed.interface}` : ''}
              {d.observed.seenAt ? `, ${relativeTime(d.observed.seenAt)}` : ''}
            </span>
          )}
        </div>
      )}
      {ptr && (
        <span className={line} title="Reverse DNS (PTR)">
          rDNS {ptr}
        </span>
      )}
      {!a.deviceName && !a.guestName && !d?.bmcOf && !(staff && d?.observed && (d.observed.mac || d.observed.dhcpHostName)) && !ptr && <span className="text-ink-3">—</span>}
    </div>
  );
}
