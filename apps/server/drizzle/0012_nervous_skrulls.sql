CREATE TABLE "memory_archive_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"reason" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"candidate_count" integer NOT NULL,
	"archived_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"restored_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memory_archive_items" (
	"batch_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"canonical_memory_id" text,
	"was_archived" boolean NOT NULL,
	"archived_at_before" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_archive_items_batch_id_memory_id_pk" PRIMARY KEY("batch_id","memory_id")
);
--> statement-breakpoint
ALTER TABLE "memory_archive_items" ADD CONSTRAINT "memory_archive_items_batch_id_memory_archive_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."memory_archive_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_archive_items" ADD CONSTRAINT "memory_archive_items_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_archive_items" ADD CONSTRAINT "memory_archive_items_canonical_memory_id_memories_id_fk" FOREIGN KEY ("canonical_memory_id") REFERENCES "public"."memories"("id") ON DELETE no action ON UPDATE no action;