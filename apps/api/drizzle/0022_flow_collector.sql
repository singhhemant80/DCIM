CREATE TABLE "flow_exporters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid,
	"name" text NOT NULL,
	"address" "inet" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sampling_rate" integer DEFAULT 1 NOT NULL,
	"last_packet_at" timestamp with time zone,
	"last_version" smallint,
	"packets" bigint DEFAULT 0 NOT NULL,
	"records" bigint DEFAULT 0 NOT NULL,
	"unmatched_records" bigint DEFAULT 0 NOT NULL,
	"bad_packets" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_exporters_sampling_ck" CHECK ("flow_exporters"."sampling_rate" between 1 and 1000000)
);
--> statement-breakpoint
CREATE TABLE "ip_traffic_1h" (
	"org_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"address" "inet" NOT NULL,
	"in_bytes" bigint DEFAULT 0 NOT NULL,
	"out_bytes" bigint DEFAULT 0 NOT NULL,
	"in_packets" bigint DEFAULT 0 NOT NULL,
	"out_packets" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ip_traffic_1h_org_id_bucket_address_pk" PRIMARY KEY("org_id","bucket","address")
);
--> statement-breakpoint
CREATE TABLE "ip_traffic_1m" (
	"org_id" uuid NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"address" "inet" NOT NULL,
	"in_bytes" bigint DEFAULT 0 NOT NULL,
	"out_bytes" bigint DEFAULT 0 NOT NULL,
	"in_packets" bigint DEFAULT 0 NOT NULL,
	"out_packets" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ip_traffic_1m_org_id_bucket_address_pk" PRIMARY KEY("org_id","bucket","address")
);
--> statement-breakpoint
ALTER TABLE "flow_exporters" ADD CONSTRAINT "flow_exporters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_exporters" ADD CONSTRAINT "flow_exporters_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_traffic_1h" ADD CONSTRAINT "ip_traffic_1h_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_traffic_1m" ADD CONSTRAINT "ip_traffic_1m_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_exporters_address_uq" ON "flow_exporters" USING btree ("address");--> statement-breakpoint
CREATE INDEX "ip_traffic_1h_addr_idx" ON "ip_traffic_1h" USING btree ("org_id","address","bucket");--> statement-breakpoint
CREATE INDEX "ip_traffic_1m_addr_idx" ON "ip_traffic_1m" USING btree ("org_id","address","bucket");