ALTER TABLE "memories" ADD COLUMN "outdated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "outdated_reason" text;