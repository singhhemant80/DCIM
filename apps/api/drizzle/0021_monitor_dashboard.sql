CREATE TABLE "monitor_dashboard_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"interface_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "monitor_dashboard_items" ADD CONSTRAINT "monitor_dashboard_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_dashboard_items" ADD CONSTRAINT "monitor_dashboard_items_interface_id_interfaces_id_fk" FOREIGN KEY ("interface_id") REFERENCES "public"."interfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_dashboard_items_uq" ON "monitor_dashboard_items" USING btree ("org_id","interface_id");