CREATE TABLE "run_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_shares_run_user" UNIQUE("run_id","user_id"),
	CONSTRAINT "run_shares_role_check" CHECK ("run_shares"."role" IN ('viewer','commenter'))
);
--> statement-breakpoint
CREATE TABLE "step_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"step_run_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "step_comments_body_check" CHECK (char_length("step_comments"."body") BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "process_runs" ADD COLUMN "confidentiality" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "run_shares" ADD CONSTRAINT "run_shares_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_shares" ADD CONSTRAINT "run_shares_run_id_process_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."process_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_shares" ADD CONSTRAINT "run_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_shares" ADD CONSTRAINT "run_shares_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_comments" ADD CONSTRAINT "step_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_comments" ADD CONSTRAINT "step_comments_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_comments" ADD CONSTRAINT "step_comments_run_id_process_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."process_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_comments" ADD CONSTRAINT "step_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_shares_user" ON "run_shares" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "step_comments_step" ON "step_comments" USING btree ("org_id","step_run_id","created_at");--> statement-breakpoint
CREATE INDEX "step_comments_author" ON "step_comments" USING btree ("org_id","author_id","created_at");--> statement-breakpoint
ALTER TABLE "process_runs" ADD CONSTRAINT "process_runs_confidentiality_check" CHECK ("process_runs"."confidentiality" IN ('normal','restricted'));
--> statement-breakpoint

-- Cô lập theo tổ chức như mọi bảng có org_id (xem 0001). Quyền của app_user đến từ ALTER DEFAULT PRIVILEGES ở 0001.
-- Mức mật của các lượt chạy có sẵn: mặc định 'normal' (cột mới); lượt đã khởi chạy trước migration này không bị hạn chế ngược.
ALTER TABLE run_shares ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE run_shares FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON run_shares
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE step_comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE step_comments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON step_comments
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
