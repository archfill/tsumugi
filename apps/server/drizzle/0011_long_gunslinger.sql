ALTER TABLE "capture_promotion_windows" ADD COLUMN "promotion_kind" text DEFAULT 'window' NOT NULL;--> statement-breakpoint
ALTER TABLE "capture_promotion_windows" ADD COLUMN "promotion_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capture_windows_promotion_key" ON "capture_promotion_windows" USING btree ("promotion_key") WHERE "capture_promotion_windows"."promotion_key" IS NOT NULL;