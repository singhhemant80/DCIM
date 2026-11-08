ALTER TABLE "billing_settings" ADD COLUMN "terminate_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "auto_renew" boolean DEFAULT true NOT NULL;