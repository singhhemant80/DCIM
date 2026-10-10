CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"integration_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"customer_id" uuid,
	"service_id" uuid
);
--> statement-breakpoint
CREATE TABLE "billing_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text DEFAULT 'whmcs' NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"secret_enc" text NOT NULL,
	"auto_create_customers" boolean DEFAULT true NOT NULL,
	"auto_create_services" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_product_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"kind" "service_kind" NOT NULL,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "billing_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"summary" jsonb NOT NULL,
	"items" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"customer_id" uuid,
	"subject_type" text,
	"subject_id" text,
	"payload" jsonb NOT NULL,
	"caused_by_run_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incident_updates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"incident_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"author" text
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'investigating' NOT NULL,
	"datacenter_id" uuid,
	"customer_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"period" text NOT NULL,
	"format" text NOT NULL,
	"frequency" text NOT NULL,
	"hour" integer NOT NULL,
	"weekday" integer,
	"day_of_month" integer,
	"channel_id" uuid NOT NULL,
	"recipients" text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"event_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_status" integer,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"secret_enc" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version" integer NOT NULL,
	"event_id" bigint NOT NULL,
	"status" text NOT NULL,
	"next_action" integer DEFAULT 0 NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"trigger" text NOT NULL,
	"conditions" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" uuid,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "customer_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_integration_id_billing_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."billing_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_integrations" ADD CONSTRAINT "billing_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_product_mappings" ADD CONSTRAINT "billing_product_mappings_integration_id_billing_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."billing_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_reconciliations" ADD CONSTRAINT "billing_reconciliations_integration_id_billing_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."billing_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_updates" ADD CONSTRAINT "incident_updates_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."notification_channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_webhook_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."webhook_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_subscriptions" ADD CONSTRAINT "webhook_subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_event_id_domain_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."domain_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_prefix_uq" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_event_uq" ON "billing_events" USING btree ("integration_id","event_id");--> statement-breakpoint
CREATE INDEX "billing_events_integration_idx" ON "billing_events" USING btree ("integration_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_integrations_org_name_uq" ON "billing_integrations" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "billing_product_mappings_uq" ON "billing_product_mappings" USING btree ("integration_id","product_id");--> statement-breakpoint
CREATE INDEX "domain_events_pending_idx" ON "domain_events" USING btree ("id") WHERE "domain_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "domain_events_org_idx" ON "domain_events" USING btree ("org_id","id");--> statement-breakpoint
CREATE INDEX "incident_updates_incident_idx" ON "incident_updates" USING btree ("incident_id","id");--> statement-breakpoint
CREATE INDEX "incidents_org_idx" ON "incidents" USING btree ("org_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_sub_event_uq" ON "webhook_deliveries" USING btree ("subscription_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_subscriptions_org_name_uq" ON "webhook_subscriptions" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_event_uq" ON "workflow_runs" USING btree ("workflow_id","event_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_org_idx" ON "workflow_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_due_idx" ON "workflow_runs" USING btree ("created_at") WHERE "workflow_runs"."status" in ('pending', 'approved');--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_org_name_uq" ON "workflows" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "workflows_trigger_idx" ON "workflows" USING btree ("org_id","trigger");
--> statement-breakpoint
CREATE TRIGGER webhook_subscriptions_updated_at BEFORE UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER billing_integrations_updated_at BEFORE UPDATE ON billing_integrations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER workflows_updated_at BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER report_schedules_updated_at BEFORE UPDATE ON report_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER incidents_updated_at BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- References stay inside the organization (API key owners must be staff).
CREATE OR REPLACE FUNCTION automation_check_org() RETURNS trigger AS $$
DECLARE
  bad boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'api_keys' THEN
    bad := NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.owner_user_id AND org_id = NEW.org_id AND user_type = 'staff');
  ELSIF TG_TABLE_NAME = 'report_schedules' THEN
    bad := NOT EXISTS (SELECT 1 FROM notification_channels WHERE id = NEW.channel_id AND org_id = NEW.org_id AND kind = 'email');
  ELSIF TG_TABLE_NAME = 'incidents' THEN
    IF NEW.datacenter_id IS NOT NULL THEN bad := NOT EXISTS (SELECT 1 FROM datacenters WHERE id = NEW.datacenter_id AND org_id = NEW.org_id); END IF;
  ELSIF TG_TABLE_NAME = 'workflow_runs' THEN
    bad := NOT EXISTS (SELECT 1 FROM workflows WHERE id = NEW.workflow_id AND org_id = NEW.org_id)
        OR NOT EXISTS (SELECT 1 FROM domain_events WHERE id = NEW.event_id AND org_id = NEW.org_id);
  END IF;
  IF bad THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'automation_org'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER api_keys_org BEFORE INSERT OR UPDATE OF org_id, owner_user_id ON api_keys FOR EACH ROW EXECUTE FUNCTION automation_check_org();
--> statement-breakpoint
CREATE TRIGGER report_schedules_org BEFORE INSERT OR UPDATE OF org_id, channel_id ON report_schedules FOR EACH ROW EXECUTE FUNCTION automation_check_org();
--> statement-breakpoint
CREATE TRIGGER incidents_org BEFORE INSERT OR UPDATE OF org_id, datacenter_id ON incidents FOR EACH ROW EXECUTE FUNCTION automation_check_org();
--> statement-breakpoint
CREATE TRIGGER workflow_runs_org BEFORE INSERT ON workflow_runs FOR EACH ROW EXECUTE FUNCTION automation_check_org();
