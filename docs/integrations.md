# Integration plan

No device or third-party integration is implemented in Phase 1. This plan fixes the adapter shape now so that each phase adds adapters without changing the core.

## Adapter contract

Every integration is a TypeScript adapter behind a capability interface, run **only inside `cdcim-worker`**:

```ts
interface DeviceAdapter {
  readonly kind: 'snmp' | 'redfish' | 'ipmi' | 'routeros' | 'fortigate' | 'cisco-nxapi' | 'proxmox' | 'virtualizor';
  testConnection(target, credential, opts: { timeoutMs; retries }): Promise<ConnectionResult>;
  detectCapabilities(target, credential): Promise<Capabilities>;   // stored per device
  // read-only collectors (monitoring)
  collectInterfaces?(…): Promise<InterfaceSnapshot[]>;
  collectCounters?(…): Promise<CounterSample[]>;
  collectPower?(…): Promise<PowerReading | null>;
  collectInventory?(…): Promise<InventorySnapshot>;
}

interface ControlAdapter {                 // separate module, separate permission
  powerAction?(…, action: 'on'|'graceful_shutdown'|'force_off'|'reboot'|'cycle'): Promise<ActionResult>;
  setBootDevice?(…): Promise<ActionResult>;
  consoleUrl?(…): Promise<string>;
}
```

Rules:

- **Capabilities are detected, never assumed.** The UI offers only operations that are present in the device's stored capabilities.
- **Monitoring adapters are read-only.** Control adapters live in a separate module, require `hardware.control` or `network.config`, need a confirmation step, are audited, and never run automatically from an alert.
- Credentials are decrypted inside the worker just before use and never logged, returned or put on a queue in plaintext. Jobs carry only a credential id.
- Every call has a timeout, bounded retries with exponential backoff and jitter, and per-device concurrency of 1 for SNMP so devices are not overloaded.
- A **simulator** implementation exists for every adapter. It drives the tests (counter wrap, reset, speed change, timeouts) and gives development a safe target. Simulated data is labelled as such in the UI.

## Planned adapters and how they collect

| Target | Protocol | Collects | Control (separate) | Phase |
|---|---|---|---|---|
| Any SNMP device (MikroTik, Cisco, FortiGate, others) | SNMP v2c / **v3 authPriv preferred** | IF-MIB `ifTable` + `ifXTable` (`ifName`, `ifDescr`, `ifAlias`, `ifHighSpeed`, `ifHCIn/OutOctets`, HC packet counters, errors, discards, `ifOperStatus`, `ifAdminStatus`, `ifLastChange`), `sysUpTime`, LLDP-MIB neighbors | none | 3–4 |
| MikroTik CCR2004/CCR2116 | RouterOS REST API (v7) + SNMP | interfaces, BGP sessions, routes summary, resources, logs. Power only where the model exposes it (to be verified on hardware) | config changes behind preview, apply and rollback (later) | 3–4 |
| Cisco Nexus 9372TX | NX-API (JSON-RPC) + SNMP | interfaces, LLDP/CDP, environment and power-supply sensors (`show environment power`) | later | 3–5 |
| Cisco 4500-X / 2960-X class | SNMP (+ SSH read-only show commands where needed) | interfaces, CDP, `CISCO-ENTITY-SENSOR-MIB` where exposed | later | 3–5 |
| FortiGate 40F | FortiOS REST API (read-only token) + SNMP | interfaces, system resources, routes, BGP; small appliances may not report watts | later | 3–4 |
| Dell PowerEdge R630/R640 (iDRAC 8/9) | **Redfish** (`/redfish/v1/Chassis/*/Power` → `PowerControl.PowerConsumedWatts`), IPMI fallback (`DCMI power reading`) | inventory, sensors, health, firmware, measured watts | power on/off/cycle, boot device, virtual console URL | 2, 5, 6 |
| HPE iLO / generic BMC | Redfish, IPMI | same as above where supported | same | 5–6 |
| PDU (optional) | SNMP vendor MIBs | per-outlet watts, the preferred measured source when mapped | none | 5 |
| Proxmox VE | REST API with a least-privilege API token (`PVEAuditor` for sync, a separate role for actions) | nodes, VMs, state, resources, storage, node power via `/nodes/{node}/status` | VM start, stop, reboot (permissioned) | 6 |
| Virtualizor | Admin API (key + pass) | servers, VPS, IPs, plans, status | suspend, unsuspend, power (permissioned) | 6 |
| WHMCS | Server-module package (PHP) that calls the Crapplet DCIM API; DCIM receives HMAC-signed webhooks | client and product mapping, orders, lifecycle, usage push | provision, suspend, terminate via idempotent jobs | 8 |
| Notifications | SMTP, Telegram Bot API, Slack webhooks, generic signed webhooks | none | none | 4 and 8 |

## What the reference platforms informed

- **EasyDCIM:** server matching by location, model and parts on order acceptance; unattended OS installs with post-install scripts; network auto-discovery over SNMP or Redfish; traffic aggregation across interfaces; usage billing by total transfer or 95th percentile; alerting through email, webhook, Slack and Telegram. These map to Phases 4, 6 and 8 here. The 95th-percentile calculation is planned as a report over the 5-minute aggregates.
- **NetBox / Nautobot:** separating device type from device (component templates copied onto instances), first-class interfaces and MAC addresses, validated cable endpoints, and a strict source-of-truth stance. Phase 2's `device_models` and Phase 3's `interfaces` and `cables` follow this. Topology is drawn only from cables, LLDP/CDP observations and verified circuits, never inferred.
- **Device42 / Sunbird:** lifecycle tracking, rack capacity (space, power, weight) and power planning against contracted allocations.

No proprietary code, assets or branding are reused. Crapplet DCIM is an independent design.

## Verification policy

The compatibility matrix in [feature-matrix.md](feature-matrix.md) records, per adapter, whether it has been **tested against the simulator only** or **verified on real hardware** (with firmware version). Nothing is marked hardware-verified without a recorded test run.
