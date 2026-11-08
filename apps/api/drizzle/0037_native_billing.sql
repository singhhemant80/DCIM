ALTER TYPE "public"."job_kind" ADD VALUE 'guest_create';--> statement-breakpoint
CREATE TABLE "billing_counters" (
	"org_id" uuid NOT NULL,
	"series" text NOT NULL,
	"fy" text NOT NULL,
	"last" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "billing_counters_org_id_series_fy_pk" PRIMARY KEY("org_id","series","fy")
);
--> statement-breakpoint
CREATE TABLE "billing_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"address" text NOT NULL,
	"state_code" text NOT NULL,
	"gstin" text,
	"pan" text,
	"sac_code" text DEFAULT '998315' NOT NULL,
	"gst_rate_bp" integer DEFAULT 1800 NOT NULL,
	"invoice_prefix" text DEFAULT 'INV' NOT NULL,
	"receipt_prefix" text DEFAULT 'RCPT' NOT NULL,
	"grace_days" integer DEFAULT 3 NOT NULL,
	"email" text,
	"phone" text,
	"bank_details" text,
	"invoice_notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_plan_prices" (
	"customer_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"price_paise" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_plan_prices_customer_id_plan_id_pk" PRIMARY KEY("customer_id","plan_id")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"number" text NOT NULL,
	"fy" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"supplier" jsonb NOT NULL,
	"recipient" jsonb NOT NULL,
	"place_of_supply" text NOT NULL,
	"lines" jsonb NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"status" text DEFAULT 'paid' NOT NULL,
	"subscription_id" uuid,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"plan_id" uuid,
	"guest_id" uuid,
	"service_id" uuid,
	"name" text NOT NULL,
	"price_paise" bigint NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"next_due_at" timestamp with time zone NOT NULL,
	"overdue_since" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_error" text,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vps_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"os_id" text NOT NULL,
	"os_name" text,
	"price_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"gst_rate_bp" integer NOT NULL,
	"place_of_supply" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"job_id" uuid,
	"guest_id" uuid,
	"invoice_id" uuid,
	"subscription_id" uuid,
	"error" text,
	"placed_by" text,
	"by_customer" boolean DEFAULT false NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vps_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_plan_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_paise" bigint NOT NULL,
	"server_id" text,
	"os_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"visible_to_customers" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"balance_after_paise" bigint NOT NULL,
	"method" text,
	"reference" text,
	"description" text NOT NULL,
	"receipt_number" text,
	"invoice_id" uuid,
	"order_id" uuid,
	"subscription_id" uuid,
	"actor_label" text
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "gstin" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "billing_address" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "state_code" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "billing_email" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "wallet_balance_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "virt_integrations" ADD COLUMN "plans" jsonb;--> statement-breakpoint
ALTER TABLE "billing_counters" ADD CONSTRAINT "billing_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_plan_prices" ADD CONSTRAINT "customer_plan_prices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_plan_prices" ADD CONSTRAINT "customer_plan_prices_plan_id_vps_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."vps_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_plan_prices" ADD CONSTRAINT "customer_plan_prices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_vps_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."vps_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_guest_id_virt_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."virt_guests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_orders" ADD CONSTRAINT "vps_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_orders" ADD CONSTRAINT "vps_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_orders" ADD CONSTRAINT "vps_orders_plan_id_vps_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."vps_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_plans" ADD CONSTRAINT "vps_plans_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vps_plans" ADD CONSTRAINT "vps_plans_integration_id_virt_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."virt_integrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_number_uq" ON "invoices" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("customer_id","issued_at");--> statement-breakpoint
CREATE INDEX "subscriptions_due_idx" ON "subscriptions" USING btree ("status","next_due_at");--> statement-breakpoint
CREATE INDEX "subscriptions_customer_idx" ON "subscriptions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "vps_orders_customer_idx" ON "vps_orders" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vps_orders_idem_uq" ON "vps_orders" USING btree ("org_id","customer_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "vps_orders_status_idx" ON "vps_orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "vps_plans_ext_uq" ON "vps_plans" USING btree ("integration_id","external_plan_id");--> statement-breakpoint
CREATE INDEX "wallet_tx_customer_idx" ON "wallet_transactions" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_tx_receipt_uq" ON "wallet_transactions" USING btree ("org_id","receipt_number");--> statement-breakpoint
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER vps_plans_updated_at BEFORE UPDATE ON vps_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER billing_settings_updated_at BEFORE UPDATE ON billing_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER customer_plan_prices_updated_at BEFORE UPDATE ON customer_plan_prices FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- Issued invoices are never changed or deleted (a correction is a new document).
CREATE OR REPLACE FUNCTION invoices_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'invoices are immutable once issued';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER invoices_no_change BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_immutable();--> statement-breakpoint
-- The wallet ledger is append-only: amounts and balances never change; only the invoice/subscription links may be filled in.
CREATE OR REPLACE FUNCTION wallet_tx_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallet transactions are append-only';
  END IF;
  IF NEW.amount_paise IS DISTINCT FROM OLD.amount_paise OR NEW.balance_after_paise IS DISTINCT FROM OLD.balance_after_paise OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.receipt_number IS DISTINCT FROM OLD.receipt_number OR NEW.description IS DISTINCT FROM OLD.description THEN
    RAISE EXCEPTION 'wallet transactions are append-only';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER wallet_tx_append_only BEFORE UPDATE OR DELETE ON wallet_transactions FOR EACH ROW EXECUTE FUNCTION wallet_tx_append_only();
