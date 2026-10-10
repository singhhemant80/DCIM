CREATE TYPE "public"."allocation_kind" AS ENUM('full', 'half', 'quarter', 'custom');--> statement-breakpoint
CREATE TYPE "public"."cross_connect_status" AS ENUM('requested', 'approved', 'rejected', 'in_progress', 'active', 'decommissioned');--> statement-breakpoint
CREATE TYPE "public"."service_kind" AS ENUM('colocation', 'dedicated_server', 'vps', 'ip_transit', 'cross_connect', 'remote_hands', 'other');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('pending', 'active', 'suspended', 'cancelled', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('expected', 'received', 'delivered', 'shipped_out', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ticket_kind" AS ENUM('support', 'remote_hands', 'cross_connect', 'shipment', 'access', 'billing', 'other');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('open', 'in_progress', 'waiting_customer', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('requested', 'approved', 'denied', 'checked_in', 'checked_out', 'cancelled');--> statement-breakpoint
CREATE TABLE "colo_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid,
	"rack_id" uuid NOT NULL,
	"kind" "allocation_kind" NOT NULL,
	"part" smallint,
	"start_u" integer NOT NULL,
	"end_u" integer NOT NULL,
	"contracted_power_w" integer NOT NULL,
	"feeds" text DEFAULT 'single' NOT NULL,
	"breaker_amps" integer,
	"voltage" integer,
	"start_date" date NOT NULL,
	"end_date" date,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "colo_allocations_range_ck" CHECK ("colo_allocations"."start_u" >= 1 and "colo_allocations"."end_u" >= "colo_allocations"."start_u")
);
--> statement-breakpoint
CREATE TABLE "cross_connects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid,
	"a_device_id" uuid,
	"a_interface_id" uuid,
	"a_label" text NOT NULL,
	"z_label" text NOT NULL,
	"loa_reference" text,
	"media" text NOT NULL,
	"speed" text,
	"status" "cross_connect_status" DEFAULT 'requested' NOT NULL,
	"circuit_id" text,
	"cable_id" uuid,
	"status_reason" text,
	"notes" text,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"decommissioned_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_label" text,
	"from_status" "service_status",
	"to_status" "service_status",
	"summary" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "service_kind" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "service_status" DEFAULT 'pending' NOT NULL,
	"start_date" date,
	"end_date" date,
	"billing_reference" text,
	"device_id" uuid,
	"guest_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"datacenter_id" uuid NOT NULL,
	"direction" text DEFAULT 'inbound' NOT NULL,
	"carrier" text NOT NULL,
	"tracking_number" text,
	"expected_on" date,
	"packages" integer DEFAULT 1 NOT NULL,
	"description" text NOT NULL,
	"instructions" text,
	"status" "shipment_status" DEFAULT 'expected' NOT NULL,
	"packages_received" integer,
	"storage_location" text,
	"condition_note" text,
	"received_at" timestamp with time zone,
	"received_by" text,
	"closed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_counters" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_user_id" uuid,
	"author_label" text,
	"author_type" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_time_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"user_label" text NOT NULL,
	"minutes" integer NOT NULL,
	"note" text NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	CONSTRAINT "ticket_time_minutes_ck" CHECK ("ticket_time_entries"."minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"customer_id" uuid,
	"kind" "ticket_kind" NOT NULL,
	"priority" "ticket_priority" DEFAULT 'normal' NOT NULL,
	"status" "ticket_status" DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"device_id" uuid,
	"assignee_user_id" uuid,
	"authorized_minutes" integer,
	"created_by_user_id" uuid,
	"created_by" text NOT NULL,
	"last_public_reply_by" text,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"datacenter_id" uuid NOT NULL,
	"visitors" jsonb NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"purpose" text NOT NULL,
	"status" "visit_status" DEFAULT 'requested' NOT NULL,
	"escort" boolean DEFAULT false NOT NULL,
	"badge" text,
	"decision_note" text,
	"decided_by" text,
	"checked_in_at" timestamp with time zone,
	"checked_out_at" timestamp with time zone,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visits_time_ck" CHECK ("visits"."ends_at" > "visits"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "rack_reservations" ADD COLUMN "allocation_id" uuid;--> statement-breakpoint
ALTER TABLE "colo_allocations" ADD CONSTRAINT "colo_allocations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colo_allocations" ADD CONSTRAINT "colo_allocations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colo_allocations" ADD CONSTRAINT "colo_allocations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "colo_allocations" ADD CONSTRAINT "colo_allocations_rack_id_racks_id_fk" FOREIGN KEY ("rack_id") REFERENCES "public"."racks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_connects" ADD CONSTRAINT "cross_connects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_connects" ADD CONSTRAINT "cross_connects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_connects" ADD CONSTRAINT "cross_connects_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_connects" ADD CONSTRAINT "cross_connects_a_device_id_devices_id_fk" FOREIGN KEY ("a_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_connects" ADD CONSTRAINT "cross_connects_a_interface_id_interfaces_id_fk" FOREIGN KEY ("a_interface_id") REFERENCES "public"."interfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_connects" ADD CONSTRAINT "cross_connects_cable_id_cables_id_fk" FOREIGN KEY ("cable_id") REFERENCES "public"."cables"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_guest_id_virt_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."virt_guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_counters" ADD CONSTRAINT "ticket_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD CONSTRAINT "ticket_time_entries_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_time_entries" ADD CONSTRAINT "ticket_time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "colo_allocations_customer_idx" ON "colo_allocations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "colo_allocations_rack_idx" ON "colo_allocations" USING btree ("rack_id");--> statement-breakpoint
CREATE INDEX "cross_connects_customer_idx" ON "cross_connects" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "cross_connects_org_idx" ON "cross_connects" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "service_events_service_idx" ON "service_events" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "services_customer_idx" ON "services" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "services_org_idx" ON "services" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "shipments_customer_idx" ON "shipments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "shipments_org_idx" ON "shipments" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id","id");--> statement-breakpoint
CREATE INDEX "ticket_time_ticket_idx" ON "ticket_time_entries" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_org_number_uq" ON "tickets" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "tickets_customer_idx" ON "tickets" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "tickets_org_status_idx" ON "tickets" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "visits_customer_idx" ON "visits" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "visits_org_idx" ON "visits" USING btree ("org_id","starts_at");--> statement-breakpoint
ALTER TABLE "rack_reservations" ADD CONSTRAINT "rack_reservations_allocation_id_colo_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."colo_allocations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX rack_reservations_allocation_uq ON rack_reservations (allocation_id) WHERE allocation_id IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER colo_allocations_updated_at BEFORE UPDATE ON colo_allocations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER cross_connects_updated_at BEFORE UPDATE ON cross_connects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER shipments_updated_at BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER visits_updated_at BEFORE UPDATE ON visits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Every row stays in the organization of what it references (customer, rack, device, service, datacenter, user...).
CREATE OR REPLACE FUNCTION colo_check_org() RETURNS trigger AS $$
DECLARE
  bad boolean := false;
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    bad := bad OR NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id AND org_id = NEW.org_id);
  END IF;
  IF TG_TABLE_NAME = 'services' THEN
    IF NEW.device_id IS NOT NULL THEN bad := bad OR NOT EXISTS (SELECT 1 FROM devices WHERE id = NEW.device_id AND org_id = NEW.org_id); END IF;
    IF NEW.guest_id IS NOT NULL THEN bad := bad OR NOT EXISTS (SELECT 1 FROM virt_guests WHERE id = NEW.guest_id AND org_id = NEW.org_id); END IF;
  ELSIF TG_TABLE_NAME = 'colo_allocations' THEN
    bad := bad OR NOT EXISTS (SELECT 1 FROM racks WHERE id = NEW.rack_id AND org_id = NEW.org_id);
    IF NEW.service_id IS NOT NULL THEN bad := bad OR NOT EXISTS (SELECT 1 FROM services WHERE id = NEW.service_id AND org_id = NEW.org_id AND customer_id = NEW.customer_id); END IF;
  ELSIF TG_TABLE_NAME = 'cross_connects' THEN
    IF NEW.service_id IS NOT NULL THEN bad := bad OR NOT EXISTS (SELECT 1 FROM services WHERE id = NEW.service_id AND org_id = NEW.org_id AND customer_id = NEW.customer_id); END IF;
    IF NEW.a_device_id IS NOT NULL THEN bad := bad OR NOT EXISTS (SELECT 1 FROM devices WHERE id = NEW.a_device_id AND org_id = NEW.org_id); END IF;
    IF NEW.cable_id IS NOT NULL THEN bad := bad OR NOT EXISTS (SELECT 1 FROM cables WHERE id = NEW.cable_id AND org_id = NEW.org_id); END IF;
  ELSIF TG_TABLE_NAME IN ('shipments', 'visits') THEN
    bad := bad OR NOT EXISTS (SELECT 1 FROM datacenters WHERE id = NEW.datacenter_id AND org_id = NEW.org_id);
  ELSIF TG_TABLE_NAME = 'tickets' THEN
    IF NEW.device_id IS NOT NULL THEN bad := bad OR NOT EXISTS (SELECT 1 FROM devices WHERE id = NEW.device_id AND org_id = NEW.org_id); END IF;
    IF NEW.assignee_user_id IS NOT NULL THEN bad := bad OR NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.assignee_user_id AND org_id = NEW.org_id AND user_type = 'staff'); END IF;
  END IF;
  IF bad THEN RAISE EXCEPTION 'Organization mismatch' USING ERRCODE = 'check_violation', CONSTRAINT = 'colo_org'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER services_org BEFORE INSERT OR UPDATE ON services FOR EACH ROW EXECUTE FUNCTION colo_check_org();
--> statement-breakpoint
CREATE TRIGGER colo_allocations_org BEFORE INSERT OR UPDATE ON colo_allocations FOR EACH ROW EXECUTE FUNCTION colo_check_org();
--> statement-breakpoint
CREATE TRIGGER cross_connects_org BEFORE INSERT OR UPDATE ON cross_connects FOR EACH ROW EXECUTE FUNCTION colo_check_org();
--> statement-breakpoint
CREATE TRIGGER shipments_org BEFORE INSERT OR UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION colo_check_org();
--> statement-breakpoint
CREATE TRIGGER visits_org BEFORE INSERT OR UPDATE ON visits FOR EACH ROW EXECUTE FUNCTION colo_check_org();
--> statement-breakpoint
CREATE TRIGGER tickets_org BEFORE INSERT OR UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION colo_check_org();
