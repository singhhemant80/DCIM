CREATE TABLE "bgp_upstreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asn" bigint NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'ix_peering' NOT NULL,
	"as_set" text,
	"notes" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"started_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"next_at" timestamp with time zone,
	"data" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bgp_upstreams_kind_ck" CHECK ("bgp_upstreams"."kind" in ('ix_peering', 'transit', 'other'))
);
--> statement-breakpoint
ALTER TABLE "bgp_asns" ADD COLUMN "as_set" text;--> statement-breakpoint
ALTER TABLE "bgp_upstreams" ADD CONSTRAINT "bgp_upstreams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bgp_upstreams_org_asn_uq" ON "bgp_upstreams" USING btree ("org_id","asn");--> statement-breakpoint
CREATE INDEX "bgp_upstreams_next_idx" ON "bgp_upstreams" USING btree ("next_at");