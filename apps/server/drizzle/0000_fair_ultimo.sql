CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"supersedes_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links" (
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"from_layer" text NOT NULL,
	"to_layer" text NOT NULL,
	"relation" text NOT NULL,
	CONSTRAINT "links_from_id_to_id_relation_pk" PRIMARY KEY("from_id","to_id","relation")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"narrative" text NOT NULL,
	"importance" real DEFAULT 5 NOT NULL,
	"kind" text DEFAULT 'general' NOT NULL,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"session_id" text,
	"project_tag" text,
	"facts" jsonb,
	"metadata" jsonb,
	"embedding" vector(1024),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
