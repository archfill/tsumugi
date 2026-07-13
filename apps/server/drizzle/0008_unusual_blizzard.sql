CREATE TABLE "capture_observation_links" (
	"capture_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"window_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_observation_links_capture_id_observation_id_pk" PRIMARY KEY("capture_id","observation_id")
);
--> statement-breakpoint
CREATE TABLE "capture_promotion_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"session_id" text NOT NULL,
	"project_tag" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"cutoff_at" timestamp with time zone NOT NULL,
	"capture_count" integer NOT NULL,
	"raw_chars" integer NOT NULL,
	"completed_turns" integer DEFAULT 0 NOT NULL,
	"fallback" boolean DEFAULT false NOT NULL,
	"input_content" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"observation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "observation_promotion_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"observation_id" text NOT NULL,
	"fact_hash" text NOT NULL,
	"fact" text NOT NULL,
	"ordinal" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"decision" text,
	"target_memory_id" text,
	"result_memory_id" text,
	"reasoning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "idx_captures_unpromoted";--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "continuity_content" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "content_hash" text;--> statement-breakpoint
UPDATE "captures" SET "content_hash" = 'md5:' || md5("raw_content");--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "content_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "promotion_state" text;--> statement-breakpoint
UPDATE "captures"
SET "promotion_state" = CASE
	WHEN "promoted_to_obs_id" IS NOT NULL THEN 'promoted'
	WHEN "skip_reason" IS NOT NULL THEN 'skipped'
	ELSE 'ready'
END;--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "promotion_state" SET DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "promotion_state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "promotion_window_id" text;--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "promotion_state" text;--> statement-breakpoint
UPDATE "observations"
SET "promotion_state" = CASE
	WHEN "promoted_at" IS NOT NULL THEN 'completed'
	ELSE 'ready'
END;--> statement-breakpoint
ALTER TABLE "observations" ALTER COLUMN "promotion_state" SET DEFAULT 'ready';--> statement-breakpoint
ALTER TABLE "observations" ALTER COLUMN "promotion_state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "capture_observation_links" ADD CONSTRAINT "capture_observation_links_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_observation_links" ADD CONSTRAINT "capture_observation_links_window_id_capture_promotion_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."capture_promotion_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_promotion_windows" ADD CONSTRAINT "capture_promotion_windows_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_promotion_facts" ADD CONSTRAINT "observation_promotion_facts_observation_id_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_capture_observation_window" ON "capture_observation_links" USING btree ("window_id");--> statement-breakpoint
CREATE INDEX "idx_capture_windows_eligible" ON "capture_promotion_windows" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_observation_fact_hash" ON "observation_promotion_facts" USING btree ("observation_id","fact_hash");--> statement-breakpoint
CREATE INDEX "idx_observation_facts_eligible" ON "observation_promotion_facts" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_promotion_window_id_capture_promotion_windows_id_fk" FOREIGN KEY ("promotion_window_id") REFERENCES "public"."capture_promotion_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_captures_continuity" ON "captures" USING btree ("project_tag","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_captures_turn_checkpoint" ON "captures" USING btree ("source","session_id","hook_event","turn_id") WHERE "captures"."turn_id" IS NOT NULL AND "captures"."hook_event" IN ('UserPromptSubmit', 'Stop');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_captures_turn_content_event" ON "captures" USING btree ("source","session_id","hook_event","turn_id","content_hash") WHERE "captures"."turn_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_captures_unpromoted" ON "captures" USING btree ("captured_at") WHERE "captures"."promoted_to_obs_id" IS NULL AND "captures"."skip_reason" IS NULL AND "captures"."promotion_state" = 'ready';
