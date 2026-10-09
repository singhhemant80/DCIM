# Feature-completion matrix

Updated at the end of every phase. **Done** means it has frontend, backend logic, persistence, access control, error handling and automated tests. Anything less is listed as Partial or Not started, with the reason.

Last updated: Phase 1, 9 October 2026.

## Navigation sections

| # | Section | Status | Phase | Notes |
|---|---|---|---|---|
| 1 | Overview Dashboard | **Partial** | 1 → 2–5 | Live counts for customers, users, sessions, security activity and audit integrity. Infrastructure metrics are added as their modules land. |
| 2 | Datacenters | Not started | 2 | Page states "not built yet" |
| 3 | Buildings and Rooms | Not started | 2 | |
| 4 | Floor Plans | Not started | 2 | |
| 5 | Racks and Rack Elevation | Not started | 2 | |
| 6 | Servers and Hardware Inventory | Not started | 2 | |
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

## Integration compatibility matrix

| Integration | Simulator tested | Hardware verified |
|---|---|---|
| All device and platform adapters | Not started | Not started |
