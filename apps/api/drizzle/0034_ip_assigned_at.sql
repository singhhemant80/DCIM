ALTER TABLE "ip_addresses" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
-- Backfill from the address history: the last change that gave it its current customer,
-- else its last allocation or reservation, else when it was recorded.
UPDATE "ip_addresses" a SET "assigned_at" = coalesce(
  (SELECT max(e.occurred_at) FROM "ip_events" e WHERE e.ip_id = a.id AND e.action = 'updated' AND e.data->'after'->>'customerId' = a.customer_id::text),
  (SELECT max(e.occurred_at) FROM "ip_events" e WHERE e.ip_id = a.id AND e.action IN ('allocated', 'reserved')),
  a.created_at)
WHERE a.customer_id IS NOT NULL;--> statement-breakpoint
-- Every writer (IPAM, imports, hypervisor syncs, VM customer changes) goes through this:
-- a new customer sets the date, no customer clears it.
CREATE OR REPLACE FUNCTION cdcim_ip_assigned_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.customer_id IS NULL THEN
    NEW.assigned_at := NULL;
  ELSIF TG_OP = 'INSERT' OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR OLD.status = 'released' THEN
    NEW.assigned_at := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER ip_addresses_assigned_at BEFORE INSERT OR UPDATE OF customer_id, status ON "ip_addresses" FOR EACH ROW EXECUTE FUNCTION cdcim_ip_assigned_at();
