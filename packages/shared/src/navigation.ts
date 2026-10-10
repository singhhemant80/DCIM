import type { Permission } from './permissions';

/**
 * Implementation status for each top-level section. This is the single source
 * of truth used by the UI (to label sections honestly) and by the
 * feature-completion matrix. A section is only `available` when it has real
 * backend logic, persistence, access control and tests behind it.
 */
export type SectionStatus = 'available' | 'planned';

export interface NavSection {
  key: string;
  label: string;
  path: string;
  group: 'Overview' | 'Physical' | 'Network' | 'Power' | 'Services' | 'Operations' | 'Administration';
  /** Permission required to see the section. */
  permission?: Permission;
  status: SectionStatus;
  /** Roadmap phase that delivers this section. */
  phase: number;
  /** Hidden from customer-portal users even if their role holds the permission (physical layout, admin). */
  staffOnly?: boolean;
  summary: string;
}

export const NAV_SECTIONS: readonly NavSection[] = [
  { key: 'overview', label: 'Overview', path: '/', group: 'Overview', status: 'available', phase: 1, summary: 'Operational dashboard: physical capacity now; network and power metrics arrive with Phases 4–5.' },
  { key: 'datacenters', label: 'Datacenters', path: '/datacenters', group: 'Physical', permission: 'dcim.read', status: 'available', phase: 2, staffOnly: true, summary: 'Datacenter sites and their hierarchy.' },
  { key: 'rooms', label: 'Buildings & Rooms', path: '/rooms', group: 'Physical', permission: 'dcim.read', status: 'available', phase: 2, staffOnly: true, summary: 'Buildings, rooms and rows inside each datacenter.' },
  { key: 'floor-plans', label: 'Floor Plans', path: '/floor-plans', group: 'Physical', permission: 'dcim.read', status: 'available', phase: 2, staffOnly: true, summary: 'Room layouts with rack positions.' },
  { key: 'racks', label: 'Racks & Elevation', path: '/racks', group: 'Physical', permission: 'dcim.read', status: 'available', phase: 2, staffOnly: true, summary: 'Rack elevations with validated equipment placement.' },
  { key: 'hardware', label: 'Servers & Hardware', path: '/hardware', group: 'Physical', permission: 'dcim.read', status: 'available', phase: 2, summary: 'Asset inventory, lifecycle and spare parts.' },
  { key: 'network', label: 'Network Infrastructure', path: '/network', group: 'Network', permission: 'network.read', status: 'available', phase: 3, staffOnly: true, summary: 'Routers, switches, firewalls, ports, cabling, VLANs, VRFs, circuits, topology and read-only discovery.' },
  { key: 'network-monitoring', label: 'Network Monitoring', path: '/network-monitoring', group: 'Network', permission: 'monitoring.read', status: 'available', phase: 4, summary: 'Live per-port RX/TX bandwidth, utilization, history and 95th percentile.' },
  { key: 'ipam', label: 'IP Address Management', path: '/ipam', group: 'Network', permission: 'ipam.read', status: 'available', phase: 3, summary: 'IPv4/IPv6 prefixes, pools and allocations.' },
  { key: 'power', label: 'Power Consumption', path: '/power', group: 'Power', permission: 'power.read', status: 'planned', phase: 5, summary: 'Measured and estimated equipment power, kWh and cost.' },
  { key: 'colocation', label: 'Colocation', path: '/colocation', group: 'Services', permission: 'services.read', status: 'planned', phase: 7, summary: 'Customer-owned equipment, rack allocations and cross-connects.' },
  { key: 'provisioning', label: 'Server Provisioning', path: '/provisioning', group: 'Services', permission: 'provisioning.read', status: 'planned', phase: 6, summary: 'Provisioning job state machine and history.' },
  { key: 'images', label: 'OS & Images', path: '/images', group: 'Services', permission: 'provisioning.read', status: 'planned', phase: 6, summary: 'ISO library, templates and checksums.' },
  { key: 'proxmox', label: 'Proxmox', path: '/integrations/proxmox', group: 'Services', permission: 'services.read', status: 'planned', phase: 6, summary: 'Proxmox VE node and VM synchronization.' },
  { key: 'virtualizor', label: 'Virtualizor', path: '/integrations/virtualizor', group: 'Services', permission: 'services.read', status: 'planned', phase: 6, summary: 'Virtualizor service synchronization.' },
  { key: 'customers', label: 'Customers & Tenants', path: '/customers', group: 'Services', permission: 'customers.read', status: 'available', phase: 1, summary: 'Customer accounts that own services and portal users.' },
  { key: 'orders', label: 'Orders & Services', path: '/services', group: 'Services', permission: 'services.read', status: 'planned', phase: 7, summary: 'Customer services and their lifecycle.' },
  { key: 'alerts', label: 'Monitoring & Alerts', path: '/alerts', group: 'Operations', permission: 'monitoring.read', status: 'available', phase: 4, staffOnly: true, summary: 'Alert rules, active alerts, maintenance windows, notifications and polling health.' },
  { key: 'maintenance', label: 'Maintenance & Incidents', path: '/maintenance', group: 'Operations', permission: 'tickets.read', status: 'planned', phase: 8, summary: 'Maintenance windows and incident records.' },
  { key: 'tickets', label: 'Remote Hands & Tickets', path: '/tickets', group: 'Operations', permission: 'tickets.read', status: 'planned', phase: 7, summary: 'Support tickets and remote-hands tasks.' },
  { key: 'workflows', label: 'Automation & Workflows', path: '/workflows', group: 'Operations', permission: 'workflows.manage', status: 'planned', phase: 8, summary: 'Triggered and scheduled workflows with approvals.' },
  { key: 'reports', label: 'Reports & Analytics', path: '/reports', group: 'Operations', permission: 'reports.read', status: 'planned', phase: 8, summary: 'Inventory, bandwidth, power and capacity reports.' },
  { key: 'billing', label: 'Billing Integrations', path: '/billing', group: 'Administration', permission: 'billing.manage', status: 'planned', phase: 8, summary: 'WHMCS mapping, webhooks and reconciliation.' },
  { key: 'api', label: 'API & Integrations', path: '/api-integrations', group: 'Administration', permission: 'apikeys.manage', status: 'planned', phase: 8, summary: 'API credentials, webhooks and integration health.' },
  { key: 'users', label: 'Users & Permissions', path: '/users', group: 'Administration', permission: 'users.read', status: 'available', phase: 1, summary: 'Staff and customer users, roles and sessions.' },
  { key: 'audit', label: 'Audit Logs', path: '/audit', group: 'Administration', permission: 'audit.read', status: 'available', phase: 1, summary: 'Tamper-evident record of every privileged action.' },
  { key: 'settings', label: 'System Settings', path: '/settings', group: 'Administration', permission: 'settings.read', status: 'available', phase: 1, summary: 'Organization and security settings.' },
];
