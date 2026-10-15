import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { formatBitRate, IP_STATUS_LABELS, type IpStatus } from '@crapplet/shared';
import { api } from '../lib/api';
import type { PortRateT } from '../lib/monitoring';
import { Chip, Panel, Table } from './ui';

interface AddrT {
  id: string;
  address: string;
  prefix: string | null;
  status: IpStatus;
  role: string | null;
  dnsName: string | null;
  interfaceName: string | null;
}

/** The IP addresses assigned to this device in IPAM (customers: their own). */
export function DeviceAddressesPanel({ deviceId }: { deviceId: string }) {
  const q = useQuery({ queryKey: ['ipam', 'addresses', 'device', deviceId], queryFn: () => api.get<{ items: AddrT[] }>(`/ipam/addresses?deviceId=${deviceId}&pageSize=200`) });
  const items = q.data?.items ?? [];
  if (q.isLoading || !items.length) return null;
  return (
    <Panel title={`IP addresses (${items.length})`} flush>
      <Table label="IP addresses">
        <thead>
          <tr>
            <th>Address</th>
            <th>Subnet</th>
            <th>Name</th>
            <th>Port</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className="font-mono text-[12.5px]">{a.address}</td>
              <td className="font-mono text-[12.5px] text-ink-2">{a.prefix ?? '—'}</td>
              <td>{a.dnsName ?? <span className="text-ink-3">—</span>}</td>
              <td>{a.interfaceName ?? <span className="text-ink-3">—</span>}</td>
              <td>
                <Chip tone={a.status === 'allocated' ? 'ok' : 'neutral'}>{IP_STATUS_LABELS[a.status] ?? a.status}</Chip>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

/**
 * Network ports that carry this device's traffic: its own monitored ports and
 * the switch or router ports cabled to it, with the latest measured rates.
 */
export function DevicePortsPanel({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ['monitoring', 'ports', 'serving', deviceId],
    queryFn: () => api.get<{ items: (PortRateT & { peer: string | null })[] }>(`/monitoring/ports?servingDeviceId=${deviceId}&pageSize=50&sort=name`),
    refetchInterval: 30_000,
  });
  const items = q.data?.items ?? [];
  if (q.isLoading || !items.length) return null;
  return (
    <Panel
      title="Network ports and traffic"
      flush
      actions={
        <Link to="/network-monitoring" className="text-[13px] text-accent hover:underline">
          History
        </Link>
      }
    >
      <Table label="Network ports">
        <thead>
          <tr>
            <th>Port</th>
            <th>Connected to</th>
            <th className="text-right">Speed</th>
            <th className="text-right">In now</th>
            <th className="text-right">Out now</th>
            <th>Link</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.interfaceId}>
              <td>
                <span className="font-mono text-[12.5px]">{p.name}</span>
                <span className="block text-[12px] text-ink-3">{p.deviceName}</span>
              </td>
              <td className="text-[13px]">{p.peer ?? <span className="text-ink-3">—</span>}</td>
              <td className="text-right">{p.speedBps ? formatBitRate(p.speedBps) : '—'}</td>
              <td className="text-right">{p.fresh && p.inBps !== null ? formatBitRate(p.inBps) : <span className="text-ink-3">no data</span>}</td>
              <td className="text-right">{p.fresh && p.outBps !== null ? formatBitRate(p.outBps) : <span className="text-ink-3">no data</span>}</td>
              <td>{p.operUp === null ? <span className="text-ink-3">—</span> : p.operUp ? <Chip tone="ok">Up</Chip> : <Chip tone="crit">Down</Chip>}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="px-4 py-2 text-[12px] text-ink-3">Measured on the ports every polling interval; a switch port's "in" is traffic coming from this server.</p>
    </Panel>
  );
}
