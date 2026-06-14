CREATE TABLE "dreaming_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job_kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"input_count" integer DEFAULT 0 NOT NULL,
	"output_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"metadata" jsonb
);
