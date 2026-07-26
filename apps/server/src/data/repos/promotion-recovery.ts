import { and, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import {
  capturePromotionWindows,
  captures,
} from "../schema.js";

export const promotionRecoveryRepo = {
  async retryWindow(
    id: string,
    inputContent: string,
    sourceCaptureIds: string[],
  ): Promise<boolean> {
    const now = new Date();
    return await db.transaction(async (tx) => {
      const windows = await tx
        .select({
          id: capturePromotionWindows.id,
          status: capturePromotionWindows.status,
          captureCount: capturePromotionWindows.capture_count,
          promotionKind: capturePromotionWindows.promotion_kind,
        })
        .from(capturePromotionWindows)
        .where(eq(capturePromotionWindows.id, id))
        .for("update");
      const window = windows[0];
      if (
        !window ||
        window.promotionKind !== "stop_checkpoint" ||
        !["deferred", "quarantined"].includes(window.status)
      ) {
        return false;
      }

      const sourceCaptures = await tx
        .select({ id: captures.id })
        .from(captures)
        .where(
          and(
            eq(captures.promotion_window_id, id),
            eq(captures.promotion_state, "windowed"),
          ),
        )
        .for("update");
      const expectedIds = [...sourceCaptureIds].sort();
      const actualIds = sourceCaptures.map((capture) => capture.id).sort();
      if (
        actualIds.length !== window.captureCount ||
        actualIds.length !== expectedIds.length ||
        actualIds.some((captureId, index) => captureId !== expectedIds[index])
      ) {
        return false;
      }

      const rows = await tx
        .update(capturePromotionWindows)
        .set({
          status: "pending",
          input_content: inputContent,
          failure_count: sql`CASE
            WHEN ${capturePromotionWindows.status} = 'quarantined' THEN 0
            ELSE ${capturePromotionWindows.failure_count}
          END`,
          next_attempt_at: now,
          lease_expires_at: null,
          last_error: null,
          completed_at: null,
          updated_at: now,
        })
        .where(eq(capturePromotionWindows.id, id))
        .returning({ id: capturePromotionWindows.id });
      return rows.length === 1;
    });
  },
};
