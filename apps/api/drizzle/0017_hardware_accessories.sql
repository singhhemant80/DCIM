CREATE TABLE "device_accessories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"description" text,
	"length_m" numeric(10, 2),
	"part_number" text,
	"serial" text,
	"notes" text,
	"spare_part_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_accessories_qty_ck" CHECK ("device_accessories"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "device_hardware" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"requested_at" timestamp with time zone,
	"requested_by" text,
	"started_at" timestamp with time zone,
	"fetched_at" timestamp with time zone,
	"next_at" timestamp with time zone,
	"last_error" text,
	"inventory" jsonb,
	"health" text
);
--> statement-breakpoint
ALTER TABLE "device_accessories" ADD CONSTRAINT "device_accessories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_accessories" ADD CONSTRAINT "device_accessories_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_accessories" ADD CONSTRAINT "device_accessories_spare_part_id_spare_parts_id_fk" FOREIGN KEY ("spare_part_id") REFERENCES "public"."spare_parts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_hardware" ADD CONSTRAINT "device_hardware_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_hardware" ADD CONSTRAINT "device_hardware_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_accessories_device_idx" ON "device_accessories" USING btree ("device_id");