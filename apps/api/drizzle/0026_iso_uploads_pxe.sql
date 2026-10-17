ALTER TYPE "public"."job_kind" ADD VALUE 'image_process';--> statement-breakpoint
CREATE TABLE "pxe_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'proxy' NOT NULL,
	"interface" text,
	"server_address" text NOT NULL,
	"proxy_networks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ranges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"boot_base_url" text,
	"allow_networks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"apply_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "source" text DEFAULT 'url' NOT NULL;--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "upload_status" text;--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "upload_file_name" text;--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "upload_size" bigint;--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "uploaded_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "expected_sha256" text;--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "boot_kind" text;--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "detected" jsonb;--> statement-breakpoint
ALTER TABLE "os_images" ADD COLUMN "process_error" text;--> statement-breakpoint
ALTER TABLE "pxe_settings" ADD CONSTRAINT "pxe_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;