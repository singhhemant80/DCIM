CREATE TYPE "public"."device_category" AS ENUM('server', 'gpu_server', 'storage', 'switch', 'router', 'firewall', 'load_balancer', 'optical', 'pdu', 'patch_panel', 'kvm', 'ups', 'other');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_state" AS ENUM('planned', 'received', 'inventory', 'reserved', 'racked', 'provisioning', 'active', 'maintenance', 'retired');--> statement-breakpoint
CREATE TYPE "public"."mgmt_type" AS ENUM('idrac', 'ilo', 'ipmi', 'redfish', 'other');--> statement-breakpoint
CREATE TYPE "public"."ownership" AS ENUM('company', 'customer');--> statement-breakpoint
CREATE TYPE "public"."rack_face" AS ENUM('front', 'rear');--> statement-breakpoint
CREATE TYPE "public"."rack_numbering" AS ENUM('bottom_up', 'top_down');--> statement-breakpoint
CREATE TYPE "public"."rack_status" AS ENUM('planned', 'active', 'reserved', 'decommissioned');--> statement-breakpoint
CREATE TYPE "public"."spare_part_kind" AS ENUM('ram', 'ssd', 'hdd', 'nvme', 'cpu', 'nic', 'psu', 'rail', 'transceiver', 'cable', 'fan', 'other');--> statement-breakpoint
CREATE TABLE "buildings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"datacenter_id" uuid NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "datacenters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"country" text,
	"timezone" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"manufacturer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "device_category" NOT NULL,
	"u_height" integer NOT NULL,
	"depth_mm" integer,
	"full_depth" boolean DEFAULT true NOT NULL,
	"typical_power_w" integer,
	"idle_power_w" integer,
	"max_power_w" integer,
	"psu_count" integer,
	"psu_rated_w" integer,
	"weight_kg" numeric(7, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_models_u_ck" CHECK ("device_models"."u_height" between 0 and 60)
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid,
	"ownership" "ownership" DEFAULT 'company' NOT NULL,
	"model_id" uuid NOT NULL,
	"category" "device_category" NOT NULL,
	"u_height" integer NOT NULL,
	"full_depth" boolean NOT NULL,
	"asset_tag" text NOT NULL,
	"hostname" text,
	"serial" text,
	"lifecycle_state" "lifecycle_state" DEFAULT 'planned' NOT NULL,
	"rack_id" uuid,
	"position_u" integer,
	"face" "rack_face",
	"u_range" "int4range" GENERATED ALWAYS AS (case when position_u is null then null else int4range(position_u, position_u + u_height) end) STORED,
	"occupies_front" boolean GENERATED ALWAYS AS (position_u is not null and (full_depth or face = 'front')) STORED,
	"occupies_rear" boolean GENERATED ALWAYS AS (position_u is not null and (full_depth or face = 'rear')) STORED,
	"cpu" text,
	"cpu_count" integer,
	"ram_gb" integer,
	"dimm_layout" text,
	"disks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raid" text,
	"nics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mgmt_type" "mgmt_type",
	"mgmt_address" text,
	"bios_version" text,
	"bmc_firmware" text,
	"os" text,
	"purchase_date" date,
	"supplier" text,
	"purchase_cost" numeric(14, 2),
	"currency" text,
	"warranty_expires" date,
	"eol_date" date,
	"notes" text,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_position_ck" CHECK (("devices"."position_u" is null and "devices"."face" is null) or ("devices"."rack_id" is not null and "devices"."position_u" >= 1 and "devices"."u_height" >= 1 and ("devices"."face" is not null))),
	CONSTRAINT "devices_ownership_ck" CHECK ("devices"."ownership" = 'company' or "devices"."customer_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "lifecycle_transitions" (
	"org_id" uuid NOT NULL,
	"from_state" "lifecycle_state" NOT NULL,
	"to_state" "lifecycle_state" NOT NULL,
	CONSTRAINT "lifecycle_transitions_org_id_from_state_to_state_pk" PRIMARY KEY("org_id","from_state","to_state"),
	CONSTRAINT "lifecycle_transitions_distinct_ck" CHECK ("lifecycle_transitions"."from_state" <> "lifecycle_transitions"."to_state")
);
--> statement-breakpoint
CREATE TABLE "manufacturers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rack_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"rack_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_label" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rack_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rack_id" uuid NOT NULL,
	"start_u" integer NOT NULL,
	"end_u" integer NOT NULL,
	"u_range" "int4range" GENERATED ALWAYS AS (int4range(start_u, end_u + 1)) STORED,
	"customer_id" uuid,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rack_reservations_range_ck" CHECK ("rack_reservations"."start_u" >= 1 and "rack_reservations"."end_u" >= "rack_reservations"."start_u")
);
--> statement-breakpoint
CREATE TABLE "rack_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "racks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"row_id" uuid,
	"name" text NOT NULL,
	"u_height" integer DEFAULT 42 NOT NULL,
	"depth_mm" integer DEFAULT 1070 NOT NULL,
	"max_power_w" integer,
	"max_weight_kg" integer,
	"numbering" "rack_numbering" DEFAULT 'bottom_up' NOT NULL,
	"status" "rack_status" DEFAULT 'active' NOT NULL,
	"customer_id" uuid,
	"grid_x" integer,
	"grid_y" integer,
	"asset_tag" text,
	"serial" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "racks_u_height_ck" CHECK ("racks"."u_height" between 1 and 60),
	CONSTRAINT "racks_grid_pair_ck" CHECK (("racks"."grid_x" is null) = ("racks"."grid_y" is null))
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"name" text NOT NULL,
	"floor" text,
	"grid_cols" integer DEFAULT 20 NOT NULL,
	"grid_rows" integer DEFAULT 12 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_grid_ck" CHECK ("rooms"."grid_cols" between 1 and 200 and "rooms"."grid_rows" between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "spare_part_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"quantity_after" integer NOT NULL,
	"reason" text NOT NULL,
	"device_id" uuid,
	"actor_id" uuid,
	"actor_label" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spare_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"datacenter_id" uuid,
	"kind" "spare_part_kind" NOT NULL,
	"manufacturer" text,
	"part_number" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"min_quantity" integer DEFAULT 0 NOT NULL,
	"location" text,
	"unit_cost" numeric(12, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spare_parts_qty_ck" CHECK ("spare_parts"."quantity" >= 0 and "spare_parts"."min_quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "datacenters" ADD CONSTRAINT "datacenters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_models" ADD CONSTRAINT "device_models_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_models" ADD CONSTRAINT "device_models_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_model_id_device_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."device_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_rack_id_racks_id_fk" FOREIGN KEY ("rack_id") REFERENCES "public"."racks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_transitions" ADD CONSTRAINT "lifecycle_transitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manufacturers" ADD CONSTRAINT "manufacturers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_events" ADD CONSTRAINT "rack_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_events" ADD CONSTRAINT "rack_events_rack_id_racks_id_fk" FOREIGN KEY ("rack_id") REFERENCES "public"."racks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_reservations" ADD CONSTRAINT "rack_reservations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_reservations" ADD CONSTRAINT "rack_reservations_rack_id_racks_id_fk" FOREIGN KEY ("rack_id") REFERENCES "public"."racks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_reservations" ADD CONSTRAINT "rack_reservations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_rows" ADD CONSTRAINT "rack_rows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rack_rows" ADD CONSTRAINT "rack_rows_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "racks" ADD CONSTRAINT "racks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "racks" ADD CONSTRAINT "racks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "racks" ADD CONSTRAINT "racks_row_id_rack_rows_id_fk" FOREIGN KEY ("row_id") REFERENCES "public"."rack_rows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "racks" ADD CONSTRAINT "racks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spare_part_movements" ADD CONSTRAINT "spare_part_movements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spare_part_movements" ADD CONSTRAINT "spare_part_movements_part_id_spare_parts_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."spare_parts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spare_part_movements" ADD CONSTRAINT "spare_part_movements_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spare_parts" ADD CONSTRAINT "spare_parts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spare_parts" ADD CONSTRAINT "spare_parts_datacenter_id_datacenters_id_fk" FOREIGN KEY ("datacenter_id") REFERENCES "public"."datacenters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buildings_dc_name_uq" ON "buildings" USING btree ("datacenter_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "datacenters_org_code_uq" ON "datacenters" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "device_events_device_idx" ON "device_events" USING btree ("device_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "device_models_mfr_name_uq" ON "device_models" USING btree ("manufacturer_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "devices_org_asset_tag_uq" ON "devices" USING btree ("org_id",lower("asset_tag"));--> statement-breakpoint
CREATE UNIQUE INDEX "devices_org_serial_uq" ON "devices" USING btree ("org_id",lower("serial")) WHERE "devices"."serial" is not null and "devices"."serial" <> '';--> statement-breakpoint
CREATE INDEX "devices_org_state_idx" ON "devices" USING btree ("org_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "devices_rack_idx" ON "devices" USING btree ("rack_id");--> statement-breakpoint
CREATE INDEX "devices_customer_idx" ON "devices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "devices_warranty_idx" ON "devices" USING btree ("org_id","warranty_expires");--> statement-breakpoint
CREATE UNIQUE INDEX "manufacturers_org_name_uq" ON "manufacturers" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "rack_events_rack_idx" ON "rack_events" USING btree ("rack_id","occurred_at");--> statement-breakpoint
CREATE INDEX "rack_reservations_rack_idx" ON "rack_reservations" USING btree ("rack_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rack_rows_room_name_uq" ON "rack_rows" USING btree ("room_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "racks_room_name_uq" ON "racks" USING btree ("room_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "racks_room_grid_uq" ON "racks" USING btree ("room_id","grid_x","grid_y") WHERE "racks"."grid_x" is not null and "racks"."grid_y" is not null;--> statement-breakpoint
CREATE INDEX "racks_org_idx" ON "racks" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_building_name_uq" ON "rooms" USING btree ("building_id","name");--> statement-breakpoint
CREATE INDEX "spare_part_movements_part_idx" ON "spare_part_movements" USING btree ("part_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spare_parts_org_dc_pn_uq" ON "spare_parts" USING btree ("org_id",coalesce("datacenter_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("part_number"));