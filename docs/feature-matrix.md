# Feature-completion matrix

Updated at the end of every phase. **Done** means it has frontend, backend logic, persistence, access control, error handling and automated tests. Anything less is listed as Partial or Not started, with the reason.

Last updated: Phase 2, 9 October 2026.

## Navigation sections

| # | Section | Status | Phase | Notes |
|---|---|---|---|---|
| 1 | Overview Dashboard | **Partial** | 1 → 4–5 | Live counts: physical capacity (racks, units used/free/reserved), devices by state and category, warranty expiry, low spare parts, customers, users, security activity, audit integrity. Bandwidth and power arrive with Phases 4–5. |
| 2 | Datacenters | **Done** | 2 | Create, edit, delete (only when empty), counts per site |
| 3 | Buildings and Rooms | **Done** | 2 | Buildings, rooms (floor size), rows; deletes refused while in use |
| 4 | Floor Plans | **Done** | 2 | Tile grid per room; drag or click to position racks; fill colour by occupancy |
| 5 | Racks and Rack Elevation | **Done** | 2 | Front/rear elevation, drag-and-drop placement, reservations, dedicated racks, rack relocation, history |
| 6 | Servers and Hardware Inventory | **Done** | 2 | Devices with full spec, lifecycle with configurable rules, history, CSV import/export, bulk edit, QR labels, models, spare parts. Attachments (S3) pending, see below |
| 7 | Network Infrastructure | Not started | 3 | |
| 8 | Network Monitoring | Not started | 4 | |
| 9 | IP Address Management | Not started | 3 | |
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
| Power and network connection records | Not started | Network connections in Phase 3, power connections and readings in Phase 5 |
| Environmental sensor associations | Not started | Needs the monitoring collectors (Phase 4) |
| Attachments (S3-compatible storage) | Not started | Planned with the object-storage integration; no files are stored yet |
| Inventory reconciliation against discovered hardware | Not started | Needs Redfish/SNMP discovery (Phases 3 and 6) |
| Independent review of Phase 2 (9 defects) | Done | All fixed; `dcim-regressions.e2e` |

## Integration compatibility matrix

| Integration | Simulator tested | Hardware verified |
|---|---|---|
| All device and platform adapters | Not started | Not started |
