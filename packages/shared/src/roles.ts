import { PERMISSION_KEYS, type Permission } from './permissions';

export type RoleScope = 'staff' | 'customer';

export interface SystemRoleDef {
  key: string;
  name: string;
  description: string;
  scope: RoleScope;
  permissions: readonly Permission[];
}

const readAll: Permission[] = PERMISSION_KEYS.filter((k) => k.endsWith('.read'));

/**
 * Built-in roles seeded into every organization. They are marked `system` in
 * the database and cannot be edited or deleted; operators create custom roles
 * for anything else.
 */
export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'super_admin',
    name: 'Super Administrator',
    description: 'Unrestricted access to the organization, including security settings.',
    scope: 'staff',
    permissions: PERMISSION_KEYS,
  },
  {
    key: 'operations_admin',
    name: 'Operations Administrator',
    description: 'Manages infrastructure, customers and provisioning. Cannot change roles, API keys or system settings.',
    scope: 'staff',
    permissions: PERMISSION_KEYS.filter(
      (k) => !['roles.write', 'settings.write', 'apikeys.manage', 'billing.manage'].includes(k),
    ),
  },
  {
    key: 'noc_engineer',
    name: 'NOC Engineer',
    description: 'Read-only infrastructure visibility plus alert handling. No control operations.',
    scope: 'staff',
    permissions: [...readAll.filter((k) => !['users.read', 'roles.read', 'settings.read'].includes(k)), 'alerts.manage', 'tickets.write'],
  },
  {
    key: 'dc_technician',
    name: 'Datacenter Technician',
    description: 'Maintains physical inventory and handles remote-hands tickets.',
    scope: 'staff',
    permissions: ['dcim.read', 'dcim.write', 'network.read', 'ipam.read', 'power.read', 'customers.read', 'tickets.read', 'tickets.write', 'monitoring.read'],
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description: 'Read-only access to everything including the audit log.',
    scope: 'staff',
    permissions: readAll,
  },
  {
    key: 'customer_admin',
    name: 'Customer Administrator',
    description: "Customer portal user who can control their own organization's services.",
    scope: 'customer',
    permissions: ['dcim.read', 'network.read', 'monitoring.read', 'ipam.read', 'power.read', 'hardware.control', 'services.read', 'tickets.read', 'tickets.write', 'reports.read'],
  },
  {
    key: 'customer_viewer',
    name: 'Customer Viewer',
    description: 'Customer portal user with read-only access to their own services.',
    scope: 'customer',
    permissions: ['dcim.read', 'network.read', 'monitoring.read', 'ipam.read', 'power.read', 'services.read', 'tickets.read'],
  },
];
