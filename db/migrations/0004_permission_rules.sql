CREATE TABLE "permission_rules" (
	"org_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject" text NOT NULL,
	"action" text NOT NULL,
	"effect" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_rules_org_id_subject_type_subject_action_pk" PRIMARY KEY("org_id","subject_type","subject","action"),
	CONSTRAINT "permission_rules_subject_type_check" CHECK ("permission_rules"."subject_type" IN ('role','user')),
	CONSTRAINT "permission_rules_effect_check" CHECK ("permission_rules"."effect" IN ('grant','revoke'))
);
--> statement-breakpoint
ALTER TABLE "permission_rules" ADD CONSTRAINT "permission_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_rules" ADD CONSTRAINT "permission_rules_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Cô lập theo tổ chức như mọi bảng có org_id (xem 0001): truy vấn quên đặt tổ chức không thấy dòng nào.
ALTER TABLE permission_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE permission_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON permission_rules
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON permission_rules TO app_user;
