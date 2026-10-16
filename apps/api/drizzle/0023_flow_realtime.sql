ALTER TABLE "flow_exporters" ADD COLUMN "live_interface" text;--> statement-breakpoint
ALTER TABLE "flow_exporters" ADD COLUMN "live_direction" text DEFAULT 'uplink' NOT NULL;