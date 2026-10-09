import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { NAV_SECTIONS } from '@crapplet/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime } from '../lib/format';
import type { Customer } from '../lib/types';
import { Chip, ErrorNote, Loading, PageHeader, Panel, Stat } from '../components/ui';

interface Overview {
  generatedAt: string;
  customers: { total: number; active: number; suspended: number; closed: number } | null;
  users: { staff: number; customer: number; disabled: number; staffWithoutMfa: number } | null;
  roles: number | null;
  activeSessions: number | null;
  audit: { events24h: number; failedLogins24h: number; denied24h: number } | null;
}

const PHASES = [
  { n: 1, name: 'Foundation', scope: 'Sign-in, roles, tenants, audit log' },
  { n: 2, name: 'Physical DCIM', scope: 'Datacenters, rooms, racks, hardware lifecycle' },
  { n: 3, name: 'Network and IPAM', scope: 'Devices, interfaces, VLANs, IPv4/IPv6' },
  { n: 4, name: 'Network monitoring', scope: 'Live per-port RX/TX and alerts' },
  { n: 5, name: 'Equipment power', scope: 'Measured and estimated watts, kWh, cost' },
  { n: 6, name: 'Provisioning', scope: 'OS installs, Proxmox, Virtualizor' },
  { n: 7, name: 'Colocation and portal', scope: 'Customer self-service, remote hands' },
  { n: 8, name: 'Billing and automation', scope: 'WHMCS, workflows, reports' },
  { n: 9, name: 'Production readiness', scope: 'Hardening, install validation, acceptance' },
];

function Roadmap() {
  const done = new Set(NAV_SECTIONS.filter((s) => s.status === 'available').map((s) => s.phase));
  const pending = new Set(NAV_SECTIONS.filter((s) => s.status === 'planned').map((s) => s.phase));
  return (
    <ol className="divide-y divide-rule">
      {PHASES.map((p) => {
        const live = done.has(p.n) && !pending.has(p.n);
        return (
          <li key={p.n} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-14 flex-none text-[12.5px] text-ink-3">Phase {p.n}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{p.name}</span>
              <span className="block truncate text-[12.5px] text-ink-3">{p.scope}</span>
            </span>
            {live ? <Chip tone="ok">Live</Chip> : <Chip>Not started</Chip>}
          </li>
        );
      })}
    </ol>
  );
}

function StaffOverview() {
  const { me, can } = useAuth();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/overview'), refetchInterval: 60_000 });
  const integrity = useQuery({
    queryKey: ['audit-integrity'],
    queryFn: () => api.get<{ ok: boolean; checked: number; brokenAtId: number | null } | null>('/overview/audit-integrity'),
    enabled: can('audit.read'),
  });
  const o = q.data;
  return (
    <>
      <PageHeader
        title="Overview"
        description={`${me!.organization.name}. Infrastructure figures such as rack occupancy, bandwidth and power appear here as each module goes live; nothing on this page is sample data.`}
      />
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {o && (
        <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-5">
            <Panel title="Customers and access">
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                {o.customers && <Stat label="Active customers" value={o.customers.active} note={`${o.customers.suspended} suspended, ${o.customers.closed} closed`} />}
                {o.users && <Stat label="Staff users" value={o.users.staff} note={o.users.disabled ? `${o.users.disabled} disabled` : 'Active accounts'} />}
                {o.users && <Stat label="Portal users" value={o.users.customer} note="Customer accounts" />}
                {o.activeSessions !== null && <Stat label="Signed-in sessions" value={o.activeSessions} note="Across all users" />}
              </dl>
              {o.users && o.users.staffWithoutMfa > 0 && (
                <p className="mt-4 rounded-md bg-warn-soft px-3 py-2 text-[13px] text-warn">
                  {o.users.staffWithoutMfa} staff account{o.users.staffWithoutMfa === 1 ? ' has' : 's have'} no two-step sign-in.{' '}
                  {can('settings.write') ? (
                    <Link to="/settings" className="font-medium underline">
                      Require it for all staff
                    </Link>
                  ) : (
                    'Ask an administrator to require it.'
                  )}
                </p>
              )}
            </Panel>
            {o.audit && (
              <Panel
                title="Security activity, last 24 hours"
                actions={
                  <Link to="/audit" className="text-[13px] text-accent hover:underline">
                    Open audit log
                  </Link>
                }
              >
                <dl className="grid grid-cols-3 gap-6">
                  <Stat label="Recorded events" value={o.audit.events24h} />
                  <Stat label="Failed sign-ins" value={o.audit.failedLogins24h} tone={o.audit.failedLogins24h > 20 ? 'warn' : undefined} />
                  <Stat label="Access denied" value={o.audit.denied24h} tone={o.audit.denied24h > 0 ? 'warn' : undefined} />
                </dl>
                {integrity.data && (
                  <p className={`mt-4 text-[13px] ${integrity.data.ok ? 'text-ok' : 'text-crit'}`}>
                    {integrity.data.ok
                      ? `Audit trail intact: all ${integrity.data.checked} records verified.`
                      : `Audit trail tampering detected at record #${integrity.data.brokenAtId}. Investigate immediately.`}
                  </p>
                )}
                <ErrorNote error={integrity.error} className="mt-3" />
              </Panel>
            )}
            <p className="text-[12.5px] text-ink-3">Updated {formatDateTime(o.generatedAt, me!.organization.timezone)}</p>
          </div>
          <Panel title="Build progress" flush>
            <Roadmap />
          </Panel>
        </div>
      )}
    </>
  );
}

function CustomerOverview() {
  const q = useQuery({ queryKey: ['my-customer'], queryFn: () => api.get<Customer>('/customers/me') });
  const c = q.data;
  return (
    <>
      <PageHeader title="Your account" description="Services, IP addresses, power and bandwidth for your account will be listed here as they become available in the portal." />
      {q.isLoading && <Loading />}
      <ErrorNote error={q.error} />
      {c && (
        <Panel title={c.name} actions={<Chip tone={c.status === 'active' ? 'ok' : 'warn'}>{c.status === 'active' ? 'Active' : c.status === 'suspended' ? 'Suspended' : 'Closed'}</Chip>}>
          <dl className="grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-[13px] text-ink-2">Account code</dt>
              <dd className="font-mono">{c.code}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-ink-2">Contact email</dt>
              <dd>{c.contactEmail ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-ink-2">Phone</dt>
              <dd>{c.phone ?? '—'}</dd>
            </div>
          </dl>
        </Panel>
      )}
    </>
  );
}

export function OverviewPage() {
  const { me } = useAuth();
  return me?.user.userType === 'customer' ? <CustomerOverview /> : <StaffOverview />;
}
