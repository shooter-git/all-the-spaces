ALTER TABLE "notifications" ADD COLUMN "subject" text;--> statement-breakpoint
CREATE INDEX "notifications_subject" ON "notifications" USING btree ("subject");