-- Network integrity rules enforced by PostgreSQL.

-- 1. LAG membership and sub-interface parents stay on the same device; only a
--    LAG can have members; a LAG can't itself be a member; the interface's
--    organization matches its device's.
CREATE OR REPLACE FUNCTION interfaces_check_relations() RETURNS trigger AS $$
DECLARE
  dev_org uuid;
  other record;
BEGIN
  SELECT org_id INTO dev_org FROM devices WHERE id = NEW.device_id;
  IF dev_org IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'Interface organization does not match its device' USING ERRCODE = 'check_violation', CONSTRAINT = 'interfaces_device_org';
  END IF;
  IF NEW.lag_id IS NOT NULL THEN
    IF NEW.kind = 'lag' THEN
      RAISE EXCEPTION 'A LAG cannot be a member of another LAG' USING ERRCODE = 'check_violation', CONSTRAINT = 'interfaces_lag_nested';
    END IF;
    SELECT device_id, kind INTO other FROM interfaces WHERE id = NEW.lag_id;
    IF other.device_id IS DISTINCT FROM NEW.device_id THEN
      RAISE EXCEPTION 'LAG members must be on the same device as the LAG' USING ERRCODE = 'check_violation', CONSTRAINT = 'interfaces_lag_device';
    END IF;
    IF other.kind <> 'lag' THEN
      RAISE EXCEPTION 'Only a LAG interface can have member ports' USING ERRCODE = 'check_violation', CONSTRAINT = 'interfaces_lag_kind';
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT device_id INTO other FROM interfaces WHERE id = NEW.parent_id;
    IF other.device_id IS DISTINCT FROM NEW.device_id THEN
      RAISE EXCEPTION 'A sub-interface must be on the same device as its parent' USING ERRCODE = 'check_violation', CONSTRAINT = 'interfaces_parent_device';
    END IF;
  END IF;
  -- A port that already has members can't stop being a LAG.
  IF TG_OP = 'UPDATE' AND OLD.kind = 'lag' AND NEW.kind <> 'lag' AND EXISTS (SELECT 1 FROM interfaces WHERE lag_id = NEW.id) THEN
    RAISE EXCEPTION 'This LAG still has member ports' USING ERRCODE = 'check_violation', CONSTRAINT = 'interfaces_lag_kind';
  END IF;
  -- A cabled port must stay a physical or management port.
  IF TG_OP = 'UPDATE' AND NEW.kind NOT IN ('physical', 'management') AND EXISTS (SELECT 1 FROM cable_ends WHERE interface_id = NEW.id) THEN
    RAISE EXCEPTION 'This port has a cable; remove it before changing the port type' USING ERRCODE = 'check_violation', CONSTRAINT = 'cable_ends_kind';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER interfaces_relations BEFORE INSERT OR UPDATE ON interfaces
  FOR EACH ROW EXECUTE FUNCTION interfaces_check_relations();
--> statement-breakpoint

-- 2. Cables connect physical or management ports of the cable's organization,
--    and every cable has exactly two ends at commit time.
CREATE OR REPLACE FUNCTION cable_ends_check() RETURNS trigger AS $$
DECLARE
  i record;
  c_org uuid;
BEGIN
  SELECT kind, org_id INTO i FROM interfaces WHERE id = NEW.interface_id;
  SELECT org_id INTO c_org FROM cables WHERE id = NEW.cable_id;
  IF i.org_id IS DISTINCT FROM c_org THEN
    RAISE EXCEPTION 'Cable and port belong to different organizations' USING ERRCODE = 'check_violation', CONSTRAINT = 'cable_ends_org';
  END IF;
  IF i.kind NOT IN ('physical', 'management') THEN
    RAISE EXCEPTION 'Only physical or management ports can take a cable' USING ERRCODE = 'check_violation', CONSTRAINT = 'cable_ends_kind';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cable_ends_validate BEFORE INSERT OR UPDATE ON cable_ends
  FOR EACH ROW EXECUTE FUNCTION cable_ends_check();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION cables_check_two_ends() RETURNS trigger AS $$
DECLARE
  cids uuid[];
  cid uuid;
  n integer;
BEGIN
  -- NEW/OLD fields are only referenced in the branch for the right table and operation.
  IF TG_TABLE_NAME = 'cables' THEN
    cids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    cids := ARRAY[NEW.cable_id];
  ELSIF TG_OP = 'DELETE' THEN
    cids := ARRAY[OLD.cable_id];
  ELSE
    cids := ARRAY[OLD.cable_id, NEW.cable_id];
  END IF;
  FOREACH cid IN ARRAY cids LOOP
    IF EXISTS (SELECT 1 FROM cables WHERE id = cid) THEN -- a deleted cable's ends cascade away
      SELECT count(*) INTO n FROM cable_ends WHERE cable_id = cid;
      IF n <> 2 THEN
        RAISE EXCEPTION 'A cable must have exactly two ends (has %)', n USING ERRCODE = 'check_violation', CONSTRAINT = 'cables_two_ends';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER cables_two_ends AFTER INSERT ON cables
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cables_check_two_ends();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER cable_ends_two_ends AFTER INSERT OR UPDATE OR DELETE ON cable_ends
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cables_check_two_ends();
--> statement-breakpoint

-- 3. VLAN assignments stay inside the organization; an untagged VLAN is not also tagged.
CREATE OR REPLACE FUNCTION interface_vlans_check() RETURNS trigger AS $$
DECLARE
  i_org uuid;
  v_org uuid;
  untagged uuid;
BEGIN
  SELECT org_id, untagged_vlan_id INTO i_org, untagged FROM interfaces WHERE id = NEW.interface_id;
  SELECT org_id INTO v_org FROM vlans WHERE id = NEW.vlan_id;
  IF i_org IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'VLAN belongs to another organization' USING ERRCODE = 'check_violation', CONSTRAINT = 'interface_vlans_org';
  END IF;
  IF untagged = NEW.vlan_id THEN
    RAISE EXCEPTION 'A VLAN cannot be both untagged and tagged on the same port' USING ERRCODE = 'check_violation', CONSTRAINT = 'interface_vlans_untagged';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER interface_tagged_vlans_validate BEFORE INSERT OR UPDATE ON interface_tagged_vlans
  FOR EACH ROW EXECUTE FUNCTION interface_vlans_check();
--> statement-breakpoint

-- 4. An address bound to an interface belongs to that interface's device.
CREATE OR REPLACE FUNCTION ip_addresses_sync_device() RETURNS trigger AS $$
DECLARE
  dev uuid;
  i_org uuid;
BEGIN
  IF NEW.interface_id IS NOT NULL THEN
    SELECT device_id, org_id INTO dev, i_org FROM interfaces WHERE id = NEW.interface_id;
    IF i_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'Interface belongs to another organization' USING ERRCODE = 'check_violation', CONSTRAINT = 'ip_addresses_interface_org';
    END IF;
    IF NEW.device_id IS NOT NULL AND NEW.device_id <> dev THEN
      RAISE EXCEPTION 'That interface is on a different device' USING ERRCODE = 'check_violation', CONSTRAINT = 'ip_addresses_interface_device';
    END IF;
    NEW.device_id := dev;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ip_addresses_device BEFORE INSERT OR UPDATE ON ip_addresses
  FOR EACH ROW EXECUTE FUNCTION ip_addresses_sync_device();
--> statement-breakpoint

-- 5. Fast containment lookups.
CREATE INDEX prefixes_prefix_gist ON prefixes USING gist (prefix inet_ops);
--> statement-breakpoint
CREATE INDEX ip_addresses_address_gist ON ip_addresses USING gist (address inet_ops);
--> statement-breakpoint

-- 6. updated_at maintenance.
CREATE TRIGGER vrfs_updated_at BEFORE UPDATE ON vrfs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER vlans_updated_at BEFORE UPDATE ON vlans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER interfaces_updated_at BEFORE UPDATE ON interfaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER cables_updated_at BEFORE UPDATE ON cables FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER providers_updated_at BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER circuits_updated_at BEFORE UPDATE ON circuits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER prefixes_updated_at BEFORE UPDATE ON prefixes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER ip_addresses_updated_at BEFORE UPDATE ON ip_addresses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER device_credentials_updated_at BEFORE UPDATE ON device_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
