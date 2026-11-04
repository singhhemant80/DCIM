import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CATEGORY_LABELS, type DeviceCategory } from '@crapplet/shared';
import { api } from '../lib/api';
import { ErrorNote, Loading, Panel, cx } from './ui';

/**
 * How many servers, routers, switches, firewalls, PDUs… you have, per type,
 * in service and not yet (planned, received, in stock, reserved), plus the
 * virtual machines from the hypervisor syncs. Live counts, refreshed every
 * 15 seconds; each tile opens the matching device list.
 */
interface TypesT {
  deviceTypes: { category: DeviceCategory; total: number; inService: number; notInService: number }[];
  virtualMachines: { total: number; running: number; hosts: number };
  counts: { devices: number };
}

const PLURAL: Partial<Record<DeviceCategory, string>> = {
  server: 'Servers',
  gpu_server: 'GPU servers',
  storage: 'Storage',
  switch: 'Switches',
  router: 'Routers',
  firewall: 'Firewalls',
  load_balancer: 'Load balancers',
  optical: 'Optical / DWDM',
  pdu: 'PDUs',
  patch_panel: 'Patch panels',
  kvm: 'KVM / consoles',
  ups: 'UPS',
  other: 'Other',
};

/** Small line icons, one per kind of equipment. */
function TypeIcon({ category }: { category: DeviceCategory | 'vm' }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const body = (() => {
    switch (category) {
      case 'server':
      case 'gpu_server':
      case 'storage':
        return (
          <>
            <rect x="3" y="4" width="18" height="7" rx="1.5" {...p} />
            <rect x="3" y="13" width="18" height="7" rx="1.5" {...p} />
            <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" {...p} />
          </>
        );
      case 'switch':
        return (
          <>
            <rect x="2.5" y="8" width="19" height="8" rx="1.5" {...p} />
            <path d="M6 12h1M9 12h1M12 12h1M15 12h1M18 12h1" {...p} />
          </>
        );
      case 'router':
        return (
          <>
            <circle cx="12" cy="12" r="8.5" {...p} />
            <path d="M8 9l-2 3 2 3M16 9l2 3-2 3M6 12h12" {...p} />
          </>
        );
      case 'firewall':
        return <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z M9 12l2 2 4-4" {...p} />;
      case 'pdu':
      case 'ups':
        return <path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" {...p} />;
      case 'vm':
        return (
          <>
            <rect x="3" y="4" width="18" height="12" rx="1.5" {...p} />
            <path d="M8 20h8M12 16v4M9 8.5l3 2 3-2M12 10.5v3" {...p} />
          </>
        );
      default:
        return (
          <>
            <rect x="4" y="4" width="16" height="16" rx="2" {...p} />
            <path d="M8 9h8M8 13h5" {...p} />
          </>
        );
    }
  })();
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      {body}
    </svg>
  );
}

function Tile({ to, icon, label, total, note, tone }: { to: string; icon: DeviceCategory | 'vm'; label: string; total: number; note: string; tone?: string }) {
  return (
    <Link to={to} className="group flex items-start gap-3 rounded-xl border border-rule bg-panel/60 px-3.5 py-3 transition hover:border-accent/50 hover:bg-panel">
      <span className={cx('mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent', tone)}>
        <TypeIcon category={icon} />
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] text-ink-2 group-hover:text-ink">{label}</span>
        <span className="block text-[24px] leading-tight font-semibold tabular-nums">{total.toLocaleString('en-IN')}</span>
        <span className="block text-[12px] text-ink-3">{note}</span>
      </span>
    </Link>
  );
}

export function DeviceTypesPanel({ title = 'Devices by type' }: { title?: string }) {
  const q = useQuery({ queryKey: ['dcim', 'summary'], queryFn: () => api.get<TypesT>('/dcim/summary'), refetchInterval: 15_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data!;
  const vm = d.virtualMachines;
  return (
    <Panel title={title} actions={<span className="text-[12.5px] text-ink-3">{d.counts.devices.toLocaleString('en-IN')} devices · updates every 15 s</span>}>
      {d.deviceTypes.length === 0 && vm.total === 0 ? (
        <p className="text-[13px] text-ink-2">
          No devices yet.{' '}
          <Link to="/hardware" className="text-accent hover:underline">
            Add your first server
          </Link>
          .
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
          {d.deviceTypes.map((t) => (
            <Tile
              key={t.category}
              to={`/hardware?category=${t.category}`}
              icon={t.category}
              label={PLURAL[t.category] ?? CATEGORY_LABELS[t.category] ?? t.category}
              total={t.total}
              note={t.notInService ? `${t.inService} in service · ${t.notInService} not yet` : `${t.inService} in service`}
            />
          ))}
          {vm.total > 0 && <Tile to="/integrations/virtualizor" icon="vm" label="Virtual machines" total={vm.total} note={`${vm.running} running · on ${vm.hosts} node${vm.hosts === 1 ? '' : 's'}`} tone="bg-ok/10 text-ok" />}
        </div>
      )}
    </Panel>
  );
}
