ALTER TABLE "install_state" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "install_state" ADD COLUMN "sources" jsonb;--> statement-breakpoint
ALTER TABLE "install_state" ADD CONSTRAINT "install_state_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- A server set up before this: its owner is whoever finished setup with the setup code.
UPDATE "install_state" SET "owner_user_id" = (
  SELECT a."actor_user_id" FROM "audit_log" a JOIN "user" u ON u."id" = a."actor_user_id"
  WHERE a."action" = 'setup.completed'
  ORDER BY a."created_at"
  LIMIT 1
) WHERE "id" = 1 AND "owner_user_id" IS NULL;
