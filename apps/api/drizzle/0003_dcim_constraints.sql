-- Placement integrity for racks, enforced by PostgreSQL so no code path
-- (API, import, future workers, manual SQL) can create an impossible rack.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- 1. No two devices may occupy the same rack unit on the same face.
--    Full-depth devices occupy both faces; half-depth devices only the face they are mounted on.
ALTER TABLE devices ADD CONSTRAINT devices_no_overlap_front
  EXCLUDE USING gist (rack_id WITH =, u_range WITH &&) WHERE (occupies_front);
--> statement-breakpoint
ALTER TABLE devices ADD CONSTRAINT devices_no_overlap_rear
  EXCLUDE USING gist (rack_id WITH =, u_range WITH &&) WHERE (occupies_rear);
--> statement-breakpoint

-- 2. Reservations in one rack may not overlap each other.
ALTER TABLE rack_reservations ADD CONSTRAINT rack_reservations_no_overlap
  EXCLUDE USING gist (rack_id WITH =, u_range WITH &&);
--> statement-breakpoint

-- 3. A placed device must fit inside its rack (height and depth) and belong to the same organization.
CREATE OR REPLACE FUNCTION devices_check_rack_fit() RETURNS trigger AS $$
DECLARE
  r racks%ROWTYPE;
  model_depth integer;
BEGIN
  IF NEW.rack_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM racks WHERE id = NEW.rack_id;
  IF r.org_id <> NEW.org_id THEN
    RAISE EXCEPTION 'Rack belongs to another organization' USING ERRCODE = 'check_violation', CONSTRAINT = 'devices_rack_org';
  END IF;
  IF NEW.position_u IS NOT NULL THEN
    IF NEW.position_u + NEW.u_height - 1 > r.u_height THEN
      RAISE EXCEPTION 'Device does not fit: units %-% exceed rack height %U', NEW.position_u, NEW.position_u + NEW.u_height - 1, r.u_height
        USING ERRCODE = 'check_violation', CONSTRAINT = 'devices_fit_height';
    END IF;
    SELECT depth_mm INTO model_depth FROM device_models WHERE id = NEW.model_id;
    IF model_depth IS NOT NULL AND model_depth > r.depth_mm THEN
      RAISE EXCEPTION 'Device is % mm deep but the rack only takes % mm', model_depth, r.depth_mm
        USING ERRCODE = 'check_violation', CONSTRAINT = 'devices_fit_depth';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER devices_rack_fit BEFORE INSERT OR UPDATE OF rack_id, position_u, u_height, model_id, org_id ON devices
  FOR EACH ROW EXECUTE FUNCTION devices_check_rack_fit();
--> statement-breakpoint

-- 4. A rack cannot be shrunk below its placed equipment or made shallower than it.
CREATE OR REPLACE FUNCTION racks_check_resize() RETURNS trigger AS $$
BEGIN
  IF NEW.u_height < OLD.u_height AND EXISTS (
    SELECT 1 FROM devices WHERE rack_id = NEW.id AND position_u IS NOT NULL AND position_u + u_height - 1 > NEW.u_height
  ) THEN
    RAISE EXCEPTION 'Rack has equipment above U%', NEW.u_height USING ERRCODE = 'check_violation', CONSTRAINT = 'racks_resize_height';
  END IF;
  IF NEW.depth_mm < OLD.depth_mm AND EXISTS (
    SELECT 1 FROM devices d JOIN device_models m ON m.id = d.model_id
    WHERE d.rack_id = NEW.id AND d.position_u IS NOT NULL AND m.depth_mm > NEW.depth_mm
  ) THEN
    RAISE EXCEPTION 'Rack holds equipment deeper than % mm', NEW.depth_mm USING ERRCODE = 'check_violation', CONSTRAINT = 'racks_resize_depth';
  END IF;
  IF NEW.u_height < OLD.u_height AND EXISTS (
    SELECT 1 FROM rack_reservations WHERE rack_id = NEW.id AND end_u > NEW.u_height
  ) THEN
    RAISE EXCEPTION 'Rack has reservations above U%', NEW.u_height USING ERRCODE = 'check_violation', CONSTRAINT = 'racks_resize_height';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER racks_resize BEFORE UPDATE OF u_height, depth_mm ON racks
  FOR EACH ROW EXECUTE FUNCTION racks_check_resize();
--> statement-breakpoint

-- 5. Reservations must lie inside the rack.
CREATE OR REPLACE FUNCTION rack_reservations_check_fit() RETURNS trigger AS $$
DECLARE h integer;
BEGIN
  SELECT u_height INTO h FROM racks WHERE id = NEW.rack_id;
  IF NEW.end_u > h THEN
    RAISE EXCEPTION 'Reservation ends at U% but the rack has % units', NEW.end_u, h USING ERRCODE = 'check_violation', CONSTRAINT = 'rack_reservations_fit';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER rack_reservations_fit BEFORE INSERT OR UPDATE ON rack_reservations
  FOR EACH ROW EXECUTE FUNCTION rack_reservations_check_fit();
--> statement-breakpoint

-- 6. Keep updated_at honest on the new tables.
CREATE TRIGGER datacenters_updated_at BEFORE UPDATE ON datacenters FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER buildings_updated_at BEFORE UPDATE ON buildings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER rooms_updated_at BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER racks_updated_at BEFORE UPDATE ON racks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER device_models_updated_at BEFORE UPDATE ON device_models FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER devices_updated_at BEFORE UPDATE ON devices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER spare_parts_updated_at BEFORE UPDATE ON spare_parts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
