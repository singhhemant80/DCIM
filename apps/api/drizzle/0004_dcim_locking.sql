-- Close a write-skew window found in review: the fit check read the rack
-- without a lock, so a concurrent rack shrink and device placement could both
-- pass. FOR SHARE makes the placement wait for (and then see) a concurrent
-- rack change, and makes the rack change wait for the placement to commit.
CREATE OR REPLACE FUNCTION devices_check_rack_fit() RETURNS trigger AS $$
DECLARE
  r racks%ROWTYPE;
  model_depth integer;
BEGIN
  IF NEW.rack_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO r FROM racks WHERE id = NEW.rack_id FOR SHARE;
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
-- A device with a size but no unit is never valid in a rack, except 0U equipment.
ALTER TABLE devices ADD CONSTRAINT devices_sized_needs_position_ck
  CHECK (rack_id IS NULL OR u_height = 0 OR position_u IS NOT NULL);
