# Database design

PostgreSQL 16. The schema is defined in [`apps/api/src/db/schema.ts`](../apps/api/src/db/schema.ts) (Drizzle ORM), and SQL migrations are checked in under [`apps/api/drizzle/`](../apps/api/drizzle). High-frequency telemetry (Phase 4+) goes into TimescaleDB hypertables in the same database, so one backup covers everything and joins to inventory stay simple.

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

