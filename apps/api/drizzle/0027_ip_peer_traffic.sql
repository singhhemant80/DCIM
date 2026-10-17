CREATE TABLE "ip_peer_traffic_1h" (
	"org_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"address" "inet" NOT NULL,
	"peer" "inet" NOT NULL,
	"in_bytes" bigint DEFAULT 0 NOT NULL,
	"out_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ip_peer_traffic_1h_org_id_bucket_address_peer_pk" PRIMARY KEY("org_id","bucket","address","peer")
);
--> statement-breakpoint
ALTER TABLE "ip_peer_traffic_1h" ADD CONSTRAINT "ip_peer_traffic_1h_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ip_peer_traffic_1h_addr_idx" ON "ip_peer_traffic_1h" USING btree ("org_id","address","bucket");