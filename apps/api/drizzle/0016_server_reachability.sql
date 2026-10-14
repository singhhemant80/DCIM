ALTER TABLE "devices" ADD COLUMN "server_address" text;--> statement-breakpoint
ALTER TABLE "device_reachability" ADD COLUMN "kind" text DEFAULT 'mgmt' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_reachability" DROP CONSTRAINT "device_reachability_pkey";--> statement-breakpoint
ALTER TABLE "device_reachability" ADD CONSTRAINT "device_reachability_device_id_kind_pk" PRIMARY KEY("device_id","kind");--> statement-breakpoint
ALTER TABLE "device_reachability" ADD CONSTRAINT "device_reachability_kind_ck" CHECK ("device_reachability"."kind" in ('mgmt', 'server'));
