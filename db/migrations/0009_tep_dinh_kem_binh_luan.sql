ALTER TABLE "step_comments" DROP CONSTRAINT "step_comments_body_check";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "comment_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_comment_id_step_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."step_comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_comment" ON "files" USING btree ("org_id","comment_id");--> statement-breakpoint
ALTER TABLE "step_comments" ADD CONSTRAINT "step_comments_body_check" CHECK (char_length("step_comments"."body") BETWEEN 0 AND 4000);