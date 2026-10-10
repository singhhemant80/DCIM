# API

Base path `/api/v1`. Interactive documentation is at `/api/docs` and the OpenAPI JSON at `/api/docs/openapi.json` when `ENABLE_SWAGGER=true` (the default outside production).

## Conventions

- **Auth:** session cookie from `POST /auth/login`, or an API key: `Authorization: Bearer ndc_…` (no CSRF token needed). A key acts with its scopes, limited to its owner's current permissions; routes marked *session only* refuse keys with `session_required`.
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

## Phase 4 endpoints (implemented)

**Monitoring** — under `/api/v1/monitoring`. Reads need `monitoring.read`; customers with it see only their ports (own devices and ports cabled to them). Rates are measured; values older than three intervals are returned as `null` with `fresh: false`.

| Method and path | Notes |
|---|---|
| `GET /ports` | Paginated; `?q=&deviceId=&datacenterId=&sort=traffic\|utilization\|errors\|name&totalsOnly=true`; each row has the latest in/out bit/s, utilization, errors/discards per second, link state, `sampledAt`, `fresh` and `lastSkip` (why the last poll gave no rate) |
| `GET /ports/:id` · `GET /ports/:id/history?range=1h\|6h\|24h\|7d\|30d` | History uses raw samples up to 6 h, 5-minute averages up to 7 d and hourly averages for 30 d; `p95` is the nearest-rank 95th percentile of complete 5-minute averages |
| `GET /totals` · `GET /totals/history?range=&datacenterId=` | Staff. Sum over ports marked count-in-totals, LAG counted once; stale ports reported separately |
| `GET /devices` · `PUT /devices/:id` · `DELETE /devices/:id` | Staff. Polling health; PUT `{ enabled, credentialKind, intervalSeconds (30–3600) }` needs `monitoring.configure` and a stored credential of that kind |
| `GET /settings` · `PUT /settings` | Staff. Retention `{ rawDays, fiveMinuteDays, hourlyDays }` |
| `GET /stream` | `text/event-stream`: events `hello`, `ping` (both with `live`), `rates`, `alert` (staff only) |

**Alerts** — under `/api/v1/alerts`, staff only. Reads need `monitoring.read`; rules, maintenance and acknowledgement need `alerts.manage`; channels need `monitoring.configure`.

| Method and path | Notes |
|---|---|
| `GET /` · `GET /summary` · `POST /:id/ack` | `?status=firing\|resolved\|all&severity=&deviceId=`; ack `{ note? }` |
| `GET, POST /rules` · `PUT, DELETE /rules/:id` | Changing or deleting a rule closes its open alerts and restarts evaluation |
| `GET, POST /maintenance` · `PUT, DELETE /maintenance/:id` | |
| `GET, POST /channels` · `PUT, DELETE /channels/:id` · `POST /channels/:id/test` | Secrets write-only; test queues a message for the worker |
| `GET /notifications` | `?channelId=`; recent deliveries with status and error |

`GET /api/v1/overview/bandwidth` returns current totals, the last 24 h and the alert summary for the dashboard.

Error codes added: `no_credential`, `duplicate_name`, `too_many_streams`.

## Phase 5 endpoints (implemented)

**Power** — under `/api/v1/power`. Reads need `power.read`; customers get only devices assigned to them, without cost, location or collection details. Configuration needs `power.configure` (staff). Every figure carries `quality` (`measured`, `estimated`, `unknown`, `off`) and `source`.

| Method and path | Notes |
|---|---|
| `GET /summary?period=&datacenterId=` | Now (measured W, estimated W, unknown devices), energy and cost for `24h`, `7d`, `30d`, `mtd`, `last_month`, by datacenter (staff) and category, largest draw |
| `GET /devices` · `GET /devices/:id` · `GET /devices/:id/history?range=24h\|7d\|30d` | Paginated with energy per device; detail has model spec, estimate, latest reading per source and outlets (staff); history has raw readings (24 h) and hourly rows |
| `PUT /devices/:id/profile` | `{ estimateW, includeInTotals, notes }` |
| `GET /racks` · `GET /pdus` · `PUT /outlets/:id` | Staff. Rack load vs budget and PDU input; PDU outlets; map an outlet `{ deviceId, label }` |
| `GET /polling` · `PUT /polling/:deviceId` · `DELETE /polling/:deviceId` | Staff. `{ enabled, credentialKind, intervalSeconds }`; needs a stored credential of that kind |
| `GET, POST /tariffs` · `PUT, DELETE /tariffs/:id` | Staff. `{ name, datacenterId?, currency, pricePerKwh, validFrom }` |
| `GET /settings` · `PUT /settings` | Staff. Retention `{ rawDays, hourlyDays }` |
| `GET /energy?period=&groupBy=` · `GET /energy.csv?period=&groupBy=` | Grouped by device, rack, datacenter, customer or category (customers: device or category) |

`GET /api/v1/overview/power` returns the dashboard power panel. Device credentials accept `redfish` (`username`, `password`, `scheme`, `verifyTls`) and `ipmi` (`username`, `password` up to 20 characters, `ipmiPrivilege`); these are used for power and a connection test, not for network discovery.

## Phase 6 endpoints (implemented)

**Provisioning** — under `/api/v1/provisioning`. Every action is a job; `201` means queued. `POST` requests accept an `Idempotency-Key` header (up to 200 printable characters): the same key with the same body returns the same job (`replayed: true`), with a different body `409 idempotency_conflict`. A second job for a server or VM that has one active gets `409 job_in_progress` with its id.

| Method and path | Notes |
|---|---|
| `GET /summary` | Staff. Active, needing a decision, completed (verified / not verified) and failed in 7 days |
| `GET /jobs?status=active\|finished\|all&kind=&deviceId=` · `GET /jobs/:id` | Staff with `provisioning.read`; customers with `hardware.control` see power and VM actions on their own equipment. Detail has steps and log. Completed jobs carry `verified` (false when the outcome could not be observed) |
| `POST /jobs/:id/cancel` | `provisioning.execute`, staff. Queued: cancelled at once. Running: stops at the next step boundary after cleanup |
| `POST /jobs/:id/recovery` | `{ decision: retry\|skip\|fail, note? }` for a job in `recovery` |
| `GET /devices/:id/control` | `hardware.control`. Whether power control is set up, which actions it supports, the active job; staff also see the credential's host and user (never the password) |
| `PUT /devices/:id/control` · `DELETE /devices/:id/control` | `provisioning.execute`, staff. `redfish { host, port, username, password, scheme, verifyTls, timeoutMs }` or `ipmi { host, port, username ≤16, password ≤20, ipmiPrivilege }` |
| `POST /devices/:id/power-actions` | `hardware.control` (customers: own servers). `{ action, confirm }`; `confirm` is the host name or asset tag. IPMI has no `graceful_restart` |
| `POST /installs` | `provisioning.execute`, staff. `{ deviceId, imageId, method: redfish_virtual_media\|pxe, hostname, macAddress, network: dhcp\|static{address,prefixLength,gateway,nameservers}, rootPassword?, sshKeys[], verify: callback\|tcp{port}, timeoutMinutes, confirm, wipeAcknowledged: true }`. Refused if the image is not verified, the address belongs to something else in IPAM or another active install, or the control credential can't do the method |
| `GET /images` · `POST /images` · `PUT /images/:id` · `DELETE /images/:id` · `POST /images/:id/verify` | Staff. File changes reset verification and are refused while a job uses the image |

**Virtualization** — under `/api/v1/virtualization`.

| Method and path | Notes |
|---|---|
| `GET, POST /integrations` · `PUT, DELETE /integrations/:id` · `POST /integrations/:id/sync` | Staff. Proxmox `{ url, verifyTls, tokenId, tokenSecret, actionTokenId?, actionTokenSecret?, syncMinutes, enabled }`; Virtualizor `{ url, verifyTls, apiKey, apiPass, actionsEnabled, syncMinutes, enabled }`. Secrets are write-only and must be re-entered on update |
| `GET /hosts?integrationId=` · `PUT /hosts/:id/device` | Staff. Link a node to a DCIM server `{ deviceId }` (never inferred) |
| `GET /guests?kind=&integrationId=&q=&status=` | `services.read`; customers see VMs assigned to them, without host or integration names |
| `PUT /guests/:id/customer` | Staff. `{ customerId }` |
| `POST /guests/:id/actions` | `hardware.control`. `{ action: start\|stop\|shutdown\|reboot\|suspend\|resume, confirm }`; needs actions enabled on the integration. Virtualizor: no suspend/resume |

**Boot endpoints** — `/api/v1/boot/*`, no session. Only from `CDCIM_BOOT_ALLOW` networks, only for an active install that has reached its boot step, keyed by the job's boot token or its MAC.

| Method and path | Notes |
|---|---|
| `GET /ipxe?mac=` · `GET /ipxe/:token` | iPXE script (`kernel` + `initrd` from the pinned image files, rendered kernel arguments). Unknown MAC or no install: a script that `exit`s to the next boot device. Served once; a second request before the installer reports stops the job |
| `GET /config/:token` (also `/user-data`, `/meta-data`) · `GET /config?mac=` | Rendered install file. By MAC only once per job |
| `POST /callback/:token` | `{ status: started\|done\|failed, message? }` from the installer |

## Phase 7 endpoints (implemented)

**Colocation** — under `/api/v1/colocation`. Reads need `services.read`; customers get their own rows only (other ids → 404) without staff notes, cable ids or staff identities. Allocation changes need `services.write` (staff). Requests (cross-connects, shipments, visits) are filed by staff with `services.write` or by customer users with `tickets.write` for their own account; status changes are staff work, except that a customer can withdraw/cancel its own request.

| Method and path | Notes |
|---|---|
| `GET /overview` | Space (units), contracted power, measured W and estimated W apart, unknown devices, allocations measured over contract and those that may exceed only with estimates, bandwidth now, open requests |
| `GET /sites` | Datacenter codes and names (for requests) |
| `GET /allocations?status=active\|ended&customerId=&datacenterId=` · `GET /allocations/:id` | With power use; detail lists the customer's equipment in the space |
| `POST /allocations` · `PUT /allocations/:id` · `POST /allocations/:id/end` | `{ customerId, rackId, kind, part, startU, endU, contractedPowerW, feeds, breakerAmps, voltage, startDate, serviceId, notes }`; update keeps fields left out; end `{ endDate (not in the future), reason }` |
| `GET, POST /cross-connects` · `POST /cross-connects/:id/status` | `{ aDeviceId, aInterfaceId, aLabel, zLabel, loaReference, media, speed }`; status `{ status, circuitId, cableId, reason }` |
| `GET, POST /shipments` · `POST /shipments/:id/status` | `{ datacenterId, direction, carrier, trackingNumber, expectedOn, packages, description, instructions }`; status `{ status, storageLocation, packagesReceived, conditionNote }` |
| `GET, POST /visits` · `POST /visits/:id/status` | `{ datacenterId, visitors[{ name, company, idLast4 }], startsAt, endsAt, purpose }`; status `{ status, note, escort, badge }` |

**Orders & services** — `/api/v1/services`: `GET /` (filters `q`, `customerId`, `kind`, `status`), `GET /:id` (history, linked allocations and cross-connects), `POST /`, `PUT /:id`, `POST /:id/status` `{ status, reason }` (staff, `services.write`). Status changes are records only.

**Tickets** — `/api/v1/tickets` (`tickets.read` / `tickets.write`): `GET /?status=open|all|…&kind=&customerId=&q=&mine=`, `GET /:id` (customers: public messages and billable time only), `POST /` `{ customerId?, kind, priority, subject, body, deviceId, authorizedMinutes }`, `POST /:id/messages` `{ body, internal }` (internal: staff only), `PATCH /:id` `{ status, priority, assigneeUserId, authorizedMinutes }` (customers: resolve, close, reopen a resolved ticket), `POST /:id/time` `{ minutes, note, billable }` (staff), `GET /assignees` (staff).

## Phase 8 endpoints (implemented)

**API keys** — `/api/v1/api-keys`, `apikeys.manage`, staff, *session only*: `GET /`, `POST /` `{ name, scopes[], expiresInDays }` → token once, `DELETE /:id` (revoke). Users, roles and settings routes are also session only.

**Events and webhooks** — `/api/v1/automation` (`workflows.manage`, staff): `GET /event-types`, `GET /events?type=&limit=`, `GET, POST /webhooks` (create is session only; returns `signingSecret` once), `PUT, DELETE /webhooks/:id`, `POST /webhooks/:id/rotate-secret` (session only), `GET /webhooks/:id/deliveries`, `POST /deliveries/:id/redeliver`.

Deliveries are `POST` JSON `{ id, type, occurredAt, customerId, subject, data }` with headers `X-NexoraDC-Event`, `X-NexoraDC-Event-Id` (stable across retries), `X-NexoraDC-Delivery`, `X-NexoraDC-Timestamp`, `X-NexoraDC-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`.

**Workflows** — `/api/v1/workflows` (`workflows.manage`, staff): `GET, POST /`, `PUT, DELETE /:id`, `POST /dry-run` `{ workflow, eventId? | sample? }`, `GET /runs?workflowId=&status=`, `POST /runs/:id/approve` · `/reject` `{ note }` (session only; the last editor can't approve).

**Billing** — `/api/v1/billing` (`billing.manage`, staff): `GET, POST /integrations` (create is session only; returns the module secret once), `PUT /integrations/:id`, `POST /integrations/:id/rotate-secret` (session only), `GET, PUT /integrations/:id/mappings`, `DELETE /integrations/:id/mappings/:mappingId`, `GET /integrations/:id/events?status=`, `GET /integrations/:id/reconciliations`, `POST /integrations/:id/reconcile` `{ services[] }`, `GET /usage?billingReference=&from=&to=` (up to 92 days).

**WHMCS module endpoints** — `/api/v1/billing/whmcs/:integrationId/{events,reconcile,usage,ping}`: no session; each request is signed with `X-NexoraDC-Timestamp` and `X-NexoraDC-Signature` over the raw body (5-minute window). Events: `{ id, type, occurredAt?, data }`; a repeated id returns `{ duplicate: true, status, message }` and changes nothing. Outcomes: `applied`, `ignored` (already in that state), `review` (held for staff), `rejected` (invalid transition).

**Reports** — `/api/v1/reports` (`reports.read`): `GET /types`, `GET /?type=energy|bandwidth|capacity|remote_hands|services&period=last_7d|last_30d|this_month|last_month&format=json|csv|pdf` (capacity: staff only; customers get their own account), `GET, POST /schedules`, `PUT, DELETE /schedules/:id`, `POST /schedules/:id/run` (staff; writes also need `alerts.manage`).

**Incidents and maintenance notices** — `/api/v1/status` (`tickets.read`; writes: staff with `alerts.manage`): `GET /incidents?status=open|resolved|all`, `GET /incidents/:id`, `POST /incidents` `{ title, severity, datacenterId?, customerIds[], public, message }`, `POST /incidents/:id/updates` `{ status, message, public }`, `GET /maintenance`, `PUT /maintenance/:id/notice` `{ customerVisible, description }`, `GET /customers` (staff picker).
