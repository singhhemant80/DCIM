ALTER TABLE "flow_exporters" ADD COLUMN "diagnostics" jsonb;--> statement-breakpoint
ALTER TABLE "flow_exporters" ADD COLUMN "diagnostics_at" timestamp with time zone;