import { BadRequestException, ConflictException } from '@nestjs/common';

/** Postgres error codes we translate into HTTP errors. */
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const EXCLUSION_VIOLATION = '23P01';

interface PgErrorShape {
  code?: string;
  constraint?: string;
  message?: string;
  cause?: PgErrorShape;
}

function pgError(err: unknown): PgErrorShape | undefined {
  // drizzle wraps driver errors; the pg error is on `.cause`.
  const e = err as PgErrorShape;
  if (e?.cause?.code) return e.cause;
  if (e?.code) return e;
  return undefined;
}

function pgCode(err: unknown): string | undefined {
  return pgError(err)?.code;
}

export function pgConstraint(err: unknown): string | undefined {
  return pgError(err)?.constraint;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgCode(err) === UNIQUE_VIOLATION;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgCode(err) === FK_VIOLATION;
}

/** Re-throws unique violations as 409 with a caller-supplied message; everything else propagates unchanged. */
export function rethrowConflict(err: unknown, message: string): never {
  if (isUniqueViolation(err)) throw new ConflictException({ error: 'conflict', message });
  throw err;
}

/**
 * Messages for named constraints. Database-enforced rules (placement, capacity,
 * uniqueness, delete restrictions) surface as specific, actionable errors.
 */
const CONSTRAINT_MESSAGES: Record<string, { status: 400 | 409; error: string; message: string }> = {
  devices_no_overlap_front: { status: 409, error: 'placement_conflict', message: 'Those rack units are already occupied on the front face' },
  devices_no_overlap_rear: { status: 409, error: 'placement_conflict', message: 'Those rack units are already occupied on the rear face' },
  rack_reservations_no_overlap: { status: 409, error: 'reservation_conflict', message: 'That range overlaps an existing reservation' },
  devices_org_asset_tag_uq: { status: 409, error: 'conflict', message: 'Another device already uses this asset tag' },
  notification_channels_org_name_uq: { status: 409, error: 'duplicate_name', message: 'A notification channel with this name already exists' },
  devices_org_serial_uq: { status: 409, error: 'conflict', message: 'Another device already has this serial number' },
  datacenters_org_code_uq: { status: 409, error: 'conflict', message: 'A datacenter with this code already exists' },
  buildings_dc_name_uq: { status: 409, error: 'conflict', message: 'This datacenter already has a building with that name' },
  rooms_building_name_uq: { status: 409, error: 'conflict', message: 'This building already has a room with that name' },
  rack_rows_room_name_uq: { status: 409, error: 'conflict', message: 'This room already has a row with that name' },
  racks_room_name_uq: { status: 409, error: 'conflict', message: 'This room already has a rack with that name' },
  racks_room_grid_uq: { status: 409, error: 'conflict', message: 'Another rack already stands on that floor position' },
  manufacturers_org_name_uq: { status: 409, error: 'conflict', message: 'That manufacturer already exists' },
  device_models_mfr_name_uq: { status: 409, error: 'conflict', message: 'This manufacturer already has a model with that name' },
  spare_parts_org_dc_pn_uq: { status: 409, error: 'conflict', message: 'This part number is already stocked at that location' },
  spare_parts_qty_ck: { status: 409, error: 'insufficient_stock', message: 'Not enough stock for that change' },
  interfaces_device_name_uq: { status: 409, error: 'conflict', message: 'This device already has an interface with that name' },
  interfaces_not_self_ck: { status: 400, error: 'invalid_interface', message: 'An interface cannot be its own LAG or parent' },
  interfaces_mtu_ck: { status: 400, error: 'invalid_interface', message: 'MTU must be between 64 and 65535' },
  interfaces_speed_ck: { status: 400, error: 'invalid_interface', message: 'Speed must be greater than zero (leave it empty when unknown)' },
  cable_ends_interface_uq: { status: 409, error: 'port_in_use', message: 'One of those ports already has a cable' },
  cable_ends_interface_id_interfaces_id_fk: { status: 409, error: 'port_in_use', message: 'This port has a cable; remove the cable first' },
  vlans_scope_vid_uq: { status: 409, error: 'conflict', message: 'That VLAN ID is already used in this scope' },
  vrfs_org_name_uq: { status: 409, error: 'conflict', message: 'A VRF with this name already exists' },
  vrfs_org_rd_uq: { status: 409, error: 'conflict', message: 'Another VRF already uses this route distinguisher' },
  providers_org_name_uq: { status: 409, error: 'conflict', message: 'A provider with this name already exists' },
  circuits_provider_cid_uq: { status: 409, error: 'conflict', message: 'This provider already has a circuit with that ID' },
  circuits_interface_uq: { status: 409, error: 'port_in_use', message: 'Another active circuit already terminates on that port' },
  prefixes_vrf_prefix_uq: { status: 409, error: 'prefix_exists', message: 'That prefix already exists in this VRF' },
  prefixes_gateway_ck: { status: 400, error: 'invalid_gateway', message: 'The gateway must be an address inside the prefix' },
  ip_addresses_vrf_address_uq: { status: 409, error: 'address_in_use', message: 'That address is already reserved or allocated in this VRF' },
  ip_addresses_prefix_length_ck: { status: 400, error: 'invalid_prefix_length', message: 'Prefix length is out of range for this address family' },
  device_credentials_device_kind_uq: { status: 409, error: 'conflict', message: 'This device already has a credential of that type' },
  discovery_runs_one_active_uq: { status: 409, error: 'discovery_running', message: 'A collection is already queued or running for this device' },
  devices_sized_needs_position_ck: { status: 400, error: 'invalid_placement', message: 'Rack-mounted equipment needs a unit position' },
  devices_position_ck: { status: 400, error: 'invalid_placement', message: 'A placed device needs a rack, a unit and a face' },
  devices_ownership_ck: { status: 400, error: 'invalid_ownership', message: 'Customer-owned equipment must be assigned to a customer' },
  racks_grid_pair_ck: { status: 400, error: 'invalid_position', message: 'Give both floor coordinates or neither' },
};

/**
 * Translates database constraint failures into HTTP errors. Trigger-raised
 * check violations (rack fit, resize) carry their own human message.
 * Anything unrecognized is re-thrown unchanged.
 */
export function rethrowDbError(err: unknown, fallbacks: { fk?: string } = {}): never {
  const e = pgError(err);
  if (e) {
    const known = e.constraint ? CONSTRAINT_MESSAGES[e.constraint] : undefined;
    if (known) {
      const Ex = known.status === 409 ? ConflictException : BadRequestException;
      throw new Ex({ error: known.error, message: known.message });
    }
    if (e.code === CHECK_VIOLATION && e.constraint && /^(devices_fit|racks_resize|rack_reservations_fit|devices_rack_org|interfaces_|cable_ends_|cables_two_ends|interface_vlans_|ip_addresses_interface)/.test(e.constraint)) {
      throw new ConflictException({ error: e.constraint.startsWith('devices_') || e.constraint.startsWith('rack') ? 'does_not_fit' : 'invalid_relation', message: e.message ?? 'That change is not allowed' });
    }
    if (e.code === UNIQUE_VIOLATION) throw new ConflictException({ error: 'conflict', message: 'That record already exists' });
    if (e.code === EXCLUSION_VIOLATION) throw new ConflictException({ error: 'conflict', message: 'That overlaps an existing record' });
    if (e.code === FK_VIOLATION) {
      throw new ConflictException({ error: 'in_use', message: fallbacks.fk ?? 'This record is still referenced by other records' });
    }
  }
  throw err;
}
