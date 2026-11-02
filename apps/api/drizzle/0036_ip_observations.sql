CREATE TABLE "ip_observations" (
	"org_id" uuid NOT NULL,
	"address" "inet" NOT NULL,
	"mac" text,
	"vendor" text,
	"dhcp_host_name" text,
	"router_device_id" uuid,
	"interface_name" text,
	"seen_at" timestamp with time zone,
	"ptr" text,
	"ptr_at" timestamp with time zone,
	CONSTRAINT "ip_observations_org_id_address_pk" PRIMARY KEY("org_id","address")
);
--> statement-breakpoint
ALTER TABLE "ip_observations" ADD CONSTRAINT "ip_observations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_observations" ADD CONSTRAINT "ip_observations_router_device_id_devices_id_fk" FOREIGN KEY ("router_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ip_observations_seen_idx" ON "ip_observations" USING btree ("seen_at");