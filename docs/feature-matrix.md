# Feature-completion matrix

Updated at the end of every phase. **Done** means it has frontend, backend logic, persistence, access control, error handling and automated tests. Anything less is listed as Partial or Not started, with the reason.

Last updated: Phase 7, 10 October 2026.

## Navigation sections

| # | Section | Status | Phase | Notes |
|---|---|---|---|---|
| 1 | Overview Dashboard | **Done** | 1 → 5 | Live counts: physical capacity, devices by state and category, warranty expiry, low spare parts, network devices, cables, circuits and committed transit, IPv4 utilization and nearly-full subnets, customers, users, security activity, audit integrity; measured bandwidth now, last 24 h with 95th percentile, alerts firing (Phase 4); equipment power now (measured / estimated / unknown) and energy over 24 h (Phase 5). |
| 2 | Datacenters | **Done** | 2 | Create, edit, delete (only when empty), counts per site |
| 3 | Buildings and Rooms | **Done** | 2 | Buildings, rooms (floor size), rows; deletes refused while in use |
| 4 | Floor Plans | **Done** | 2 | Tile grid per room; drag or click to position racks; fill colour by occupancy |
| 5 | Racks and Rack Elevation | **Done** | 2 | Front/rear elevation, drag-and-drop placement, reservations, dedicated racks, rack relocation, history |
| 6 | Servers and Hardware Inventory | **Done** | 2 | Devices with full spec, lifecycle with configurable rules, history, CSV import/export, bulk edit, QR labels, models, spare parts. Attachments (S3) pending, see below |
| 7 | Network Infrastructure | **Done** | 3 | Network devices, physical and logical interfaces (LAG, VLAN, bridge, tunnel, loopback), cables, VLANs, VRFs, providers and circuits with history, topology, write-only access credentials, read-only discovery with preview and apply. Staff only. Live traffic is Phase 4 |
| 8 | Network Monitoring | **Done** | 4 | Live per-port RX/TX, utilization, errors/discards and link state measured from counters (SNMP, RouterOS REST/API, FortiOS, NX-API); SSE live updates; history charts (1 h–30 d) with 95th percentile; totals over uplink ports with LAG de-duplication; live rates on the device page; customers see their own ports and the ports cabled to them. Simulator-tested only |
| 9 | IP Address Management | **Done** | 3 | IPv4/IPv6 prefixes with hierarchy and utilization, VRFs, pools, atomic next-free allocation, reservations with expiry, release with history, conflict report, CSV import/export. Customers see their own subnets and addresses read-only |
| 10 | Power Consumption | **Done** | 5 | Measured power from Redfish and IPMI DCMI BMCs, APC metered PDU outlets (SNMP), RouterOS `/system/health` and NX-OS supply input; per-device estimates (admin figure, else model typical draw); one source per instant by priority; hourly energy with measured, estimated and unknown kept apart; tariffs per datacenter with validity dates; device, rack (budget %), datacenter, category and customer views; CSV export; customers see their own equipment without cost. Simulator-tested only |
| 11 | Colocation Management | **Done** | 7 | Rack space allocations (full, half, quarter, custom units) held by rack reservations, contracted power with feeds/breaker/voltage, measured vs. estimated use per allocation (each device counted once), cross-connect requests and lifecycle, shipments (receiving, storage, delivery), site visits (approval, check-in/out); customer portal overview with space, power against contract, bandwidth and open requests |
| 12 | Server Provisioning | **Done** | 6 | Job engine (queued → running ⇄ waiting → verifying → completed; failed, cancelled, recovery) with leases, retries, idempotency keys, one active job per server/VM, deadlines and cancellation with cleanup; power actions through a separate BMC control credential (Redfish or IPMI) with typed confirmation; OS installation by Redfish virtual media or PXE/iPXE with unattended-install templates, installer callback or TCP verification; operator decisions for interrupted steps; job history with every step and log line. Simulator-tested only |
| 13 | Operating Systems and Images | **Done** | 6 | ISO and kernel/initrd library with SHA-256 per file, verification by download (required before use), kickstart / preseed / autoinstall templates with checked variables. Staff only |
| 14 | Proxmox Integration | **Done** | 6 | Read-only token sync of nodes and VMs (missing ones kept and marked), operator-mapped node → server links, VM assignment to customers, VM actions only with a second token, verified by the hypervisor's state (reboot by uptime). Simulator-tested only |
| 15 | Virtualizor Integration | **Done** | 6 | Server and VPS sync, customer assignment, start / shut down / power off / reboot only after an explicit opt-in; suspend/resume not offered (administrative in Virtualizor). Simulator-tested only; response shapes from the API documentation |
| 16 | Customers and Tenants | **Done** | 1 | List, search, filter, create and edit; closing a customer revokes its sessions |
| 17 | Orders and Services | **Done** | 7 | Services per customer (colocation, dedicated server, VPS, transit, cross-connect, remote-hands plan) with billing reference, linked rack space/server/VM/cross-connects, lifecycle pending → active ⇄ suspended → terminated (or cancelled) with history. Status is a record only; billing sync is Phase 8 |
| 18 | Monitoring and Alerts | **Done** | 4 | Alert rules (utilization, traffic, errors, discards, port down, device unreachable) with duration and consecutive-sample logic, acknowledgement, maintenance windows with suppression, notifications by email, signed webhook, Slack and Telegram with retries, polling configuration and health, retention settings. Staff only |
| 19 | Maintenance and Incidents | Not started | 8 | |
| 20 | Remote Hands and Support Tickets | **Done** | 7 | Tickets per customer or internal, sequential numbers, priorities, assignment, conversation with staff-only internal notes, customer resolve/close/reopen, remote-hands authorized minutes and logged time (billable shown to the customer; over-authorization flagged). No email notifications or attachments yet |
| 21 | Automation and Workflows | Not started | 8 | |
| 22 | Reports and Analytics | Not started | 8 | |
| 23 | Billing Integrations | Not started | 8 | |
| 24 | API and Integration Management | Not started | 8 | |
| 25 | Users and Permissions | **Done** | 1 | Users, custom roles, sessions, MFA reset |
| 26 | Audit Logs | **Done** | 1 | Filter, details, integrity verification |
| 27 | System Settings | **Done** | 1 | Organization, timezone, currency, session and MFA policy |

The web app's navigation reads this status from `@crapplet/shared` (`NAV_SECTIONS`). A test fails if a section is marked available without a real page, or the reverse.

## Phase 1 capabilities

| Capability | Status | Tests |
|---|---|---|
| Monorepo, TypeScript strict, shared package | Done | builds and typechecks |
| PostgreSQL schema and migrations | Done | every e2e file migrates a fresh database |
| Email and password sign-in (Argon2id), lockout, enumeration resistance | Done | `auth.e2e` |
| Sessions: HttpOnly cookie, hashed tokens, idle and absolute expiry, revocation | Done | `auth.e2e` |
| CSRF synchronizer token | Done | `auth.e2e` |
| TOTP MFA, replay protection, recovery codes, org-enforced enrollment, admin reset | Done | `auth.e2e` |
| RBAC with permission catalog, built-in and custom roles, no-escalation rule | Done | `rbac-tenancy.e2e`, `shared.test` |
| Tenant isolation (org + customer filters, 404 on foreign ids, staff-only fields) | Done | `rbac-tenancy.e2e`, `tenant-scope.test` |
| Fixes from independent security review (6 defects) | Done | `security-regressions.e2e` |
| Append-only, hash-chained audit log with verification | Done | `audit-platform.e2e`, `audit-hash.test` |
| Encrypted secrets with key rotation | Done | `secret-box.test` |
| Structured logging with secret redaction, request ids | Done | `audit-platform.e2e` (headers) |
| Health and readiness endpoints | Done | `audit-platform.e2e` |
| OpenAPI documentation | Done | `audit-platform.e2e` |
| Web app shell: responsive, light/dark/auto, keyboard focus, skip link | Done | manual screenshot review; `app.test` |
| Seed and admin bootstrap CLIs | Done | run manually during verification |
| Production install script and systemd units | **Partial** | Units and nginx config written; full installer and tested procedure are Phase 9 |
| API keys for machine clients | Not started | Phase 8 |
| Distributed rate limiting (Redis store) | Not started | Moved to Phase 9 (the supported install runs a single API process) |

## Phase 2 capabilities

| Capability (brief §7–8) | Status | Tests |
|---|---|---|
| Organization → datacenter → building → room → row → rack → device hierarchy | Done | `dcim.e2e` |
| Rack dimensions, U capacity, numbering direction, depth | Done | `dcim.e2e` |
| Placement validated in the database: no overlap per face (GiST exclusion), height and depth fit (triggers, row-locked) | Done | `dcim.e2e`, `dcim-regressions.e2e` (incl. concurrent placement and shrink races) |
| Full-depth vs half-depth mounting, multi-unit and 0U equipment | Done | `dcim.e2e`, `dcim-regressions.e2e` |
| Front and rear elevation with drag-and-drop placement | Done | browser drag test during verification |
| Rack reservations (customer or internal, expiry) and dedicated racks | Done | `dcim.e2e`, `dcim-regressions.e2e` |
| Rack relocation, device movement history, rack history | Done | `dcim.e2e` |
| Equipment ownership (company vs customer-owned) | Done | `dcim.e2e` |
| Device record: identity, CPU, RAM/DIMMs, disks/RAID, NICs/MACs, management interface, BIOS/BMC firmware, OS, purchase, warranty, EOL, notes, custom fields | Done | `dcim.e2e` |
| Lifecycle Planned → … → Retired with configurable transition rules and history | Done | `dcim.e2e` |
| Spare-parts inventory with atomic stock movements | Done | `dcim.e2e` (concurrent withdrawals) |
| CSV import (dry run against the DB) and export (formula-injection safe), bulk edit | Done | `dcim.e2e`, `dcim-regressions.e2e`, `csv.test` |
| Warranty reminders | Partial | Shown on the overview and filterable. Notification channels exist since Phase 4, but warranty reminders are not sent through them yet (Phase 8) |
| QR codes and printable labels | Done | `dcim.e2e` |
| Customer view of own equipment (no internal fields) | Done | `dcim.e2e` |
| Power and network connection records | Done | Network connections in Phase 3; PDU outlet → device mapping and power readings in Phase 5 |
| Environmental sensor associations | Not started | Needs the monitoring collectors (Phase 4) |
| Attachments (S3-compatible storage) | Not started | Planned with the object-storage integration; no files are stored yet |
| Inventory reconciliation against discovered hardware | Not started | Needs Redfish/SNMP discovery (Phases 3 and 6) |
| Independent review of Phase 2 (9 defects) | Done | All fixed; `dcim-regressions.e2e` |

## Phase 3 capabilities

| Capability (brief §9–10) | Status | Tests |
|---|---|---|
| Network device records (router, switch, firewall, load balancer, optical) with platform and role | Done | `network.e2e` |
| Interfaces: physical/management ports and logical interfaces (LAG, VLAN, bridge, tunnel, loopback, virtual); bulk creation from patterns (`ether[1-24]`) | Done | `network.e2e` |
| LAG membership and parent rules enforced in the database (same device, no nested LAGs, a cabled port stays physical) | Done | `network.e2e` |
| VLANs scoped per datacenter or global; access/trunk/all-tagged modes; untagged and tagged consistency; datacenter scope enforced | Done | `network.e2e` |
| Cables between two physical ports; one cable per port; exactly two ends (deferred DB constraint) | Done | `network.e2e` |
| VRFs with route distinguishers | Done | `network.e2e`, `ipam.e2e` |
| Providers and circuits (transit, peering, transport, cross-connect) with commit and port speed, termination port, change history | Done | `network.e2e` |
| Topology from documented cables, observed LLDP/CDP neighbors and circuits only; cables confirmed by a neighbor are marked; unknown neighbors shown as such | Done | `network.e2e`, `network-regressions.e2e` |
| Access credentials: SNMP v2c, SNMP v3 (auth/priv), RouterOS REST, FortiOS REST token, NX-API; encrypted, write-only, bound to device, kind and host | Done | `network.e2e`, `network-regressions.e2e` |
| Discovery worker (separate process, BullMQ): connection test and read-only collection of interfaces, addresses, LAG membership, LLDP/CDP, BGP sessions and device facts | Done | `network.e2e`, `adapters.e2e` (simulators) |
| Discovery preview and selective apply; never deletes ports; never writes to devices | Done | `network.e2e`, `network-regressions.e2e` |
| IPv4 and IPv6 prefixes, hierarchy, containers, pools, gateways, VLAN and datacenter links, customer assignment consistent across the hierarchy | Done | `ipam.e2e`, `network-regressions.e2e` |
| Next-free allocation (1–256 addresses) that is safe under concurrency | Done | `ipam.e2e` (20 parallel requests on a /28) |
| Specific assignment, reservation with expiry, update, release with retained history | Done | `ipam.e2e` |
| Conflict report (orphans, network/broadcast, customer mismatch, length mismatch, lapsed reservations) | Done | `ipam.e2e` |
| CSV import (dry run, per-row results) and export | Done | `ipam.e2e` |
| Customer IPAM view (own subnets and addresses, no infrastructure details) | Done | `ipam.e2e`, `network-regressions.e2e` |
| DNS publishing of A/AAAA/PTR records to PowerDNS (HTTP API) and Cloudflare; only records DCIM created are changed; per-name locking for shared (round-robin) names | Done | `dns.e2e` (PowerDNS and Cloudflare mocks) |
| Recording discovered addresses in IPAM from the discovery preview (selected addresses, optional subnet creation; existing IPAM rows are never re-assigned) | Done | `network-automation.e2e` |
| Scheduled discovery per access method (1–720 h), difference counts on each run, devices flagged when the latest discovery differs from inventory; never applied automatically | Done | `network-automation.e2e` |
| MikroTik RouterOS API (`api` / `api-ssl`) collector | Done | `network-automation.e2e` (protocol simulator) |
| SSH-based collection for platforms without an API | Not started | Not needed for the target hardware; SNMP covers Cisco IOS devices |
| Independent review of Phase 3 (7 confirmed defects + plausible items) | Done | All fixed; `network-regressions.e2e` |
| Independent review of the Phase 3 completion (4 confirmed defects + plausible items) | Done | All fixed; regression tests in `dns.e2e`, `network-automation.e2e` |

## Phase 4 capabilities

| Capability (brief §11) | Status | Tests |
|---|---|---|
| Polling in the worker, independent of browsers; due devices claimed with `FOR UPDATE SKIP LOCKED`; per-device interval 30 s–1 h; bounded concurrency; per-poll timeout | Done | `monitoring.e2e` (racing claims, `pollDue` with no client) and a live run of the built worker against the simulator |
| Counter collection: SNMP IF-MIB HC (64-bit per port, 32-bit fallback), RouterOS REST and API, FortiOS REST, NX-API | Done | `monitoring.e2e` (SNMP agent with changing counters, RouterOS mock, API/FortiOS/NX-API mocks) |
| Rate engine: deltas, 32-bit wrap, reset on restart, gaps (> 3 intervals), duplicates, implausible spikes, speed unknown/changed | Done | `rate-engine.test` (12), `monitoring.e2e` |
| Raw rates, 5-minute and hourly time-weighted rollups (catching up after downtime), per-organization retention | Done | `monitoring.e2e` |
| 95th percentile (nearest rank, complete 5-minute buckets) | Done | `rate-engine.test`, `monitoring.e2e` |
| Totals over count-in-totals ports with LAG de-duplication; stale ports excluded and reported | Done | `rate-engine.test`, `monitoring.e2e` |
| SSE live updates with tenant filtering, per-user stream limit and stream lifetime | Done | `monitoring.e2e` |
| Port table, port charts (gaps drawn as breaks), totals chart, overview panel, live rates on the device page | Done | `app.test`; screenshots at desktop and phone width |
| Alert rules with `forSeconds` + consecutive samples + clear samples; missing data neither fires nor clears; streak reset across gaps | Done | `monitoring.e2e` |
| Device-unreachable alerts from consecutive failed polls | Done | `monitoring.e2e` |
| Maintenance windows: suppression, and notification when the window ends while still firing | Done | `monitoring.e2e` |
| Acknowledgement (recorded, never acts on devices) | Done | `monitoring.e2e` |
| Notification outbox with retries and backoff: email (SMTP), signed webhook, Slack, Telegram; channel test; private-address guard | Done for email and webhook (tested against a local SMTP server and HTTP receiver); Slack and Telegram implemented but only their request shape is covered by code review, not by a test against the real services | `monitoring.e2e` |
| Alerts closed when their target is no longer polled | Done | `monitoring.e2e` |
| Environmental sensors, optical levels, CPU/memory, BGP session alerts | Not started | Need further collectors; candidates for a later phase |
| TimescaleDB storage | Not done (deviation) | Plain PostgreSQL tables with worker rollups; see [database](database.md#phase-4-network-monitoring-implemented) |
| Independent review of Phase 4 (6 confirmed defects + plausible items) | Done | All fixed; regression tests in `monitoring.e2e` |

## Phase 5 capabilities

| Capability (brief §12) | Status | Tests |
|---|---|---|
| Power collection in the worker (claimed with `FOR UPDATE SKIP LOCKED`, 30 s–1 h per device, timeouts), read-only | Done | `power.e2e` (racing claims, `pollDuePower` with no client); live run of the built worker against simulators |
| Redfish (`Chassis/*/Power` `PowerControl.PowerConsumedWatts`, or `EnvironmentMetrics.PowerWatts`), GET only | Done | `power.e2e` (Redfish mock) |
| IPMI DCMI power reading through `ipmitool` (password only in the environment, no shell) | Done | `power.e2e` (stand-in ipmitool recording its arguments) |
| APC metered PDUs (PowerNet-MIB rPDU2): outlet watts, device total, daisy-chained units | Done (outlets and total); daisy-chain numbering not exercised by a test | `power.e2e` (real SNMP agent with the rPDU2 tables) |
| RouterOS `/system/health` power-consumption, NX-OS `show environment power` | Done | `power.e2e` (mocks) |
| PDU outlet → device mapping; a device fed by several outlets (A+B) measured as their sum only when every outlet reports and all power supplies are mapped | Done | `power.e2e` |
| Source priority without double counting (PDU outlet → BMC → switch supply → …; lower sources fill only uncovered time; PDUs/UPS and anything feeding outlets never counted as load) | Done | `energy.test`, `power.e2e` |
| Estimates: admin per-device figure, else model typical draw; only in powered lifecycle states; never before the device existed; labelled everywhere | Done | `energy.test`, `power.e2e` |
| Energy: trapezoidal integration, no gap bridging (3 × each source's own period), duplicates once, implausible values dropped, window clipping | Done | `energy.test` (17) |
| Hourly energy rows with measured / estimated / unknown seconds and Wh; closed hours keep their attributes and estimate; catch-up after downtime; single runner; retention | Done | `power.e2e` |
| Tariffs per datacenter or organization with validity dates; cost per hour; share of cost from estimates | Done | `power.e2e` |
| Totals by rack (with power budget %), datacenter, category, customer; PDU input shown beside rack load, not added | Done | `power.e2e` |
| Energy report and CSV (device, rack, datacenter, customer, category) | Done | `power.e2e` |
| Customer view: own equipment, current power and energy, no cost, location or collection details; history limited to hours the device was theirs | Done | `power.e2e` |
| Power alerts (rack over budget, device over threshold) | Not started | The alert engine (Phase 4) evaluates port metrics only; power rules are a follow-up |
| Other PDU families (Raritan, ServerTech, Vertiv), UPS (UPS-MIB), CISCO-ENTITY-SENSOR-MIB | Not started | Only APC rPDU2 is implemented |
| Period boundaries exactly on a half-hour time-zone offset | Partial | Energy is stored per UTC hour; in Asia/Kolkata a month starts at 18:00 UTC instead of 18:30 (stated on screen and in the API) |
| Independent review of Phase 5 (8 confirmed defects + suspicions) | Done | All fixed; regression tests in `power.e2e`, `energy.test` |

## Phase 6 capabilities

| Capability (brief §13–14) | Status | Tests |
|---|---|---|
| Job state machine in PostgreSQL: claimed with `FOR UPDATE SKIP LOCKED`, lease fenced by worker id, heartbeat, per-step attempts, exponential backoff, permanent errors, deadline, cancellation with cleanup | Done | `provisioning-engine.e2e` (10) |
| Steps marked safe or unsafe to repeat; a crash or failure inside an unsafe step moves the job to `recovery` for an operator decision (retry, skip, fail) instead of repeating it | Done | `provisioning-engine.e2e`, `provisioning.e2e` (crash during "Start the server", recovery decisions) |
| Idempotency-Key header (same key + same request → same job; different request → 409), one active job per server and per VM (database-enforced) | Done | `provisioning.e2e` |
| Power actions (on, hard off, ACPI shutdown, hard reset, ACPI restart, power cycle) through a separate write-only BMC control credential; typed server name; customers on their own servers (`hardware.control`) | Done | `provisioning.e2e` (Redfish mock with state, stand-in ipmitool) |
| Verification of power actions: the BMC must report the expected state; a reset needs a new boot reported by the BMC (Redfish `BootProgress.LastStateTime`); without that the job is "Completed · not verified"; a graceful request the OS ignores fails, never escalates to hard off | Done | `provisioning.e2e` |
| OS image library with SHA-256 per file; verification by download, pinned file set, edits blocked while in use, mismatch reported; loopback/metadata URLs refused | Done | `provisioning.e2e` |
| Install by Redfish virtual media: eject, insert ISO, one-time boot from CD, start, wait for installer, eject, verify (power on, no override, media ejected) | Done | `provisioning.e2e` |
| Install by PXE/iPXE: one-time network boot, iPXE script by MAC or token, kernel arguments and config rendered per job, served once; a second request before the installer reports stops the job | Done | `provisioning.e2e` |
| Unattended-install templates (kickstart, preseed, autoinstall) with `{{variables}}` and `{{#if}}`; root password only as a SHA-512 crypt hash; unknown variables rejected | Done | `crypt.test` (reference vectors), `provisioning.e2e` |
| Installer verification: callback with a per-job token (stored hashed), or TCP port on the new address counted only after it was seen closed; the one-time boot must have been consumed | Done | `provisioning.e2e` |
| Inventory updated (host name, OS, device history) only after a verified install | Done | `provisioning.e2e` |
| Proxmox VE: read-only token sync, separate action token, VM actions verified (reboot by uptime, suspend by `qmpstatus`) | Done | `provisioning.e2e` (Proxmox API mock) |
| Virtualizor: sync, opt-in actions, graceful vs hard stop mapped as documented | Done (mapping from the API docs, not a live panel) | `provisioning.e2e` (Virtualizor mock) |
| Server Provisioning, OS & Images, Proxmox, Virtualizor pages; power-control panel on the server page | Done | Screenshots at desktop and phone width |
| Windows installs (WDS/unattend.xml), firmware/BIOS settings, RAID configuration, serial-over-LAN console | Not started | Templates are text-only; no RAID or firmware steps |
| Per-job ISO remastering for virtual media | Not started | A virtual-media install fetches its configuration by MAC (`/api/v1/boot/config?mac=`), so the ISO must be prepared to do that |
| Proxmox VM creation / Virtualizor VPS ordering | Not started | Phase 7 (services) |
| Independent review of Phase 6 (4 high, 6 medium, 3 low + 4 found in the re-check) | Done | All fixed or documented below; regression tests in `provisioning.e2e` |

## Phase 7 capabilities

| Capability | Status | Tests |
|---|---|---|
| Allocations: full / half / quarter / custom units computed from the rack height, held by a rack reservation (overlaps refused by the database, other customers' equipment can't be placed there, the reservation can't be removed from the rack screen) | Done | `colocation.e2e` |
| Contracted power per allocation (W, single or A+B feeds, breaker, voltage); use now from the Phase 5 power data with measured and estimated apart; "measured over contract" vs "may exceed only with estimates"; each device counted in one allocation | Done | `colocation.e2e` |
| Ending an allocation frees the units at once (end date not in the future) and reports equipment still there | Done | `colocation.e2e` |
| Cross-connects: customer or staff request (A side must be the customer's device/port), approve → install → active with a cross-connect id, decommission; customer can withdraw until work starts; optional link to a documented cable | Done | `colocation.e2e` |
| Shipments: announce inbound/outbound, receive (packages counted, storage location, condition), deliver to rack or ship out, customer cancel before arrival | Done | `colocation.e2e` |
| Visits: request with up to 10 visitors (only the last 2–4 characters of an ID number kept; names not written to the audit log), approve/deny with escort, check-in only around the approved window, check-out, cancel | Done | `colocation.e2e` |
| Orders & services with lifecycle history; services linked to allocations, cross-connects, servers and VMs of the same customer only | Done | `colocation.e2e` |
| Tickets and remote hands: numbering, internal notes, assignment to staff, customer resolve/close/reopen rules, authorized vs. logged billable time, staff shown to customers as "Datacenter team" | Done | `colocation.e2e` |
| Customer portal: overview (space, contracted vs. measured power, bandwidth, open requests), allocations with their equipment, requests, services, tickets; read-only portal users (customer viewer) can see but not request | Done | `colocation.e2e`; screenshots at desktop and phone width |
| Tenant isolation on every new resource (lists, details, status changes; foreign ids → 404; staff-only fields never returned) | Done | `colocation.e2e` (every describe block) |
| Email notifications to customers and staff for ticket replies and request changes | Not started | Phase 8 (workflows and notifications) |
| Attachments on tickets and shipments (photos, LOAs) | Not started | Needs object storage (deferred with device attachments) |
| Cage and suite layouts, per-outlet contracted power, power billing from contract | Not started | Phase 8 billing |
| Independent review of Phase 7 (4 medium, 8 low) | Done | All fixed or documented; regression tests in `colocation.e2e` |

## Integration compatibility matrix

"Simulator tested" means the collector passed automated tests against a protocol simulator built from published documentation (a real SNMP agent in-process, HTTP mocks of the vendor APIs). It does not prove compatibility with a specific firmware release. Nothing is marked hardware-verified without a recorded run against the device.

| Integration | Operations | Simulator tested | Hardware verified |
|---|---|---|---|
| SNMP v2c (any device) | GET/GETBULK: system, IF-MIB, IP-MIB, LAG-MIB, LLDP-MIB, CISCO-CDP-MIB, BGP4-MIB, ENTITY-MIB; counters: ifXTable HC, ifTable | Yes (`adapters.e2e`, `network.e2e`, `monitoring.e2e`) | No |
| SNMP v3 authPriv (SHA/AES tested; MD5, SHA-2, AES-256 selectable) | same | Yes (SHA + AES) | No |
| MikroTik RouterOS 7 REST | GET `/rest/system/*`, `/interface`, `/interface/ethernet`, `/interface/bonding`, `/ip/address`, `/ipv6/address`, `/ip/neighbor`, `/routing/bgp/session`; counters: `/interface` byte/packet/error/drop counters | Yes (`network.e2e`, `monitoring.e2e`) | Partial: CCR2004-1G-12S+2XS on RouterOS 7.24.5 answered `/rest/system/resource` with the fields the parser reads; full discovery run pending |
| MikroTik RouterOS API (`api`, `api-ssl`) | `/login` and the same paths as `…/print` (client refuses anything else) | Yes (`network-automation.e2e`, `monitoring.e2e`) | No |
| Fortinet FortiOS REST | GET `monitor/system/status`, `cmdb/system/interface`, `monitor/system/interface`, `monitor/router/bgp/neighbors`, `monitor/network/lldp/neighbors` | Yes (`adapters.e2e`, counters in `monitoring.e2e`) | No (FortiGate 40F pending) |
| Cisco NX-API (`cli_show`) | `show version`, `show interface`, `show ip interface vrf all`, `show port-channel summary`, `show lldp neighbors detail`, `show cdp neighbors detail`, `show ip bgp summary vrf all` | Yes (`adapters.e2e`, counters in `monitoring.e2e`) | No (Nexus 9372TX pending) |
| Cisco IOS (4500-X, 2960-X) | via SNMP adapter | Through the SNMP tests | No |
| PowerDNS authoritative (HTTP API v1) | zone read, rrset GET/PATCH (REPLACE/DELETE) on records marked as DCIM's | Yes (`dns.e2e`) | No |
| Cloudflare DNS API v4 | token verify, zone read, record list/create/delete (records with DCIM's comment) | Yes (`dns.e2e`) | No |
| SMTP (notifications) | STARTTLS / TLS / none, optional auth | Yes (local SMTP server in `monitoring.e2e`) | No |
| Webhook (notifications) | POST JSON, HMAC-SHA256 signature | Yes (`monitoring.e2e`) | No |
| Slack incoming webhook, Telegram Bot API | POST `{ text }`; `sendMessage` | No (implemented; not exercised against the services) | No |
| Redfish (iDRAC 8/9, iLO 5/6, XClarity, Supermicro) | GET `/redfish/v1/Systems`, `/Systems/*`, `/Chassis`, `/Chassis/*`, `…/Power`, `…/EnvironmentMetrics` | Yes (`power.e2e`) | No (Dell R630/R640 pending) |
| IPMI v2.0 DCMI via ipmitool | `mc info`, `dcmi power reading` | Stand-in ipmitool only (`power.e2e`) | No |
| APC rack PDU (PowerNet-MIB rPDU2) | SNMP walk of outlet metered status and device status | Yes (`power.e2e`) | No |
| RouterOS `/system/health`, NX-OS `show environment power` | read only | Yes (mocks, `power.e2e`) | No (CCR2004 power-consumption support depends on the model) |
| Redfish control (iDRAC 9, iLO 5/6, XClarity, Supermicro) | `ComputerSystem.Reset` (checked against `ResetType@Redfish.AllowableValues`), `PATCH Systems/*` Boot override (Once/Disabled, Cd/Pxe), `Managers/*/VirtualMedia` CD `InsertMedia`/`EjectMedia`, `BootProgress.LastStateTime` | Yes (`provisioning.e2e`, stateful mock) | No (Dell R630/R640 pending) |
| IPMI chassis control via ipmitool | `chassis power status/on/off/soft/reset/cycle`, `chassis bootdev pxe/none`, `chassis bootparam get 5` | Stand-in ipmitool only | No |
| iPXE / PXE | DHCP chainload to `/api/v1/boot/ipxe` (configured on your DHCP server) | Requests simulated in `provisioning.e2e` | No |
| Proxmox VE API | GET `/version`, `/nodes`, `/cluster/resources?type=vm`, `/nodes/*/qemu|lxc/*/status/current`; POST `…/status/{start,stop,shutdown,reboot,suspend,resume}` (action token only) | Yes (`provisioning.e2e`) | No |
| Virtualizor admin API | `act=servers`, `act=vs` (list, filter by `vpsid`, `action=start|stop|poweroff|restart`) | Yes (`provisioning.e2e`) | No |
| WHMCS | — | Not started | Not started |
