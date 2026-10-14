CREATE TABLE "console_credentials" (
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"org_id" uuid NOT NULL,
	"host" text,
	"port" integer,
	"username" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "console_credentials_device_id_kind_pk" PRIMARY KEY("device_id","kind"),
	CONSTRAINT "console_credentials_kind_ck" CHECK ("console_credentials"."kind" in ('vnc', 'sol', 'web'))
);
--> statement-breakpoint
CREATE TABLE "console_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"user_label" text NOT NULL,
	"user_type" text NOT NULL,
	"client_ip" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"ticket_hash" text,
	"ticket_expires_at" timestamp with time zone,
	"relay_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"bytes_in" bigint DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "console_credentials" ADD CONSTRAINT "console_credentials_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_credentials" ADD CONSTRAINT "console_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_sessions" ADD CONSTRAINT "console_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_sessions" ADD CONSTRAINT "console_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "console_sessions_device_idx" ON "console_sessions" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "console_sessions_live_uq" ON "console_sessions" USING btree ("device_id","kind") WHERE "console_sessions"."status" in ('pending', 'connecting', 'active');