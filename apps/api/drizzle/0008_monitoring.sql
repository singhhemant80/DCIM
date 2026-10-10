CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('firing', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('email', 'webhook', 'slack', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metric" text NOT NULL,
	"comparator" text DEFAULT 'gt' NOT NULL,
	"threshold" double precision DEFAULT 0 NOT NULL,
	"for_seconds" integer DEFAULT 300 NOT NULL,
	"min_samples" integer DEFAULT 3 NOT NULL,
	"clear_samples" integer DEFAULT 2 NOT NULL,
	"severity" "alert_severity" DEFAULT 'warning' NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"datacenter_id" uuid,
	"device_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"interface_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"channel_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"notify_on_resolve" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_state" (
	"rule_id" uuid NOT NULL,
	"target_key" text NOT NULL,
	"org_id" uuid NOT NULL,
	"breach_since" timestamp with time zone,
	"breach_count" integer DEFAULT 0 NOT NULL,
	"clear_count" integer DEFAULT 0 NOT NULL,
	"last_value" double precision,
	"last_evaluated_at" timestamp with time zone,
	CONSTRAINT "alert_state_rule_id_target_key_pk" PRIMARY KEY("rule_id","target_key")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid,
	"rule_name" text NOT NULL,
	"metric" text NOT NULL,
	"target_key" text NOT NULL,
	"device_id" uuid,
	"interface_id" uuid,
	"severity" "alert_severity" NOT NULL,
	"status" "alert_status" DEFAULT 'firing' NOT NULL,
	"message" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"last_value" double precision,
	"peak_value" double precision,
	"suppressed" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	"ack_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_monitoring" (
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
	"last_matched" integer,
	"last_reported" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_monitoring_interval_ck" CHECK ("device_monitoring"."interval_seconds" between 30 and 3600)
);
--> statement-breakpoint
CREATE TABLE "interface_counters" (
	"interface_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"uptime_seconds" bigint,
	"in_octets" numeric(20, 0),
	"out_octets" numeric(20, 0),
	"in_pkts" numeric(20, 0),
	"out_pkts" numeric(20, 0),
	"in_errors" numeric(20, 0),
	"out_errors" numeric(20, 0),
	"in_discards" numeric(20, 0),
	"out_discards" numeric(20, 0),
	"counter_bits" smallint DEFAULT 64 NOT NULL,
	"error_bits" smallint DEFAULT 32 NOT NULL,
	"speed_bps" bigint,
	"oper_up" boolean,
	"last_rate_at" timestamp with time zone,
	"in_bps" double precision,
	"out_bps" double precision,
	"util_in" real,
	"util_out" real,
	"errors_ps" double precision,
	"discards_ps" double precision,
	"last_skip" text
);
--> statement-breakpoint
CREATE TABLE "interface_rates" (
	"interface_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"seconds" real NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"in_bps" double precision NOT NULL,
	"out_bps" double precision NOT NULL,
	"in_pps" double precision,
	"out_pps" double precision,
	"errors_ps" double precision,
	"discards_ps" double precision,
	"util_in" real,
	"util_out" real,
	"speed_bps" bigint,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "interface_rates_interface_id_at_pk" PRIMARY KEY("interface_id","at")
);
--> statement-breakpoint
CREATE TABLE "interface_rates_1h" (
	"interface_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"in_bps" double precision NOT NULL,
	"out_bps" double precision NOT NULL,
	"in_max" double precision NOT NULL,
	"out_max" double precision NOT NULL,
	"util_in_max" real,
	"util_out_max" real,
	"errors_ps" double precision,
	"discards_ps" double precision,
	"samples" integer NOT NULL,
	"covered_seconds" integer NOT NULL,
	CONSTRAINT "interface_rates_1h_interface_id_bucket_pk" PRIMARY KEY("interface_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "interface_rates_5m" (
	"interface_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"in_bps" double precision NOT NULL,
	"out_bps" double precision NOT NULL,
	"in_max" double precision NOT NULL,
	"out_max" double precision NOT NULL,
	"util_in_max" real,
	"util_out_max" real,
	"errors_ps" double precision,
	"discards_ps" double precision,
	"samples" integer NOT NULL,
	"covered_seconds" integer NOT NULL,
	CONSTRAINT "interface_rates_5m_interface_id_bucket_pk" PRIMARY KEY("interface_id","bucket")
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"scope" text DEFAULT 'devices' NOT NULL,
	"datacenter_id" uuid,
	"device_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_windows_time_ck" CHECK ("maintenance_windows"."ends_at" > "maintenance_windows"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "monitoring_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"raw_days" integer DEFAULT 7 NOT NULL,
	"five_minute_days" integer DEFAULT 90 NOT NULL,
	"hourly_days" integer DEFAULT 730 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"alert_id" uuid,
	"event" text NOT NULL,
	"status" "notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_state" ADD CONSTRAINT "alert_state_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_state" ADD CONSTRAINT "alert_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_monitoring" ADD CONSTRAINT "device_monitoring_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_monitoring" ADD CONSTRAINT "device_monitoring_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_counters" ADD CONSTRAINT "interface_counters_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_counters" ADD CONSTRAINT "interface_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_rates" ADD CONSTRAINT "interface_rates_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_rates" ADD CONSTRAINT "interface_rates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_rates_1h" ADD CONSTRAINT "interface_rates_1h_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_rates_1h" ADD CONSTRAINT "interface_rates_1h_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_rates_5m" ADD CONSTRAINT "interface_rates_5m_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interface_rates_5m" ADD CONSTRAINT "interface_rates_5m_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD CONSTRAINT "maintenance_windows_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_settings" ADD CONSTRAINT "monitoring_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD CONSTRAINT "notification_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_one_firing_uq" ON "alerts" USING btree ("rule_id","target_key") WHERE "alerts"."status" = 'firing';--> statement-breakpoint
CREATE INDEX "alerts_org_status_idx" ON "alerts" USING btree ("org_id","status","started_at");--> statement-breakpoint
CREATE INDEX "device_monitoring_due_idx" ON "device_monitoring" USING btree ("next_poll_at");--> statement-breakpoint
CREATE INDEX "interface_rates_at_idx" ON "interface_rates" USING btree ("at");--> statement-breakpoint
CREATE INDEX "interface_rates_1h_bucket_idx" ON "interface_rates_1h" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "interface_rates_5m_bucket_idx" ON "interface_rates_5m" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "maintenance_windows_org_time_idx" ON "maintenance_windows" USING btree ("org_id","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_channels_org_name_uq" ON "notification_channels" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "notifications_due_idx" ON "notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE TRIGGER device_monitoring_updated_at BEFORE UPDATE ON device_monitoring FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER alert_rules_updated_at BEFORE UPDATE ON alert_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER maintenance_windows_updated_at BEFORE UPDATE ON maintenance_windows FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER notification_channels_updated_at BEFORE UPDATE ON notification_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER monitoring_settings_updated_at BEFORE UPDATE ON monitoring_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Polling rows and counters always belong to the same organization as their device / interface.
CREATE OR REPLACE FUNCTION monitoring_check_org() RETURNS trigger AS $$
DECLARE
  o uuid;
BEGIN
  IF TG_TABLE_NAME = 'device_monitoring' THEN
    SELECT org_id INTO o FROM devices WHERE id = NEW.device_id;
  ELSE
    SELECT org_id INTO o FROM interfaces WHERE id = NEW.interface_id;
  END IF;
  IF o IS DISTINCT FROM NEW.org_id THEN
    RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'monitoring_org';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER device_monitoring_org BEFORE INSERT OR UPDATE OF device_id, org_id ON device_monitoring FOR EACH ROW EXECUTE FUNCTION monitoring_check_org();
--> statement-breakpoint
CREATE TRIGGER interface_counters_org BEFORE INSERT OR UPDATE OF interface_id, org_id ON interface_counters FOR EACH ROW EXECUTE FUNCTION monitoring_check_org();
