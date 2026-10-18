ALTER TYPE "public"."job_kind" ADD VALUE 'guest_reinstall';--> statement-breakpoint
ALTER TABLE "virt_guests" ADD COLUMN "os_id" text;--> statement-breakpoint
ALTER TABLE "virt_guests" ADD COLUMN "os_name" text;--> statement-breakpoint
ALTER TABLE "virt_integrations" ADD COLUMN "templates" jsonb;