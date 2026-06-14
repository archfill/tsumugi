ALTER TABLE "memories" ADD COLUMN "llm_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "last_llm_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "llm_quarantined_at" timestamp with time zone;