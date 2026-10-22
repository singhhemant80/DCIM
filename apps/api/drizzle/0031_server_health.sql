CREATE TABLE "server_health" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"started_at" timestamp with time zone,
	"at" timestamp with time zone,
	"next_at" timestamp with time zone,
	"data" jsonb,
	"last_error" text,
	"last_attempt_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "server_health" ADD CONSTRAINT "server_health_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_health" ADD CONSTRAINT "server_health_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_health_org_idx" ON "server_health" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "server_health_next_idx" ON "server_health" USING btree ("next_at");