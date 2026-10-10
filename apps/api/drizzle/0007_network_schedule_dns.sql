CREATE TYPE "public"."discovery_trigger" AS ENUM('manual', 'schedule');--> statement-breakpoint
CREATE TYPE "public"."dns_server_kind" AS ENUM('powerdns', 'cloudflare');--> statement-breakpoint
CREATE TYPE "public"."dns_sync_status" AS ENUM('none', 'pending', 'syncing', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dns_zone_kind" AS ENUM('forward', 'reverse');--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE 'routeros_api';--> statement-breakpoint
CREATE TABLE "dns_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "dns_server_kind" NOT NULL,
	"url" text,
	"server_id" text,
	"verify_tls" boolean DEFAULT true NOT NULL,
	"secret_enc" text NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "dns_zone_kind" NOT NULL,
	"provider_zone_id" text,
	"ttl" integer DEFAULT 3600 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_zones_ttl_ck" CHECK ("dns_zones"."ttl" between 60 and 604800)
);
--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "schedule_hours" integer;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "next_run_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "trigger" "discovery_trigger" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "discovery_runs" ADD COLUMN "changes" jsonb;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD COLUMN "dns_status" "dns_sync_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD COLUMN "dns_error" text;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD COLUMN "dns_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD COLUMN "dns_records" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dns_servers" ADD CONSTRAINT "dns_servers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_server_id_dns_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."dns_servers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dns_servers_org_name_uq" ON "dns_servers" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "dns_zones_org_name_uq" ON "dns_zones" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "device_credentials_next_run_idx" ON "device_credentials" USING btree ("next_run_at");--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_schedule_ck" CHECK ("device_credentials"."schedule_hours" is null or "device_credentials"."schedule_hours" between 1 and 720);--> statement-breakpoint
CREATE TRIGGER dns_servers_updated_at BEFORE UPDATE ON dns_servers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER dns_zones_updated_at BEFORE UPDATE ON dns_zones FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- A zone's server must be in the same organization.
CREATE OR REPLACE FUNCTION dns_zones_check_org() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dns_servers s WHERE s.id = NEW.server_id AND s.org_id = NEW.org_id) THEN
    RAISE EXCEPTION 'DNS server belongs to another organization' USING ERRCODE = 'check_violation', CONSTRAINT = 'dns_zones_org';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER dns_zones_validate BEFORE INSERT OR UPDATE ON dns_zones FOR EACH ROW EXECUTE FUNCTION dns_zones_check_org();
--> statement-breakpoint
-- DNS: an address whose name, status or address changes is marked for the
-- worker to push (only when the organization has an enabled zone, or the
-- address still has records DCIM created that may need removing).
CREATE OR REPLACE FUNCTION ip_addresses_dns_pending() RETURNS trigger AS $$
DECLARE
  has_zone boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.dns_name, NEW.reverse_dns, NEW.status, NEW.address, NEW.vrf_id)
       IS NOT DISTINCT FROM (OLD.dns_name, OLD.reverse_dns, OLD.status, OLD.address, OLD.vrf_id) THEN
    RETURN NEW;
  END IF;
  SELECT EXISTS (SELECT 1 FROM dns_zones z WHERE z.org_id = NEW.org_id AND z.enabled) INTO has_zone;
  IF has_zone AND (NEW.dns_name IS NOT NULL OR NEW.reverse_dns IS NOT NULL OR jsonb_array_length(NEW.dns_records) > 0) THEN
    NEW.dns_status := 'pending';
    NEW.dns_error := NULL;
  ELSIF jsonb_array_length(NEW.dns_records) = 0 THEN
    NEW.dns_status := 'none';
    NEW.dns_error := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ip_addresses_dns_pending BEFORE INSERT OR UPDATE ON ip_addresses FOR EACH ROW EXECUTE FUNCTION ip_addresses_dns_pending();
--> statement-breakpoint
CREATE INDEX ip_addresses_dns_pending_idx ON ip_addresses (updated_at) WHERE dns_status = 'pending';
