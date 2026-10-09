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
    if (e.code === CHECK_VIOLATION && e.constraint && /^(devices_fit|racks_resize|rack_reservations_fit|devices_rack_org)/.test(e.constraint)) {
      throw new ConflictException({ error: 'does_not_fit', message: e.message ?? 'The change does not fit the rack' });
    }
    if (e.code === UNIQUE_VIOLATION) throw new ConflictException({ error: 'conflict', message: 'That record already exists' });
    if (e.code === EXCLUSION_VIOLATION) throw new ConflictException({ error: 'conflict', message: 'That overlaps an existing record' });
    if (e.code === FK_VIOLATION) {
      throw new ConflictException({ error: 'in_use', message: fallbacks.fk ?? 'This record is still referenced by other records' });
    }
  }
  throw err;
}
