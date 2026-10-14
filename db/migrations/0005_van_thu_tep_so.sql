CREATE TABLE "document_counters" (
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_counters_register_id_year_pk" PRIMARY KEY("register_id","year")
);
--> statement-breakpoint
CREATE TABLE "document_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"seq" integer NOT NULL,
	"number" text NOT NULL,
	"run_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"subject" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_registers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"direction" text NOT NULL,
	"pattern" text DEFAULT '{seq}' NOT NULL,
	"reset_policy" text DEFAULT 'yearly' NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_registers_direction_check" CHECK ("document_registers"."direction" IN ('incoming','outgoing','internal')),
	CONSTRAINT "document_registers_reset_check" CHECK ("document_registers"."reset_policy" IN ('yearly','never'))
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "status" text DEFAULT 'attached' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "field_key" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "scan_status" text DEFAULT 'skipped' NOT NULL;--> statement-breakpoint
ALTER TABLE "process_templates" ADD COLUMN "category" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "step_approvals" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "step_approvals" ADD COLUMN "file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_counters" ADD CONSTRAINT "document_counters_register_id_document_registers_id_fk" FOREIGN KEY ("register_id") REFERENCES "public"."document_registers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_entries" ADD CONSTRAINT "document_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_entries" ADD CONSTRAINT "document_entries_register_id_document_registers_id_fk" FOREIGN KEY ("register_id") REFERENCES "public"."document_registers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_entries" ADD CONSTRAINT "document_entries_run_id_process_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."process_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_entries" ADD CONSTRAINT "document_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_registers" ADD CONSTRAINT "document_registers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_entries_seq" ON "document_entries" USING btree ("register_id","year","seq");--> statement-breakpoint
CREATE INDEX "document_entries_run" ON "document_entries" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "document_entries_register" ON "document_entries" USING btree ("org_id","register_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "document_registers_code" ON "document_registers" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "files_run" ON "files" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "files_pending" ON "files" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_status_check" CHECK ("files"."status" IN ('pending','attached'));--> statement-breakpoint

-- Cô lập theo tổ chức như mọi bảng có org_id (xem 0001). Quyền của app_user đến từ ALTER DEFAULT PRIVILEGES ở 0001.
ALTER TABLE document_registers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_registers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON document_registers
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE document_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON document_counters
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE document_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON document_entries
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
