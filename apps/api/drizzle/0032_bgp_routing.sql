CREATE TABLE "bgp_asns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"asn" bigint NOT NULL,
	"name" text,
	"notes" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"started_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"next_at" timestamp with time zone,
	"data" jsonb,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prefix_routing" (
	"prefix_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"started_at" timestamp with time zone,
	"checked_at" timestamp with time zone,
	"next_at" timestamp with time zone,
	"level" text,
	"data" jsonb,
	"last_error" text,
	"last_attempt_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "prefixes" ADD COLUMN "origin_asn" bigint;--> statement-breakpoint
ALTER TABLE "prefixes" ADD COLUMN "routing_check" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bgp_asns" ADD CONSTRAINT "bgp_asns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prefix_routing" ADD CONSTRAINT "prefix_routing_prefix_id_prefixes_id_fk" FOREIGN KEY ("prefix_id") REFERENCES "public"."prefixes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prefix_routing" ADD CONSTRAINT "prefix_routing_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bgp_asns_org_asn_uq" ON "bgp_asns" USING btree ("org_id","asn");--> statement-breakpoint
CREATE INDEX "bgp_asns_next_idx" ON "bgp_asns" USING btree ("next_at");--> statement-breakpoint
CREATE INDEX "prefix_routing_org_idx" ON "prefix_routing" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "prefix_routing_next_idx" ON "prefix_routing" USING btree ("next_at");