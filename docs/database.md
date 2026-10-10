# Database design

PostgreSQL 16. The schema is defined in [`apps/api/src/db/schema.ts`](../apps/api/src/db/schema.ts) (Drizzle ORM), and SQL migrations are checked in under [`apps/api/drizzle/`](../apps/api/drizzle). High-frequency telemetry (Phase 4+) is stored in the same database (plain tables with worker-built rollups; TimescaleDB was planned but is not required, see Phase 4 below), so one backup covers everything and joins to inventory stay simple.

## Conventions

- UUID primary keys (`gen_random_uuid()`), except `audit_events`, which uses `bigserial` for ordering.
- Every tenant-scoped table has `org_id NOT NULL` with an FK to `organizations ON DELETE RESTRICT`. Customer-owned rows add a nullable `customer_id`, where NULL means company-owned.
- `created_at` and `updated_at` are `timestamptz`. `updated_at` is maintained by a trigger, not by application code.
- Deletion policy: `RESTRICT` by default, so history is never removed by accident. `CASCADE` only for rows that are meaningless without their parent (sessions, recovery codes and role links of a deleted user). Inventory uses lifecycle states (`retired`) instead of deletes.
- Enumerations are Postgres enums for closed sets (status values) and text plus CHECK constraints where the set is expected to grow.
- Every migration runs in a transaction and is recorded in `drizzle.__drizzle_migrations`. `npm run db:migrate` is idempotent.

## Phase 1 tables (implemented)

| Table | Purpose | Notable constraints and indexes |
|---|---|---|
| `organizations` | The operator (Crapplet Infotech). `settings` JSONB holds timezone, currency and session/MFA policy. | `slug` unique |
| `customers` | Tenants inside the organization | unique `(org_id, code)`; index `(org_id, name)` |
| `users` | Staff and customer portal users | unique `lower(email)`; CHECK that a user is a customer user if and only if `customer_id` is set |
| `roles` | Built-in (`system_key`) and custom roles, `permissions text[]` | unique `(org_id, name)`, `(org_id, system_key)` |
| `user_roles` | Many-to-many | PK `(user_id, role_id)`; role FK `RESTRICT` (an assigned role cannot be deleted) |
| `sessions` | Server-side sessions (token and CSRF stored as SHA-256 hashes) | unique `token_hash` |
| `mfa_challenges` | Short-lived second-factor challenges with an attempt counter | unique `token_hash` |
| `mfa_recovery_codes` | Hashed single-use codes | index `user_id` |
| `audit_events` | Append-only, hash-chained log | triggers block UPDATE, DELETE and TRUNCATE; indexes on `(org_id, occurred_at)`, actor, action and target |

Migrations: `0000_initial_identity.sql` (tables), `0001_audit_immutability.sql` (audit triggers and `updated_at` triggers).

## Planned schema by phase

The entity outlines below set the direction for later phases. Each phase delivers its own migrations and tests.

### Phase 2: physical DCIM (implemented)

Migrations `0002_physical_dcim.sql` (tables), `0003_dcim_constraints.sql` (constraints and triggers), `0004_dcim_locking.sql` (row locking in the fit check, sized-device check).

| Table | Purpose and key rules |
|---|---|
| `datacenters`, `buildings`, `rooms`, `rack_rows` | Site hierarchy; unique names per parent; `RESTRICT` deletes |
| `racks` | Height 1–60U, depth, numbering, status, optional dedicated customer, floor-plan tile (unique per room) |
| `rack_reservations` | Unit ranges for a customer or internal hold, optional expiry; **GiST exclusion: no overlapping reservations** |
| `manufacturers`, `device_models` | Device types with height (0–60U), depth, full/half depth, datasheet power figures (estimates only) |
| `devices` | Asset record; copies model height/depth class; generated `u_range`, `occupies_front`, `occupies_rear`; **GiST exclusion per face: no overlapping equipment**; triggers: fits rack height and depth, same organization; CHECKs: placement completeness, customer-owned needs a customer |
| `lifecycle_transitions` | Allowed state changes per organization (seeded with defaults, editable) |
| `device_events`, `rack_events` | History timelines |
| `spare_parts`, `spare_part_movements` | Stock with CHECK quantity ≥ 0; every change logged |

Rack resize and depth changes are refused by trigger when equipment would no longer fit. The fit trigger takes `FOR SHARE` on the rack so a resize and a placement cannot both commit (write skew).

The outline below was the original plan, kept for reference.

#### Original plan

```
datacenters(id, org_id, code, name, address, timezone, …)
buildings(id, datacenter_id, name)
rooms(id, building_id, name, floor, floor_plan_object_key, width_mm, depth_mm)
rows(id, room_id, name, position)
racks(id, row_id|room_id, name, u_height, width_mm, depth_mm, numbering_desc bool,
      customer_id NULL, reservation_customer_id NULL, max_power_w, status, x,y on floor plan)
manufacturers(id, name)
device_models(id, manufacturer_id, model, category, u_height, full_depth bool, mount_faces,
              typical_w, idle_w, max_w, psu_count, psu_rated_w, spec_source)
devices(id, org_id, customer_id NULL, ownership ('company'|'customer'), asset_tag, hostname,
        serial, model_id, category, lifecycle_state, rack_id NULL, position_u NULL, face,
        purchase_date, supplier, purchase_cost, currency, warranty_expires, eol_date, custom JSONB)
  EXCLUDE USING gist (rack_id WITH =, face_or_full WITH &&, int4range(position_u, position_u+u_height) WITH &&)
      → the database itself rejects overlapping equipment
device_components(id, device_id, kind ('cpu'|'dimm'|'disk'|'nic'|'psu'|…), slot, model, serial, attrs JSONB)
spare_parts(id, org_id, kind, model, quantity, location, min_quantity)
lifecycle_transitions(id, from_state, to_state, allowed bool, requires_permission)
device_events(id, device_id, kind ('moved'|'state'|'maintenance'|…), from JSONB, to JSONB, actor, at)
attachments(id, org_id, owner_type, owner_id, object_key, sha256, size, mime)
```

### Phase 3: network and IPAM (implemented)

Migrations `0005_network_ipam.sql` (tables) and `0006_network_constraints.sql` (triggers, GiST indexes).

| Table | Purpose and rules |
|---|---|
| `devices` (+ `platform`, `network_role`) | Platform selects suggested access methods |
| `interfaces` | Ports and logical interfaces. Unique `(device, lower(name))`. `lag_id`, `parent_id` self-references. Trigger `interfaces_check_relations`: same organization, LAG on the same device and of kind `lag`, no nested LAGs, parent on the same device, a cabled port can't become logical. `if_index` is informational (it changes across reboots); the stable key is the name |
| `interface_tagged_vlans` | Tagged VLAN membership; trigger refuses a VLAN that is also the port's untagged VLAN or belongs to another organization |
| `cables`, `cable_ends` | One row per end; `cable_ends.interface_id` unique (one cable per port) and `RESTRICT` (a cabled port can't be deleted). Deferred constraint triggers require exactly two ends at commit. A trigger checks both ends are physical/management ports in the cable's organization |
| `neighbor_observations` | LLDP/CDP/MNDP neighbors as last seen by discovery, with the matched interface when the neighbor is a known device |
| `vlans` | Unique `(org, coalesce(datacenter), vid)`, VID 1–4094 |
| `vrfs`, `providers`, `circuits`, `circuit_events` | Circuit IDs unique per provider (case-insensitive); one non-decommissioned circuit per interface; change history |
| `prefixes` | `cidr` column; unique `(org, coalesce(vrf), prefix)`; gateway must be inside the prefix; GiST `inet_ops` index for containment queries |
| `ip_addresses` | `inet` host addresses; unique `(org, coalesce(vrf), address)`; released rows keep their history and are reused on the next assignment; trigger keeps `device_id` in step with `interface_id` |
| `ip_events` | Per-address history (allocated, reserved, updated, released) |
| `device_credentials` | One per device and kind; `secret_enc` is AES-256-GCM with AAD `(org, device, kind, host, port)`; `params` holds non-secret settings |
| `discovery_runs` | Queued/running/succeeded/failed; partial unique index allows one active run per device; `result` holds the collected data |

Allocation: the API locks the prefix row (`SELECT … FOR UPDATE`), computes free addresses from the used addresses, child prefixes and gateway (BigInt arithmetic, so IPv6 works), and inserts with an `ON CONFLICT … DO UPDATE … WHERE` upsert that only takes over released or lapsed reservations. The unique index is the final guarantee: a conflicting insert can never succeed.

Migration `0007_network_schedule_dns.sql` adds:

| Table / column | Purpose and rules |
|---|---|
| `device_credentials.schedule_hours`, `next_run_at` | Automatic discovery interval (1–720 h); the worker claims due rows with `FOR UPDATE SKIP LOCKED` and moves `next_run_at` in the same transaction |
| `discovery_runs.trigger`, `changes` | `manual` or `schedule`; counts of differences from inventory computed when the run finishes |
| `dns_servers` | PowerDNS or Cloudflare; `secret_enc` bound to org, server row, kind and URL |
| `dns_zones` | Forward or reverse zone on a server; unique per organization; a trigger keeps the server in the same organization |
| `ip_addresses.dns_status`, `dns_error`, `dns_synced_at`, `dns_records` | `none / pending / syncing / synced / failed`, and the records DCIM created (so it only ever removes its own). Trigger `ip_addresses_dns_pending` marks an address pending when its name, PTR, status, address or VRF changes |

#### Original plan

```
interfaces(id, device_id, name, if_index NULL, stable_key, kind ('physical'|'lag'|'vlan'|'bridge'|
           'tunnel'|'loopback'|'virtual'|'mgmt'), media, mac, mtu, speed_bps_configured,
           parent_lag_id NULL, count_in_totals bool, monitored bool, description)
cables(id, a_interface_id, b_interface_id, source ('manual'|'lldp'|'cdp'), verified bool)
lldp_neighbors(id, interface_id, remote_chassis, remote_port, remote_name, seen_at)
vrfs(id, org_id, name, rd)
vlans(id, org_id, vid, name, group/site)
interface_vlans(interface_id, vlan_id, mode ('access'|'tagged'|'native'))
circuits(id, provider_id, circuit_id, commit_bps, interface_id, a/z ends, status)
prefixes(id, org_id, vrf_id NULL, prefix cidr, parent_id NULL, pool bool, gateway inet,
         vlan_id NULL, customer_id NULL, status)
  EXCLUDE USING gist (vrf_id WITH =, prefix inet_ops WITH =)     → no duplicate prefixes per VRF
ip_addresses(id, org_id, vrf_id, address inet, prefix_id, status ('available'|'reserved'|
             'allocated'|'released'), customer_id, device_id, interface_id, service_id,
             dns_name, reserved_until)
  UNIQUE (vrf_id, host(address))                                  → no conflicts
ip_allocation_history(id, ip_id, action, from_status, to_status, actor, at)
device_credentials(id, device_id, kind ('snmp_v2c'|'snmp_v3'|'redfish'|'ipmi'|'routeros'|
                   'fortigate'|'ssh'), secret_enc, attrs JSONB, rotated_at)
```

IP allocation runs in a serializable transaction with `SELECT … FOR UPDATE SKIP LOCKED` on candidate addresses, so concurrent reservations cannot hand out the same IP.


### Phase 4: network monitoring (implemented)

Migration `0008_monitoring.sql`.

**Deviation from the plan:** the plan named TimescaleDB hypertables and continuous aggregates. The target servers run stock PostgreSQL (Ubuntu 22.04 packages) and TimescaleDB is not installed, so Phase 4 uses plain tables: a raw table plus two rollup tables built by the worker, with retention by `DELETE`. Volumes this covers comfortably: 2,000 ports at 60 s is about 2.9 M raw rows a day (7-day default retention ≈ 20 M rows, indexed by `(interface_id, at)` and `at`). Moving to TimescaleDB later is a storage change only (same columns); the rollup and retention jobs would be replaced by continuous aggregates and retention policies.

| Table | Purpose and rules |
|---|---|
| `device_monitoring` | One row per polled device: credential kind, interval (30–3600 s, check constraint), `next_poll_at` (claimed with `FOR UPDATE SKIP LOCKED` and moved forward in the same statement), health (`last_ok_at`, `last_error`, `consecutive_failures`, duration, ports matched/reported). Trigger keeps it in the device's organization |
| `interface_counters` | Last raw reading per interface (`numeric(20)` counters, uptime, counter width, speed, oper state): the baseline for the next rate. Also the latest rate (or the reason there is none: `first`, `reset`, `gap`, `implausible`, …) for fast "now" views |
| `interface_rates` | One row per interface per successful poll: in/out bit/s, packets/s, errors/s, discards/s, utilization, speed, the seconds it covers, and flags (`wrap`, `speed_unknown`, `speed_changed`). PK `(interface_id, at)`. Default retention 7 days |
| `interface_rates_5m`, `interface_rates_1h` | Time-weighted averages (weighted by seconds covered), maxima, error rates, sample count and `covered_seconds` (so a partial bucket is visible as partial). Built by the worker every minute with idempotent upserts over recent buckets, catching up from the newest existing bucket after downtime. Defaults 90 days and 730 days |
| `monitoring_settings` | Retention per organization (raw 1–90 d, 5-minute 7–730 d, hourly 30–1825 d) |
| `alert_rules` | Metric, comparator, threshold, `for_seconds`, `min_samples`, `clear_samples`, severity, scope (all, totals, datacenter, devices, interfaces), notification channels |
| `alert_state` | Per (rule, target) streak: `breach_since`, `breach_count`, `clear_count`, last value and time |
| `alerts` | Firing and resolved alerts; partial unique index `(rule_id, target_key) WHERE status = 'firing'` so a target can't have two open alerts for one rule; `suppressed` when raised in maintenance; acknowledgement fields |
| `maintenance_windows` | Start/end (end after start, at most 31 days), scope all, datacenter or devices |
| `notification_channels` | Email (SMTP), signed webhook, Slack, Telegram. `config` holds non-secret settings; `secret_enc` is SecretBox ciphertext bound to organization, channel id and kind |
| `notifications` | Outbox: pending/sent/failed, attempts, `next_attempt_at` (exponential backoff, 6 attempts), last error. Sent and failed rows are deleted after 30 days |

### Phase 5: equipment power (implemented)

Migration `0009_power.sql` (adds `redfish` and `ipmi` to `credential_kind`).

| Table | Purpose and rules |
|---|---|
| `power_monitoring` | Power collection per device: credential kind, interval (30–3600 s), `next_poll_at` (claimed with `FOR UPDATE SKIP LOCKED`), health, last reading. Trigger keeps it in the device's organization |
| `power_profiles` | Admin estimate (W), include-in-totals flag, notes |
| `pdu_outlets` | Outlets of a metered PDU as reported (number, name, last watts and time), the device each one feeds and an admin label. Unique `(pdu, outlet number)`; a PDU cannot feed itself; organization checked by trigger for both ends |
| `power_readings` | Raw measured readings: PK `(device, source, at)`, watts, the polling period in force. Default retention 35 days |
| `power_hourly` | Per device and UTC hour: measured Wh and seconds (and the main source), estimated Wh and seconds with the estimate kind and value, unknown seconds, average and peak measured W, and the device's datacenter, rack, customer and category at the time. `counted` says whether it adds to totals. Default retention 1095 days |
| `power_tariffs` | Price per kWh with currency (ISO code) and start date, for the organization or one datacenter |
| `power_settings` | Retention per organization |
| `power_rollup_state` | How far the hourly rollup has got (lets it catch up after downtime without rescanning) |

### Phase 6: provisioning and virtualization (implemented)

Migration `0010_provisioning.sql`.

| Table | Purpose and rules |
|---|---|
| `control_credentials` | One per device: `redfish` or `ipmi`, host, port, user, params, encrypted password (AAD bound to org, device, kind, host, port). Separate from the read-only monitoring credentials |
| `os_images` | Name (unique per organization, case-insensitive), family, version, arch, ISO and kernel/initrd URLs each with SHA-256, kernel arguments, template kind and text, enabled, verification status (`unverified`, `verifying`, `verified`, `mismatch`, `error`), sizes |
| `provisioning_jobs` | Kind (`power_action`, `os_install`, `image_verify`, `guest_action`), status, target (device, VM or image), params (with the image files pinned at request time), working `state`, `signals` written only by the boot endpoints, encrypted job secret (root password hash and boot token, removed when the job ends), idempotency key and request hash, boot token hash and MAC (cleared when the job ends), current step, cancel flag, `next_run_at`, lease and worker id, deadline, result, error, requester |
| `provisioning_steps` | Per job and step: name, status (`pending`, `running`, `done`, `failed`, `skipped`), attempts, times, detail, error |
| `provisioning_events` | Job log lines with level |
| `virt_integrations` | Proxmox or Virtualizor endpoint, params (token ids), encrypted secrets, whether actions are allowed, sync interval and result |
| `virt_hosts` | Nodes / servers as reported, with an operator-set link to a DCIM device; `missing_since` instead of deletion |
| `virt_guests` | VMs as reported (status, size, uptime, addresses), customer assignment kept across syncs; `missing_since` instead of deletion |

Partial unique indexes enforce one active job per device, per VM, per boot MAC and per image verification, one job per idempotency key per organization, and unique boot-token hashes. Triggers keep every row in the organization of the device, image, integration or customer it references.

### Phase 7: colocation, services and tickets (implemented)

Migration `0011_colocation.sql`.

| Table | Purpose and rules |
|---|---|
| `services` | A customer's service: kind, name, description, status (`pending`, `active`, `suspended`, `cancelled`, `terminated`), dates, billing reference, optional server or VM, staff notes |
| `service_events` | Status and change history per service |
| `colo_allocations` | Rack space for a customer: kind (`full`, `half`, `quarter`, `custom`), part, U range, contracted power (W), feeds, breaker, voltage, start and end, optional service. While active its units are held by a `rack_reservations` row (`allocation_id`, unique) so the existing overlap constraint and placement rules apply |
| `cross_connects` | A side (customer device/port and label), Z side (text), LOA reference, media, speed, status (`requested` → `approved` → `in_progress` → `active` → `decommissioned`, or `rejected`), cross-connect id, optional documented cable |
| `shipments` | Inbound/outbound shipments per customer and datacenter: carrier, tracking, expected date, packages, status (`expected`, `received`, `delivered`, `shipped_out`, `cancelled`), storage location, condition note, who received it |
| `visits` | Site access: visitors (name, company, last characters of the ID number only), window, purpose, status (`requested`, `approved`, `denied`, `checked_in`, `checked_out`, `cancelled`), escort, badge |
| `tickets`, `ticket_counters` | Tickets with a per-organization number, kind, priority, status (`open`, `in_progress`, `waiting_customer`, `resolved`, `closed`), optional customer (none = internal), device, assignee (staff only, enforced by trigger), authorized remote-hands minutes |
| `ticket_messages` | Conversation; `internal` messages are never returned to customers; system lines record status changes |
| `ticket_time_entries` | Remote-hands work: minutes, note, billable flag |

A trigger (`colo_check_org`) keeps every row in the organization of the customer, rack, device, datacenter, service or user it references, and requires a linked service to belong to the same customer.

### Phase 8: billing, automation, reports and incidents (implemented)

Migration `0012_automation.sql`.

| Table | Purpose and rules |
|---|---|
| `domain_events` | Event bus: type, customer, subject, payload, `caused_by_run_id` (loop guard), `processed_at` (fan-out done). Written in the same transaction as the change |
| `api_keys` | Name, prefix (unique, for lookup), SHA-256 of the token, owner (staff, enforced by trigger), scopes, expiry, last use, revocation |
| `webhook_subscriptions`, `webhook_deliveries` | URL, event types, encrypted signing secret; one delivery per (subscription, event) (unique), with attempts, next attempt, response status and last error |
| `workflows`, `workflow_runs` | Trigger, conditions, actions, version and last editor; one run per (workflow, event) (unique), with the version it runs, next action, status, per-step log, approval decision and crash attempts |
| `billing_integrations`, `billing_product_mappings` | WHMCS integration with its encrypted shared secret and auto-create settings; product id → service kind |
| `billing_events` | Every received event once per (integration, event id) (unique), with outcome (`applied`, `ignored`, `review`, `rejected`) and message |
| `billing_reconciliations` | Snapshot comparisons: summary and differences |
| `report_schedules` | Report type, period, format, frequency, hour/weekday/day, email channel (must be an email channel of the organization, enforced by trigger), recipients, next and last run |
| `incidents`, `incident_updates` | Severity, status, affected site and customers, public flag; timeline of updates (public or internal) |

Also added: `maintenance_windows.customer_visible` and `description` (customer notice), `notifications.payload` (workflow notifications). A trigger (`automation_check_org`) keeps key owners, report channels, incident sites and workflow runs inside the organization.
