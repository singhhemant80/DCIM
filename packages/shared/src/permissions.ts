/**
 * Permission catalog. Permissions are `<resource>.<action>` strings.
 *
 * Rules:
 *  - `*.read` permissions never grant mutation.
 *  - Privileged infrastructure control (power, network config, provisioning
 *    execution) has its own `.control` / `.execute` permissions, separate from
 *    read-only monitoring, so a NOC viewer can never power-cycle a server.
 *  - Permissions flagged `staffOnly` can never be granted to a customer role,
 *    enforced both in role validation and at request time.
 */
export interface PermissionDef {
  key: string;
  label: string;
  group: string;
  staffOnly: boolean;
  /** Dangerous operations require explicit confirmation in the UI and are audited with elevated severity. */
  dangerous?: boolean;
}

const p = (key: string, label: string, group: string, staffOnly = true, dangerous = false): PermissionDef => ({
  key,
  label,
  group,
  staffOnly,
  dangerous,
});

export const PERMISSIONS = [
  // Platform administration
  p('users.read', 'View users', 'Administration'),
  p('users.write', 'Create and edit users', 'Administration'),
  p('users.sessions.revoke', "Revoke other users' sessions", 'Administration', true, true),
  p('roles.read', 'View roles', 'Administration'),
  p('roles.write', 'Create and edit roles', 'Administration', true, true),
  p('audit.read', 'View audit log', 'Administration'),
  p('settings.read', 'View system settings', 'Administration'),
  p('settings.write', 'Change system settings', 'Administration', true, true),
  p('apikeys.manage', 'Manage API credentials', 'Administration', true, true),

  // Customers / tenants
  p('customers.read', 'View customers', 'Customers'),
  p('customers.write', 'Create and edit customers', 'Customers'),

  // Physical DCIM (Phase 2)
  p('dcim.read', 'View datacenters, racks and devices', 'Physical DCIM', false),
  p('dcim.write', 'Edit datacenters, racks and devices', 'Physical DCIM'),

  // Network & IPAM (Phase 3–4)
  p('network.read', 'View network devices and interfaces', 'Network', false),
  p('network.write', 'Edit network inventory records', 'Network'),
  p('network.config', 'Push network configuration changes', 'Network', true, true),
  p('monitoring.read', 'View bandwidth and monitoring data', 'Monitoring', false),
  p('monitoring.configure', 'Configure polling, thresholds and credentials', 'Monitoring', true, true),
  p('alerts.manage', 'Acknowledge and manage alerts', 'Monitoring'),
  p('ipam.read', 'View IP prefixes and allocations', 'IPAM', false),
  p('ipam.write', 'Allocate and release IP addresses', 'IPAM'),

  // Power (Phase 5)
  p('power.read', 'View equipment power consumption', 'Power', false),
  p('power.configure', 'Configure power estimates and tariffs', 'Power'),

  // Hardware control (Phase 2/6) — customer-grantable only for own devices
  p('hardware.control', 'Power control and remote console', 'Hardware', false, true),

  // Provisioning (Phase 6)
  p('provisioning.read', 'View provisioning jobs', 'Provisioning'),
  p('provisioning.execute', 'Run provisioning jobs', 'Provisioning', true, true),

  // Services, colocation, tickets (Phase 7–8)
  p('services.read', 'View services and orders', 'Services', false),
  p('services.write', 'Manage services and orders', 'Services'),
  p('tickets.read', 'View tickets and remote-hands requests', 'Support', false),
  p('tickets.write', 'Create and update tickets', 'Support', false),
  p('billing.manage', 'Manage billing integrations', 'Billing', true, true),
  p('reports.read', 'View and export reports', 'Reports', false),
  p('workflows.manage', 'Manage automation workflows', 'Automation', true, true),
] as const satisfies readonly PermissionDef[];

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const PERMISSION_KEYS: readonly Permission[] = PERMISSIONS.map((x) => x.key);

const permissionIndex = new Map<string, PermissionDef>(PERMISSIONS.map((x) => [x.key, x]));

export function isPermission(value: string): value is Permission {
  return permissionIndex.has(value);
}

export function getPermission(key: string): PermissionDef | undefined {
  return permissionIndex.get(key);
}

/** Returns the permissions in `perms` that may not be given to a customer-scoped role. */
export function staffOnlyViolations(perms: readonly string[]): string[] {
  return perms.filter((k) => permissionIndex.get(k)?.staffOnly !== false);
}
