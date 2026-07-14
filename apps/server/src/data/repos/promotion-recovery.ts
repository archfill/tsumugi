import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db } from "../client.js";
import {
  capturePromotionWindows,
  captures,
  observationPromotionFacts,
  observations,
} from "../schema.js";

const retryableFactStates = ["deferred", "quarantined"];

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
        })
        .from(capturePromotionWindows)
        .where(eq(capturePromotionWindows.id, id))
        .for("update");
      const window = windows[0];
      if (!window || !["deferred", "quarantined"].includes(window.status)) {
        return false;
      }

      const sourceCaptures = await tx
        .select({ id: captures.id })
        .from(captures)
        .where(eq(captures.promotion_window_id, id))
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
          updated_at: now,
        })
        .where(eq(capturePromotionWindows.id, id))
        .returning({ id: capturePromotionWindows.id });
      return rows.length === 1;
    });
  },

  async retryFact(id: string): Promise<boolean> {
    const now = new Date();
    return await db.transaction(async (tx) => {
      const rows = await tx
        .update(observationPromotionFacts)
        .set({
          status: "pending",
          failure_count: sql`CASE
            WHEN ${observationPromotionFacts.status} = 'quarantined' THEN 0
            ELSE ${observationPromotionFacts.failure_count}
          END`,
          next_attempt_at: now,
          lease_expires_at: null,
          last_error: null,
          updated_at: now,
        })
        .where(
          and(
            eq(observationPromotionFacts.id, id),
            inArray(observationPromotionFacts.status, retryableFactStates),
          ),
        )
        .returning({ observationId: observationPromotionFacts.observation_id });
      const row = rows[0];
      if (!row) return false;
      await tx
        .update(observations)
        .set({
          promotion_state: "processing",
          promotion_failure_count: 0,
          promotion_next_attempt_at: now,
          promotion_last_failure_at: null,
          promotion_last_error: null,
        })
        .where(eq(observations.id, row.observationId));
      return true;
    });
  },

  async retryObservation(id: string): Promise<boolean> {
    const now = new Date();
    return await db.transaction(async (tx) => {
      const observationsUpdated = await tx
        .update(observations)
        .set({
          promotion_failure_count: sql`CASE
            WHEN ${observations.promotion_state} = 'quarantined' THEN 0
            ELSE ${observations.promotion_failure_count}
          END`,
          promotion_next_attempt_at: now,
          promotion_last_failure_at: null,
          promotion_last_error: null,
        })
        .where(
          and(
            eq(observations.id, id),
            or(
              eq(observations.promotion_state, "quarantined"),
              and(
                eq(observations.promotion_state, "ready"),
                gt(observations.promotion_failure_count, 0),
              ),
            ),
          ),
        )
        .returning({ id: observations.id });
      if (!observationsUpdated[0]) return false;

      await tx
        .update(observationPromotionFacts)
        .set({
          status: "pending",
          failure_count: 0,
          next_attempt_at: now,
          lease_expires_at: null,
          last_error: null,
          updated_at: now,
        })
        .where(
          and(
            eq(observationPromotionFacts.observation_id, id),
            inArray(observationPromotionFacts.status, retryableFactStates),
          ),
        );

      const incomplete = await tx
        .select({
          id: observationPromotionFacts.id,
          status: observationPromotionFacts.status,
        })
        .from(observationPromotionFacts)
        .where(eq(observationPromotionFacts.observation_id, id));
      const hasIncomplete = incomplete.some(
        (fact) => fact.status !== "completed",
      );
      const promotionState =
        incomplete.length === 0
          ? "ready"
          : hasIncomplete
            ? "processing"
            : "completed";
      await tx
        .update(observations)
        .set({
          promotion_state: promotionState,
          ...(promotionState === "completed" ? { promoted_at: now } : {}),
        })
        .where(eq(observations.id, id));
      return true;
    });
  },
};
