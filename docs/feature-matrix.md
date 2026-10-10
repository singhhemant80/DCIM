# Feature-completion matrix

Updated at the end of every phase. **Done** means it has frontend, backend logic, persistence, access control, error handling and automated tests. Anything less is listed as Partial or Not started, with the reason.

Last updated: Phase 3, 9 October 2026.

## Navigation sections

| # | Section | Status | Phase | Notes |
|---|---|---|---|---|
| 1 | Overview Dashboard | **Partial** | 1 → 4–5 | Live counts: physical capacity, devices by state and category, warranty expiry, low spare parts, network devices, cables, circuits and committed transit, IPv4 utilization and nearly-full subnets, customers, users, security activity, audit integrity. Bandwidth and power arrive with Phases 4–5. |
| 2 | Datacenters | **Done** | 2 | Create, edit, delete (only when empty), counts per site |
| 3 | Buildings and Rooms | **Done** | 2 | Buildings, rooms (floor size), rows; deletes refused while in use |
| 4 | Floor Plans | **Done** | 2 | Tile grid per room; drag or click to position racks; fill colour by occupancy |
| 5 | Racks and Rack Elevation | **Done** | 2 | Front/rear elevation, drag-and-drop placement, reservations, dedicated racks, rack relocation, history |
| 6 | Servers and Hardware Inventory | **Done** | 2 | Devices with full spec, lifecycle with configurable rules, history, CSV import/export, bulk edit, QR labels, models, spare parts. Attachments (S3) pending, see below |
| 7 | Network Infrastructure | **Done** | 3 | Network devices, physical and logical interfaces (LAG, VLAN, bridge, tunnel, loopback), cables, VLANs, VRFs, providers and circuits with history, topology, write-only access credentials, read-only discovery with preview and apply. Staff only. Live traffic is Phase 4 |
| 8 | Network Monitoring | Not started | 4 | |
| 9 | IP Address Management | **Done** | 3 | IPv4/IPv6 prefixes with hierarchy and utilization, VRFs, pools, atomic next-free allocation, reservations with expiry, release with history, conflict report, CSV import/export. Customers see their own subnets and addresses read-only |
| 10 | Power Consumption | Not started | 5 | |
| 11 | Colocation Management | Not started | 7 | |
| 12 | Server Provisioning | Not started | 6 | |
| 13 | Operating Systems and Images | Not started | 6 | |
| 14 | Proxmox Integration | Not started | 6 | |
| 15 | Virtualizor Integration | Not started | 6 | |
| 16 | Customers and Tenants | **Done** | 1 | List, search, filter, create and edit; closing a customer revokes its sessions |
| 17 | Orders and Services | Not started | 7 | |
| 18 | Monitoring and Alerts | Not started | 4 | |
| 19 | Maintenance and Incidents | Not started | 8 | |
| 20 | Remote Hands and Support Tickets | Not started | 7 | |
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
| Distributed rate limiting (Redis store) | Not started | Phase 4 |

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
| Warranty reminders | Partial | Shown on the overview and filterable; email notifications come with the notification module (Phase 4/8) |
| QR codes and printable labels | Done | `dcim.e2e` |
| Customer view of own equipment (no internal fields) | Done | `dcim.e2e` |
| Power and network connection records | Partial | Network connections (cables, ports, circuits) done in Phase 3; power connections and readings in Phase 5 |
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

## Integration compatibility matrix

"Simulator tested" means the collector passed automated tests against a protocol simulator built from published documentation (a real SNMP agent in-process, HTTP mocks of the vendor APIs). It does not prove compatibility with a specific firmware release. Nothing is marked hardware-verified without a recorded run against the device.

| Integration | Operations | Simulator tested | Hardware verified |
|---|---|---|---|
| SNMP v2c (any device) | GET/GETBULK: system, IF-MIB, IP-MIB, LAG-MIB, LLDP-MIB, CISCO-CDP-MIB, BGP4-MIB, ENTITY-MIB | Yes (`adapters.e2e`, `network.e2e`) | No |
| SNMP v3 authPriv (SHA/AES tested; MD5, SHA-2, AES-256 selectable) | same | Yes (SHA + AES) | No |
| MikroTik RouterOS 7 REST | GET `/rest/system/*`, `/interface`, `/interface/ethernet`, `/interface/bonding`, `/ip/address`, `/ipv6/address`, `/ip/neighbor`, `/routing/bgp/session` | Yes (`network.e2e`) | Partial: CCR2004-1G-12S+2XS on RouterOS 7.24.5 answered `/rest/system/resource` with the fields the parser reads; full discovery run pending |
| MikroTik RouterOS API (`api`, `api-ssl`) | `/login` and the same paths as `…/print` (client refuses anything else) | Yes (`network-automation.e2e`) | No |
| Fortinet FortiOS REST | GET `monitor/system/status`, `cmdb/system/interface`, `monitor/system/interface`, `monitor/router/bgp/neighbors`, `monitor/network/lldp/neighbors` | Yes (`adapters.e2e`) | No (FortiGate 40F pending) |
| Cisco NX-API (`cli_show`) | `show version`, `show interface`, `show ip interface vrf all`, `show port-channel summary`, `show lldp neighbors detail`, `show cdp neighbors detail`, `show ip bgp summary vrf all` | Yes (`adapters.e2e`) | No (Nexus 9372TX pending) |
| Cisco IOS (4500-X, 2960-X) | via SNMP adapter | Through the SNMP tests | No |
| PowerDNS authoritative (HTTP API v1) | zone read, rrset GET/PATCH (REPLACE/DELETE) on records marked as DCIM's | Yes (`dns.e2e`) | No |
| Cloudflare DNS API v4 | token verify, zone read, record list/create/delete (records with DCIM's comment) | Yes (`dns.e2e`) | No |
| Redfish, IPMI, Proxmox, Virtualizor, WHMCS | — | Not started | Not started |
