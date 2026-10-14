CREATE TABLE "device_reachability" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"target" text NOT NULL,
	"reachable" boolean NOT NULL,
	"rtt_ms" real,
	"last_seen_at" timestamp with time zone,
	"changed_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "device_reachability" ADD CONSTRAINT "device_reachability_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_reachability" ADD CONSTRAINT "device_reachability_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_reachability_org_idx" ON "device_reachability" USING btree ("org_id");