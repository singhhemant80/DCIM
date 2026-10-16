CREATE TABLE "device_health" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"at" timestamp with time zone,
	"cpu_pct" real,
	"cpu_count" integer,
	"memory_used_bytes" bigint,
	"memory_total_bytes" bigint,
	"disk_used_bytes" bigint,
	"disk_total_bytes" bigint,
	"temperature_c" real,
	"cpu_temperature_c" real,
	"voltage" real,
	"uptime_seconds" bigint,
	"version" text,
	"board" text,
	"sensors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_health_samples" (
	"device_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"cpu_pct" real,
	"memory_pct" real,
	"temperature_c" real,
	CONSTRAINT "device_health_samples_device_id_at_pk" PRIMARY KEY("device_id","at")
);
--> statement-breakpoint
ALTER TABLE "device_health" ADD CONSTRAINT "device_health_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_health" ADD CONSTRAINT "device_health_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_health_samples" ADD CONSTRAINT "device_health_samples_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_health_samples" ADD CONSTRAINT "device_health_samples_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;