# API

Base path `/api/v1`. Interactive documentation is at `/api/docs` and the OpenAPI JSON at `/api/docs/openapi.json` when `ENABLE_SWAGGER=true` (the default outside production).

## Conventions

- **Auth:** session cookie from `POST /auth/login`. Machine API keys arrive in Phase 8.
- **CSRF:** every `POST`, `PATCH`, `PUT` and `DELETE` must send `X-CSRF-Token` equal to the `cdcim_csrf` cookie.
- **Validation:** request bodies and queries are validated with the shared Zod schemas. Unknown keys are stripped.
- **Errors:** `{ "error": "<code>", "message": "<human text>", "requestId": "<id>", "issues"?: [{ "path", "message" }] }`. Codes in use: `validation_failed`, `unauthenticated`, `invalid_credentials`, `csrf_failed`, `forbidden`, `mfa_enrollment_required`, `mfa_invalid_code`, `mfa_challenge_invalid`, `privilege_escalation`, `not_found`, `conflict`, `last_super_admin`, `rate_limited`, `internal_error`.
- **Pagination:** `?page=1&pageSize=25` (max 200). Responses are `{ items, page, pageSize, total }`.
- **Tracing:** send `X-Request-Id` (letters, digits, `._-`, max 64 characters) or one is generated. It is echoed in the response and stored in audit records.
- **Tenancy:** customer users only ever receive their own rows. Out-of-scope ids return 404.
- **Versioning:** breaking changes go to `/api/v2`, and v1 stays available for at least one release.

## Phase 1 endpoints (implemented)

| Method and path | Permission | Notes |
|---|---|---|
| `POST /auth/login` | public | `{ email, password }` → `{ mfaRequired, challengeToken? }`. Sets cookies when no MFA. |
| `POST /auth/mfa/verify` | public | `{ challengeToken, code }` (TOTP or recovery code) |
| `POST /auth/logout` | session | |
| `GET /auth/me` | session | profile, organization, effective permissions, MFA state |
| `POST /auth/password` | session | `{ currentPassword, newPassword }`. Signs out your other sessions. |
| `POST /auth/mfa/setup` · `/enable` · `/disable` | session | enrollment returns QR and secret once, `enable` returns recovery codes once |
| `GET /auth/sessions` · `DELETE /auth/sessions/:id` | session | your own sessions only |
| `GET /customers/me` | customer user | own customer account |
| `GET /customers` · `GET /customers/:id` | `customers.read` | search `q`, filter `status` |
| `POST /customers` · `PATCH /customers/:id` | `customers.write` | closing a customer revokes its users' sessions |
| `GET /users` · `GET /users/:id` | `users.read`, staff only | filters `q`, `userType`, `customerId`, `status` |
| `POST /users` · `PATCH /users/:id` | `users.write` | escalation and last-super-admin checks |
| `POST /users/:id/revoke-sessions` | `users.sessions.revoke` | |
| `POST /users/:id/reset-mfa` | `users.write` + `users.sessions.revoke` | |
| `GET /roles` · `GET /roles/permissions` | `roles.read` | permission catalog with `staffOnly` and `dangerous` flags |
| `POST /roles` · `PATCH /roles/:id` · `DELETE /roles/:id` | `roles.write` | built-in roles are read-only |
| `GET /settings` · `PATCH /settings` | `settings.read` / `settings.write` | |
| `GET /audit` · `GET /audit/verify` | `audit.read`, staff only | filters `action`, `actorId`, `targetType`, `outcome`, `from`, `to` |
| `GET /overview` · `GET /overview/audit-integrity` | staff | counts limited to the caller's permissions |
| `GET /health/live` · `GET /health/ready` | public | readiness checks Postgres and Redis and returns 503 if degraded |

## Phase 2 endpoints (implemented)

All under `/api/v1/dcim`. Reads need `dcim.read`, changes need `dcim.write`. Everything except `devices` (list/get) is staff-only. Customer users get only their own devices, without purchasing data, notes or management addresses.

| Method and path | Notes |
|---|---|
| `GET /summary` | Dashboard figures |
| `GET /tree` | Datacenter → building → room → row hierarchy |
| `GET, POST /datacenters`, `GET, PATCH, DELETE /datacenters/:id` | Delete only when empty |
| `POST /buildings`, `PATCH, DELETE /buildings/:id` | |
| `POST /rooms`, `PATCH, DELETE /rooms/:id` | Floor size can't shrink below placed racks |
| `POST /rows`, `PATCH, DELETE /rows/:id` | |
| `GET, POST /racks`, `PATCH, DELETE /racks/:id` | `?datacenterId=&roomId=&q=`; occupancy counts each unit once |
| `GET /racks/:id/elevation` | Placed devices, 0U devices, reservations |
| `POST /racks/:id/move` | Relocate to another room, row or floor tile |
| `POST /racks/:id/reservations`, `DELETE /racks/:id/reservations/:rid` | |
| `GET /racks/:id/events` | Rack history |
| `GET, POST /manufacturers` · `GET, POST /models`, `PATCH, DELETE /models/:id` | Size can't change while devices use the model |
| `GET /devices` | Filters `q, state, category, datacenterId, rackId, customerId, unracked, warrantyWithinDays, sort` |
| `POST /devices`, `GET, PATCH /devices/:id` | |
| `POST /devices/:id/placement` | `{ rackId, positionU, face }` or `{ rackId: null }` |
| `POST /devices/:id/transition`, `GET /devices/:id/transitions` | Enforces the organization's lifecycle rules |
| `GET, POST /devices/:id/events` | History; add maintenance notes |
| `GET /devices/:id/label` | QR code (SVG) and label fields |
| `POST /devices/bulk` | Customer, ownership, supplier, warranty, state; per-device results |
| `GET /devices/export.csv` · `POST /devices/import` | `dryRun` validates against the database and rolls back |
| `GET, PUT /lifecycle-rules` | PUT needs `settings.write` |
| `GET, POST /spare-parts`, `PATCH, DELETE /spare-parts/:id`, `POST /spare-parts/:id/adjust`, `GET /spare-parts/:id/movements` | |

Error codes added: `placement_conflict`, `does_not_fit`, `units_reserved`, `rack_dedicated`, `rack_decommissioned`, `rack_in_use`, `rack_not_empty`, `change_state_first`, `place_first`, `transition_not_allowed`, `device_retired`, `unrack_first`, `model_in_use`, `insufficient_stock`, `reservation_conflict`, `in_use`.

## Phase 3 endpoints (implemented)

**Network** — all under `/api/v1/network`, staff only. Reads need `network.read`, changes need `network.write`; credentials need `monitoring.configure`.

| Method and path | Notes |
|---|---|
| `GET /summary` | Dashboard counts |
| `GET /devices` | `?q=&datacenterId=&all=true` (all includes servers); port, cabling, credential and last-discovery summary |
| `GET /devices/:id` · `PATCH /devices/:id` | Summary with credentials (no secrets), recent runs and the last collected facts and BGP sessions (a dated snapshot, not live data); PATCH sets `platform`, `networkRole` |
| `GET /devices/:id/interfaces` | Ports and logical interfaces with cable peer, circuit, VLANs, LAG members, neighbors and IP addresses |
| `POST /interfaces` · `POST /interfaces/bulk` · `GET, PUT, DELETE /interfaces/:id` | Bulk takes a pattern such as `Ethernet1/[1-48]` and skips existing names |
| `GET, POST /cables` · `PATCH, DELETE /cables/:id` | `?deviceId=` |
| `GET, POST /vlans` · `PUT, DELETE /vlans/:id` · `GET /vlans/:id/ports` | |
| `GET, POST /vrfs` · `PUT, DELETE /vrfs/:id` | |
| `GET, POST /providers` · `PUT, DELETE /providers/:id` | |
| `GET, POST /circuits` · `PUT, DELETE /circuits/:id` · `GET /circuits/:id/events` | `?providerId=&status=`; delete only when planned or decommissioned |
| `GET /topology` | `?datacenterId=`; nodes and links with `kind` cable, neighbor or circuit |
| `GET /devices/:id/credentials` · `PUT /devices/:id/credentials` · `DELETE /devices/:id/credentials/:kind` | Secrets are write-only; the host is fixed when the secret is saved |
| `GET, POST /devices/:id/discovery` | POST `{ kind, mode: 'test' \| 'discover' }` queues a run for the worker; one active run per device |
| `GET /discovery/:runId` | Status, collected result and the preview of changes |
| `POST /discovery/:runId/apply` | `{ interfaces: [names], importNeighbors, updateDeviceFacts, addresses: [{ interface, address }], createPrefixes }`; once per run; recording addresses needs `ipam.write` |
| `PUT /devices/:id/credentials/:kind/schedule` | `{ hours: 1–720 \| null }`; scheduled runs are previews only |

**IPAM** — all under `/api/v1/ipam`. Reads need `ipam.read`, changes need `ipam.write` and are staff only. Customers can list and read their own prefixes and addresses.

| Method and path | Notes |
|---|---|
| `GET /summary` | Counts, IPv4 utilization of active leaf subnets, fullest subnets (staff) |
| `GET /prefixes` · `GET /prefixes/:id` | `?q=` (prefix, contained address, text) `&vrfId=<id>\|global&family=4\|6&customerId=`; detail has parents, children, free ranges and the reverse zone |
| `POST /prefixes` · `PUT /prefixes/:id` · `DELETE /prefixes/:id` | Delete refused while addresses depend only on this prefix |
| `GET /addresses` · `GET /addresses/:id` · `GET /addresses/:id/history` | Paginated; `?q=&prefixId=&status=&vrfId=&deviceId=&customerId=`; released rows only with `status=released` |
| `POST /addresses` | Reserve or allocate one specific address |
| `POST /allocate-next` | `{ prefixId, count (1–256), …assignment }` — atomic |
| `PATCH /addresses/:id` | Changes only the fields sent (`null` clears) |
| `POST /addresses/:id/release` | `{ reason? }` |
| `GET /conflicts` | Consistency report |
| `GET /export.csv?kind=prefixes\|addresses` · `POST /import` | Import `{ kind, csv, dryRun }` |

**DNS** — under `/api/v1/ipam/dns`, staff only. Reads need `ipam.read`; changes need `dns.manage`.

| Method and path | Notes |
|---|---|
| `GET, POST /servers` · `PUT, DELETE /servers/:id` · `POST /servers/:id/test` | PowerDNS `{ kind, name, url, serverId, verifyTls, apiKey }` or Cloudflare `{ kind, name, apiToken }`; keys are write-only; the check runs in the worker |
| `GET, POST /zones` · `PUT, DELETE /zones/:id` | `{ serverId, name, kind: forward\|reverse, providerZoneId (Cloudflare), ttl, enabled }`; a zone holding DCIM records can be disabled but not renamed, moved or deleted |
| `POST /resync` | Queue every named address for publishing again |
| `POST /addresses/:id/resync` | Retry one address (`ipam.write`) |

IPAM endpoints never configure a device or announce a route. Address changes are published to DNS by the worker, only into enabled zones and only for allocated or deprecated addresses in the global table; staff address views carry a `dns` object with the status, error and published records.

Error codes added: `invalid_relation`, `not_cableable`, `port_in_use`, `prefix_exists`, `address_in_use`, `prefix_full`, `prefix_container`, `prefix_deprecated`, `reserved_address`, `no_prefix`, `customer_mismatch`, `prefix_in_use`, `invalid_gateway`, `address_released`, `no_credential`, `no_address`, `invalid_credential`, `discovery_running`, `not_applicable`, `already_applied`, `stale_run`, `invalid_zone`, `zone_in_use`, `kind_fixed`.

## Planned resources

| Phase | Resources |
|---|---|
| 4 | `/monitoring/summary`, `/interfaces/:id/rates?range=`, `/interfaces/:id/history`, `/stream` (SSE), `/alert-rules`, `/alerts` (+ `/ack`), `/maintenance-windows`, `/polling/health`, `/monitoring/settings` |
| 5 | `/power/summary`, `/power/devices`, `/power/racks/:id`, `/devices/:id/power-profile`, `/power/readings`, `/tariffs` |
| 6 | `/provisioning/jobs` (idempotency-key header), `/os-images`, `/integrations/proxmox/*`, `/integrations/virtualizor/*`, `/devices/:id/power-actions` (`hardware.control`, confirmation token) |
| 7 | `/services`, `/colocation/allocations`, `/cross-connects`, `/tickets`, `/remote-hands`, `/visitors` |
| 8 | `/billing/whmcs/webhook` (HMAC-signed, idempotent), `/billing/mappings`, `/reports/*` (CSV/PDF), `/workflows`, `/api-keys`, `/webhook-subscriptions` |
