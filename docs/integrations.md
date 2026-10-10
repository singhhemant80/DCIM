# Integration plan

Phase 3 implements the first read-only collectors: SNMP v2c/v3, MikroTik RouterOS REST, Fortinet FortiOS REST and Cisco NX-API. They run only in `cdcim-worker` (`apps/api/src/worker/adapters`), are tested against simulators (`apps/api/test/simulators`), and have not yet been verified on real hardware. See the compatibility matrix in [feature-matrix.md](feature-matrix.md).

## Implemented collectors (Phase 3)

Each adapter implements `test()` (a cheap identity read) and `discover()`, returning a `DiscoveryResult`: facts (name, vendor, model, serial, OS, uptime), interfaces (kind, MAC, MTU, speed, admin/oper state, addresses, LAG), neighbors (LLDP/CDP/MNDP) and BGP sessions, plus warnings for optional sections the device didn't answer. Missing optional data is a warning, never a failure.

Account to create on each device (read-only):

| Platform | What to configure |
|---|---|
| Any SNMP device | SNMP v3 user with authPriv (preferred) or a v2c community, read-only view, ACL limited to the DCIM worker's address |
| MikroTik RouterOS 7 | `www-ssl` service enabled; a user in a group with only the `read` and `rest-api` policies |
| FortiGate | REST API administrator with a read-only access profile and trusted host set to the worker; use its token |
| Cisco Nexus (NX-OS) | `feature nxapi`; a user with the `network-operator` role. `feature lldp` (and optionally `cdp`) for neighbor data |

Also implemented:
- **MikroTik RouterOS API** (`api` / `api-ssl` services, the binary protocol on ports 8728/8729 by default): a minimal client that can send only `/login` and `…/print`, then the same parser as the REST collector. Use it on routers where the REST API (www-ssl) is not enabled. The user's group needs the `read` and `api` policies.
- **DNS publishing** from IPAM to PowerDNS (HTTP API, `X-API-Key`) or Cloudflare (API token): A/AAAA in forward zones, PTR in reverse zones. Records DCIM creates are marked (PowerDNS comment account, Cloudflare record comment, both including the organization id); anything else at the same name and type is reported as a conflict and left alone.

Known gaps: the SNMP collector reads BGP4-MIB, which covers IPv4 peers in the default VRF only; RouterOS `/routing/bgp/session` and NX-OS output cover more. Interface speeds from RouterOS come from the configured ethernet speed, not the negotiated rate. FortiOS returns no device uptime in the fields read.

## Counter collection for monitoring (Phase 4)

Each adapter also implements `counters()`, a lighter read used by the poller every interval:

| Adapter | Reads | Counter width | Uptime (reset detection) |
|---|---|---|---|
| SNMP v2c / v3 | `sysUpTime`; ifXTable `ifName`, `ifHCIn/OutOctets`, HC packet counters, `ifHighSpeed`; ifTable `ifDescr`, `ifSpeed`, `ifOperStatus`, errors, discards, and the 32-bit octet columns for ports without HC counters | 64-bit per port when present, else 32-bit (wraps handled) | `sysUpTime` (wraps after 497 days, which costs one sample) |
| MikroTik RouterOS REST / API | `/interface` (`rx-byte`, `tx-byte`, packets, errors, drops, `running`), `/system/resource` | 64-bit | `uptime` |
| FortiOS REST | `monitor/system/interface` (`rx_bytes`, `tx_bytes`, packets, errors, `link`, `speed`) | 64-bit | none reported; a counter going down is treated as a reset. Values above 2⁵³ lose precision in JSON |
| Cisco NX-API | `show version`, `show interface` (`eth_inbytes`, `eth_outbytes`, packets, errors, discards, `eth_bw`, `state`); SVIs without byte counters are skipped | 64-bit | `kern_uptm_*` |

Counters are matched to inventory ports by name (case-insensitive), with SNMP `ifIndex` as a fallback; ports the device reports that aren't in inventory are counted but not stored. RouterOS reports no negotiated speed in `/interface`, so utilization uses the inventory port speed.

Notification channels: SMTP (STARTTLS, implicit TLS or none, via nodemailer), signed JSON webhooks, Slack incoming webhooks and the Telegram Bot API `sendMessage`.

## Power collection (Phase 5)

Each adapter that can read power implements `power()`:

| Platform | Credential | Reads | Notes |
|---|---|---|---|
| Dell iDRAC 8/9, HPE iLO 5/6, Lenovo XClarity, Supermicro (Redfish) | `redfish` (read-only BMC user) | `GET /redfish/v1/Chassis` → each chassis → `Power` (`PowerControl[].PowerConsumedWatts`) or `EnvironmentMetrics` (`PowerWatts.Reading`) | iDRAC: enable Redfish (on by default on iDRAC 9) |
| Any BMC with IPMI 2.0 DCMI | `ipmi` (USER privilege) | `ipmitool -I lanplus … dcmi power reading` | Needs `ipmitool` on the worker host (the installer adds it); some BMCs need DCMI power reading activated |
| APC / Schneider metered-by-outlet PDUs | `snmp_v2c` / `snmp_v3` | PowerNet-MIB `rPDU2OutletMeteredStatusTable` (module, name, number, power W) and `rPDU2DeviceStatusPower` (hundredths of kW) | Daisy-chained units are numbered 2001, 2002… for unit 2 |
| MikroTik RouterOS 7 | `routeros_rest` / `routeros_api` | `/system/health` `power-consumption` | Only models with a power sensor report it; others return a clear error |
| Cisco Nexus | `nxapi` | `show environment power` total input draw, else the sum of the supplies' `actual_input` | |

A PDU's own total is stored (source `snmp`) and shown beside the rack's equipment load, never added to it.

## Control and provisioning (Phase 6)

| Platform | Credential | Operations | Notes |
|---|---|---|---|
| Redfish BMCs (iDRAC 9, iLO 5/6, XClarity, Supermicro) | control `redfish` (a role that can change power and boot: iDRAC "Operator", iLO "Virtual Power and Reset" + "Virtual Media") | `ComputerSystem.Reset` within the allowed values; Boot override `Once`/`Disabled` with `Cd`/`Pxe`; first CD/DVD virtual-media slot under `Managers/*/VirtualMedia`; `BootProgress.LastStateTime` for reset verification | Older firmware without Redfish virtual media is refused with a clear error; BMCs without `BootProgress` give "not verified" restarts |
| IPMI 2.0 | control `ipmi` (OPERATOR) | `chassis power …`, `chassis bootdev pxe/none`, `chassis bootparam get 5` | No virtual media; no ACPI restart |
| PXE / iPXE | — | Your DHCP server chainloads iPXE and points it at `http(s)://<CDCIM_PUBLIC_URL>/api/v1/boot/ipxe?mac=${net0/mac}` (an unknown MAC gets `exit`) | DCIM does not run DHCP or TFTP |
| Redfish virtual media + template | — | The ISO must fetch `…/api/v1/boot/config?mac=<mac>` (for example via a remastered `inst.ks=` or `ds=nocloud-net;s=` argument) | DCIM does not remaster ISOs |
| Proxmox VE | API token (`PVEAuditor`) + optional action token (`PVEVMUser` or `VM.PowerMgmt`) | Nodes, VMs and containers, status; start, stop, shutdown, reboot, suspend, resume | Templates are skipped. Reboots verified by uptime |
| Virtualizor | Admin API key and password | Servers and VPSes; start, stop (graceful), power off, restart when enabled | Admin keys can't be limited, so actions are off until enabled; suspend/unsuspend (billing) not offered. Mapping from the API docs, not yet run against a live panel |

## Original adapter plan

This plan fixed the adapter shape so that each phase adds adapters without changing the core.

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
