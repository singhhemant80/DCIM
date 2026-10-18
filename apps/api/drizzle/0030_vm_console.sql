ALTER TABLE "console_sessions" ALTER COLUMN "device_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "console_sessions" ADD COLUMN "guest_id" uuid;--> statement-breakpoint
ALTER TABLE "console_sessions" ADD CONSTRAINT "console_sessions_guest_id_virt_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."virt_guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "console_sessions_guest_live_uq" ON "console_sessions" USING btree ("guest_id","kind") WHERE "console_sessions"."status" in ('pending', 'connecting', 'active');--> statement-breakpoint
ALTER TABLE "console_sessions" ADD CONSTRAINT "console_sessions_target_ck" CHECK (("console_sessions"."device_id" is null) <> ("console_sessions"."guest_id" is null));