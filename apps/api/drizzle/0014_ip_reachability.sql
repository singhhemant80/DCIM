CREATE TABLE "ip_reachability" (
	"org_id" uuid NOT NULL,
	"address" "inet" NOT NULL,
	"reachable" boolean NOT NULL,
	"rtt_ms" real,
	"last_seen_at" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ip_reachability_org_id_address_pk" PRIMARY KEY("org_id","address")
);
--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD COLUMN "guest_id" uuid;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "prefixes" ADD COLUMN "ping_sweep" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "prefixes" ADD COLUMN "ping_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prefixes" ADD COLUMN "ping_error" text;--> statement-breakpoint
ALTER TABLE "ip_reachability" ADD CONSTRAINT "ip_reachability_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_addresses" ADD CONSTRAINT "ip_addresses_guest_id_virt_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."virt_guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ip_addresses_guest_idx" ON "ip_addresses" USING btree ("guest_id");