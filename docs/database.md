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

### Phase 2: physical DCIM

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

### Phase 3: network and IPAM

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

### Phase 4: monitoring time-series (TimescaleDB)

```
iface_counter_samples(time, interface_id, in_octets, out_octets, in_pkts, out_pkts, in_err,
                      out_err, in_disc, out_disc, oper_status, speed_bps, sys_uptime_cs)
iface_rate_samples(time, interface_id, rx_bps, tx_bps, rx_util, tx_util, rx_pps, tx_pps,
                   quality ('ok'|'reset'|'wrap'|'gap'|'speed_unknown'))
iface_rate_5m / iface_rate_1h   continuous aggregates (avg, max, p95 inputs)
interface_status_events(time, interface_id, from, to)
poll_runs(time, device_id, ok, duration_ms, error)
alert_rules / alerts / alert_events / maintenance_windows / notification_channels
```

Retention: raw 7 days, 5-minute aggregates 90 days, 1-hour aggregates 2 years. All configurable.

### Phase 5: power

```
device_power_profiles(device_id, typical_w, idle_w, max_w, source ('admin'|'spec'|'model'),
                      source_note, preferred_telemetry)
power_readings(time, device_id, watts, source ('redfish'|'idrac'|'snmp'|'pdu'|'vendor'),
               quality)                                            -- hypertable
energy_daily(date, device_id, kwh, method ('integrated'|'estimated'), coverage_pct)
tariffs(id, org_id, currency, price_per_kwh, valid_from)
```

### Phases 6–8

`provisioning_jobs` (state machine with `state`, `attempt` and `idempotency_key` unique), `provisioning_steps`, `os_images` (checksum, status), `services`, `colocation_allocations`, `cross_connects`, `tickets`, `ticket_messages`, `billing_links` (WHMCS ids), `webhook_inbox` (unique `(source, event_id)` for idempotency), `webhook_subscriptions`, `webhook_deliveries`, `api_keys` (hashed, scoped), `workflows`, `workflow_runs`.
