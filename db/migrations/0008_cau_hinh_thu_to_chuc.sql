CREATE TABLE "org_email_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'resend' NOT NULL,
	"from_address" text NOT NULL,
	"api_key_enc" "bytea",
	"api_key_hint" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_email_settings_provider_check" CHECK ("org_email_settings"."provider" IN ('resend'))
);
--> statement-breakpoint
ALTER TABLE "org_email_settings" ADD CONSTRAINT "org_email_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_email_settings" ADD CONSTRAINT "org_email_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Cô lập theo tổ chức như mọi bảng có org_id (xem 0001). Quyền của app_user đến từ ALTER DEFAULT PRIVILEGES ở 0001.
ALTER TABLE org_email_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE org_email_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON org_email_settings
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
