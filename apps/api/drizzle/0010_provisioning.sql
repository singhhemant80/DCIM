CREATE TYPE "public"."bmc_kind" AS ENUM('redfish', 'ipmi');--> statement-breakpoint
CREATE TYPE "public"."image_verify_status" AS ENUM('unverified', 'verifying', 'verified', 'mismatch', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('power_action', 'os_install', 'image_verify', 'guest_action');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'waiting', 'verifying', 'completed', 'failed', 'cancelled', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."job_step_status" AS ENUM('pending', 'running', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."virt_kind" AS ENUM('proxmox', 'virtualizor');--> statement-breakpoint
CREATE TABLE "control_credentials" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "bmc_kind" NOT NULL,
	"host" text NOT NULL,
	"port" integer,
	"username" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_test_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "os_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"family" text NOT NULL,
	"version" text,
	"arch" text DEFAULT 'x86_64' NOT NULL,
	"iso_url" text,
	"iso_sha256" text,
	"kernel_url" text,
	"kernel_sha256" text,
	"initrd_url" text,
	"initrd_sha256" text,
	"boot_args" text,
	"template_kind" text DEFAULT 'none' NOT NULL,
	"template" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"verify_status" "image_verify_status" DEFAULT 'unverified' NOT NULL,
	"verified_at" timestamp with time zone,
	"verify_error" text,
	"sizes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "provisioning_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"device_id" uuid,
	"guest_id" uuid,
	"image_id" uuid,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"idempotency_key" text,
	"request_hash" text,
	"boot_token_hash" text,
	"boot_mac" text,
	"current_step" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"worker_id" text,
	"deadline_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	"created_by" text,
	"created_by_user_id" uuid,
	"customer_request" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_steps" (
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"name" text NOT NULL,
	"status" "job_step_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"detail" text,
	"error" text,
	CONSTRAINT "provisioning_steps_job_id_seq_pk" PRIMARY KEY("job_id","seq")
);
--> statement-breakpoint
CREATE TABLE "virt_guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"host_id" uuid,
	"external_id" text NOT NULL,
	"virt_type" text,
	"name" text NOT NULL,
	"status" text,
	"cpus" integer,
	"mem_bytes" bigint,
	"disk_bytes" bigint,
	"uptime_seconds" bigint,
	"ip_addresses" text[] DEFAULT '{}'::text[] NOT NULL,
	"customer_id" uuid,
	"last_seen_at" timestamp with time zone,
	"missing_since" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "virt_hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text,
	"cpu_pct" real,
	"cpus" integer,
	"mem_used" bigint,
	"mem_total" bigint,
	"uptime_seconds" bigint,
	"device_id" uuid,
	"last_seen_at" timestamp with time zone,
	"missing_since" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "virt_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "virt_kind" NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"verify_tls" boolean DEFAULT true NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text NOT NULL,
	"actions_enabled" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sync_minutes" integer DEFAULT 5 NOT NULL,
	"next_sync_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_ok" boolean,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_credentials" ADD CONSTRAINT "control_credentials_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_credentials" ADD CONSTRAINT "control_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "os_images" ADD CONSTRAINT "os_images_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_events" ADD CONSTRAINT "provisioning_events_job_id_provisioning_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."provisioning_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_jobs" ADD CONSTRAINT "provisioning_jobs_image_id_os_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."os_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_steps" ADD CONSTRAINT "provisioning_steps_job_id_provisioning_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."provisioning_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virt_guests" ADD CONSTRAINT "virt_guests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virt_guests" ADD CONSTRAINT "virt_guests_integration_id_virt_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."virt_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virt_guests" ADD CONSTRAINT "virt_guests_host_id_virt_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."virt_hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virt_guests" ADD CONSTRAINT "virt_guests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virt_hosts" ADD CONSTRAINT "virt_hosts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virt_hosts" ADD CONSTRAINT "virt_hosts_integration_id_virt_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."virt_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virt_hosts" ADD CONSTRAINT "virt_hosts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "virt_integrations" ADD CONSTRAINT "virt_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "os_images_org_name_uq" ON "os_images" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "provisioning_events_job_idx" ON "provisioning_events" USING btree ("job_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_jobs_idem_uq" ON "provisioning_jobs" USING btree ("org_id","idempotency_key") WHERE "provisioning_jobs"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_jobs_device_active_uq" ON "provisioning_jobs" USING btree ("device_id") WHERE "provisioning_jobs"."device_id" is not null and "provisioning_jobs"."status" in ('queued','running','waiting','verifying','recovery');--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_jobs_guest_active_uq" ON "provisioning_jobs" USING btree ("guest_id") WHERE "provisioning_jobs"."guest_id" is not null and "provisioning_jobs"."status" in ('queued','running','waiting','verifying','recovery');--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_jobs_boot_token_uq" ON "provisioning_jobs" USING btree ("boot_token_hash") WHERE "provisioning_jobs"."boot_token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_jobs_mac_active_uq" ON "provisioning_jobs" USING btree ("boot_mac") WHERE "provisioning_jobs"."boot_mac" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_jobs_image_verify_active_uq" ON "provisioning_jobs" USING btree ("image_id") WHERE "provisioning_jobs"."kind" = 'image_verify' and "provisioning_jobs"."status" in ('queued','running','waiting','verifying','recovery');--> statement-breakpoint
CREATE INDEX "provisioning_jobs_due_idx" ON "provisioning_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "provisioning_jobs_org_idx" ON "provisioning_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "virt_guests_ext_uq" ON "virt_guests" USING btree ("integration_id","external_id");--> statement-breakpoint
CREATE INDEX "virt_guests_customer_idx" ON "virt_guests" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "virt_hosts_ext_uq" ON "virt_hosts" USING btree ("integration_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "virt_integrations_org_name_uq" ON "virt_integrations" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE TRIGGER control_credentials_updated_at BEFORE UPDATE ON control_credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER os_images_updated_at BEFORE UPDATE ON os_images FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER provisioning_jobs_updated_at BEFORE UPDATE ON provisioning_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER virt_integrations_updated_at BEFORE UPDATE ON virt_integrations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Every row stays in the organization of the device, image, integration or customer it references.
CREATE OR REPLACE FUNCTION provisioning_check_org() RETURNS trigger AS $$
DECLARE
  o uuid;
BEGIN
  IF TG_TABLE_NAME = 'control_credentials' THEN
    SELECT org_id INTO o FROM devices WHERE id = NEW.device_id;
    IF o IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'provisioning_org'; END IF;
  ELSIF TG_TABLE_NAME = 'provisioning_jobs' THEN
    IF NEW.device_id IS NOT NULL THEN
      SELECT org_id INTO o FROM devices WHERE id = NEW.device_id;
      IF o IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'provisioning_org'; END IF;
    END IF;
    IF NEW.image_id IS NOT NULL THEN
      SELECT org_id INTO o FROM os_images WHERE id = NEW.image_id;
      IF o IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'provisioning_org'; END IF;
    END IF;
    IF NEW.guest_id IS NOT NULL THEN
      SELECT org_id INTO o FROM virt_guests WHERE id = NEW.guest_id;
      IF o IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'provisioning_org'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME IN ('virt_hosts', 'virt_guests') THEN
    SELECT org_id INTO o FROM virt_integrations WHERE id = NEW.integration_id;
    IF o IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'provisioning_org'; END IF;
    -- Nested IFs: PL/pgSQL does not short-circuit AND, and each table lacks the other's column.
    IF TG_TABLE_NAME = 'virt_hosts' THEN
      IF NEW.device_id IS NOT NULL THEN
        SELECT org_id INTO o FROM devices WHERE id = NEW.device_id;
        IF o IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'provisioning_org'; END IF;
      END IF;
    ELSE
      IF NEW.customer_id IS NOT NULL THEN
        SELECT org_id INTO o FROM customers WHERE id = NEW.customer_id;
        IF o IS DISTINCT FROM NEW.org_id THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'provisioning_org'; END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER control_credentials_org BEFORE INSERT OR UPDATE ON control_credentials FOR EACH ROW EXECUTE FUNCTION provisioning_check_org();
--> statement-breakpoint
CREATE TRIGGER provisioning_jobs_org BEFORE INSERT OR UPDATE OF org_id, device_id, image_id, guest_id ON provisioning_jobs FOR EACH ROW EXECUTE FUNCTION provisioning_check_org();
--> statement-breakpoint
CREATE TRIGGER virt_hosts_org BEFORE INSERT OR UPDATE OF org_id, integration_id, device_id ON virt_hosts FOR EACH ROW EXECUTE FUNCTION provisioning_check_org();
--> statement-breakpoint
CREATE TRIGGER virt_guests_org BEFORE INSERT OR UPDATE OF org_id, integration_id, customer_id ON virt_guests FOR EACH ROW EXECUTE FUNCTION provisioning_check_org();
--> statement-breakpoint
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_guest_fk FOREIGN KEY (guest_id) REFERENCES virt_guests(id) ON DELETE SET NULL;
