CREATE TYPE "public"."power_source" AS ENUM('pdu_outlet', 'redfish', 'ipmi', 'nxos', 'routeros', 'snmp');--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE IF NOT EXISTS 'redfish';--> statement-breakpoint
ALTER TYPE "public"."credential_kind" ADD VALUE IF NOT EXISTS 'ipmi';--> statement-breakpoint
CREATE TABLE "pdu_outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pdu_device_id" uuid NOT NULL,
	"outlet_number" integer NOT NULL,
	"name" text,
	"label" text,
	"device_id" uuid,
	"last_watts" real,
	"last_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pdu_outlets_not_self_ck" CHECK ("pdu_outlets"."device_id" is distinct from "pdu_outlets"."pdu_device_id")
);
--> statement-breakpoint
CREATE TABLE "power_hourly" (
	"device_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"org_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"rack_id" uuid,
	"customer_id" uuid,
	"category" text NOT NULL,
	"counted" boolean NOT NULL,
	"source" "power_source",
	"measured_wh" double precision DEFAULT 0 NOT NULL,
	"measured_seconds" integer DEFAULT 0 NOT NULL,
	"estimated_wh" double precision DEFAULT 0 NOT NULL,
	"estimated_seconds" integer DEFAULT 0 NOT NULL,
	"estimate_kind" text,
	"estimate_w" real,
	"unknown_seconds" integer DEFAULT 0 NOT NULL,
	"avg_measured_w" real,
	"max_measured_w" real,
	"samples" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "power_hourly_device_id_hour_pk" PRIMARY KEY("device_id","hour")
);
--> statement-breakpoint
CREATE TABLE "power_monitoring" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credential_kind" "credential_kind" NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"last_poll_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_duration_ms" integer,
	"last_watts" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "power_monitoring_interval_ck" CHECK ("power_monitoring"."interval_seconds" between 30 and 3600)
);
--> statement-breakpoint
CREATE TABLE "power_profiles" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"estimate_w" integer,
	"include_in_totals" boolean DEFAULT true NOT NULL,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "power_readings" (
	"device_id" uuid NOT NULL,
	"source" "power_source" NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"org_id" uuid NOT NULL,
	"watts" real NOT NULL,
	"period_seconds" integer NOT NULL,
	CONSTRAINT "power_readings_device_id_source_at_pk" PRIMARY KEY("device_id","source","at")
);
--> statement-breakpoint
CREATE TABLE "power_rollup_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"rolled_to" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "power_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"raw_days" integer DEFAULT 35 NOT NULL,
	"hourly_days" integer DEFAULT 1095 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "power_tariffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"price_per_kwh" numeric(14, 6) NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "power_tariffs_price_ck" CHECK ("power_tariffs"."price_per_kwh" > 0),
	CONSTRAINT "power_tariffs_currency_ck" CHECK ("power_tariffs"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "pdu_outlets" ADD CONSTRAINT "pdu_outlets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdu_outlets" ADD CONSTRAINT "pdu_outlets_pdu_device_id_devices_id_fk" FOREIGN KEY ("pdu_device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdu_outlets" ADD CONSTRAINT "pdu_outlets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_hourly" ADD CONSTRAINT "power_hourly_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_hourly" ADD CONSTRAINT "power_hourly_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_monitoring" ADD CONSTRAINT "power_monitoring_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_monitoring" ADD CONSTRAINT "power_monitoring_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_profiles" ADD CONSTRAINT "power_profiles_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_profiles" ADD CONSTRAINT "power_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_readings" ADD CONSTRAINT "power_readings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_readings" ADD CONSTRAINT "power_readings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_settings" ADD CONSTRAINT "power_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_tariffs" ADD CONSTRAINT "power_tariffs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_tariffs" ADD CONSTRAINT "power_tariffs_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pdu_outlets_pdu_number_uq" ON "pdu_outlets" USING btree ("pdu_device_id","outlet_number");--> statement-breakpoint
CREATE INDEX "pdu_outlets_device_idx" ON "pdu_outlets" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "power_hourly_org_hour_idx" ON "power_hourly" USING btree ("org_id","hour");--> statement-breakpoint
CREATE INDEX "power_monitoring_due_idx" ON "power_monitoring" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "power_readings_at_idx" ON "power_readings" USING btree ("at");--> statement-breakpoint
CREATE INDEX "power_tariffs_org_idx" ON "power_tariffs" USING btree ("org_id","valid_from");--> statement-breakpoint
CREATE TRIGGER power_monitoring_updated_at BEFORE UPDATE ON power_monitoring FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER power_profiles_updated_at BEFORE UPDATE ON power_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER pdu_outlets_updated_at BEFORE UPDATE ON pdu_outlets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER power_tariffs_updated_at BEFORE UPDATE ON power_tariffs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER power_settings_updated_at BEFORE UPDATE ON power_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Power rows always stay inside the organization of the devices / datacenter they reference.
CREATE OR REPLACE FUNCTION power_check_org() RETURNS trigger AS $$
DECLARE
  o uuid;
BEGIN
  IF TG_TABLE_NAME IN ('power_monitoring', 'power_profiles') THEN
    SELECT org_id INTO o FROM devices WHERE id = NEW.device_id;
  ELSIF TG_TABLE_NAME = 'pdu_outlets' THEN
    SELECT org_id INTO o FROM devices WHERE id = NEW.pdu_device_id;
    IF o IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'power_org';
    END IF;
    IF NEW.device_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT org_id INTO o FROM devices WHERE id = NEW.device_id;
  ELSIF TG_TABLE_NAME = 'power_tariffs' THEN
    IF NEW.datacenter_id IS NULL THEN
      RETURN NEW;
    END IF;
    SELECT org_id INTO o FROM datacenters WHERE id = NEW.datacenter_id;
  END IF;
  IF o IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'power_org';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER power_monitoring_org BEFORE INSERT OR UPDATE OF device_id, org_id ON power_monitoring FOR EACH ROW EXECUTE FUNCTION power_check_org();
--> statement-breakpoint
CREATE TRIGGER power_profiles_org BEFORE INSERT OR UPDATE OF device_id, org_id ON power_profiles FOR EACH ROW EXECUTE FUNCTION power_check_org();
--> statement-breakpoint
CREATE TRIGGER pdu_outlets_org BEFORE INSERT OR UPDATE OF pdu_device_id, device_id, org_id ON pdu_outlets FOR EACH ROW EXECUTE FUNCTION power_check_org();
--> statement-breakpoint
CREATE TRIGGER power_tariffs_org BEFORE INSERT OR UPDATE OF datacenter_id, org_id ON power_tariffs FOR EACH ROW EXECUTE FUNCTION power_check_org();
