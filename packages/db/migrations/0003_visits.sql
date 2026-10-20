CREATE TABLE "visits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"user_id" text NOT NULL,
	"space_id" uuid NOT NULL,
	"room_key" text,
	"creation_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "visits_room_or_creation" CHECK (("visits"."room_key" is null) <> ("visits"."creation_id" is null))
);
--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_creation_id_creations_id_fk" FOREIGN KEY ("creation_id") REFERENCES "public"."creations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "visits_space_started" ON "visits" USING btree ("space_id","started_at");--> statement-breakpoint
CREATE INDEX "visits_group_started" ON "visits" USING btree ("group_id","started_at");--> statement-breakpoint
CREATE INDEX "visits_open" ON "visits" USING btree ("seen_at") WHERE "visits"."ended_at" is null;