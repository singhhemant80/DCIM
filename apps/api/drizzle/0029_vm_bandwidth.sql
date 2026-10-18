ALTER TABLE "virt_guests" ADD COLUMN "bw_used_gb" real;--> statement-breakpoint
ALTER TABLE "virt_guests" ADD COLUMN "bw_limit_gb" real;--> statement-breakpoint
-- Text to inet, or NULL when it is not an address (VM address lists come from the hypervisor as text).
CREATE OR REPLACE FUNCTION cdcim_try_inet(v text) RETURNS inet LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN v::inet;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
