CREATE TABLE "captures" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"project_tag" text,
	"source" text NOT NULL,
	"hook_event" text NOT NULL,
	"tool_name" text,
	"raw_content" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	"promoted_to_obs_id" text,
	"promoted_at" timestamp with time zone,
	"skip_reason" text
);
--> statement-breakpoint
ALTER TABLE "observations" ADD COLUMN "source_layer" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_promoted_to_obs_id_observations_id_fk" FOREIGN KEY ("promoted_to_obs_id") REFERENCES "public"."observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_captures_session_captured" ON "captures" USING btree ("session_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_captures_expires" ON "captures" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_captures_unpromoted" ON "captures" USING btree ("captured_at") WHERE "captures"."promoted_to_obs_id" IS NULL AND "captures"."skip_reason" IS NULL;