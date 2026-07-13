ALTER TABLE "observations" ADD COLUMN "promotion_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "promotion_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "promotion_last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "promotion_last_error" text;--> statement-breakpoint
CREATE INDEX "idx_observations_promotion_eligible" ON "observations" USING btree ("promotion_state","promotion_next_attempt_at","created_at");