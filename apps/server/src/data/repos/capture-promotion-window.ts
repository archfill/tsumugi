import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { TsumugiError } from "../../lib/errors.js";
import { db } from "../client.js";
import {
  captureObservationLinks,
  capturePromotionWindows,
  captures,
  observationPromotionFacts,
  observations,
  type NewCapturePromotionWindow,
  type NewObservation,
  type NewObservationPromotionFact,
} from "../schema.js";

export type CapturePromotionWindowRow =
  typeof capturePromotionWindows.$inferSelect;

const WINDOW_QUARANTINE_THRESHOLD = 5;

export const capturePromotionWindowRepo = {
  async create(
    row: NewCapturePromotionWindow,
    captureIds: string[],
  ): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.insert(capturePromotionWindows).values(row);
      await tx
        .update(captures)
        .set({
          promotion_window_id: row.id,
          promotion_state: "windowed",
        })
        .where(
          and(
            inArray(captures.id, captureIds),
            eq(captures.promotion_state, "ready"),
          ),
        );
    });
  },

  async listEligible(limit = 10): Promise<CapturePromotionWindowRow[]> {
    const now = new Date();
    return await db
      .select()
      .from(capturePromotionWindows)
      .where(
        and(
          lte(capturePromotionWindows.next_attempt_at, now),
          isNotNull(capturePromotionWindows.input_content),
          or(
            eq(capturePromotionWindows.status, "pending"),
            eq(capturePromotionWindows.status, "deferred"),
            and(
              eq(capturePromotionWindows.status, "processing"),
              lte(capturePromotionWindows.lease_expires_at, now),
            ),
          ),
        ),
      )
      .orderBy(asc(capturePromotionWindows.created_at))
      .limit(limit);
  },

  async claim(
    id: string,
    leaseMs = 10 * 60 * 1000,
  ): Promise<CapturePromotionWindowRow | null> {
    const now = new Date();
    const rows = await db
      .update(capturePromotionWindows)
      .set({
        status: "processing",
        attempt_count: sql`${capturePromotionWindows.attempt_count} + 1`,
        lease_expires_at: new Date(now.getTime() + leaseMs),
        updated_at: now,
      })
      .where(
        and(
          eq(capturePromotionWindows.id, id),
          lte(capturePromotionWindows.next_attempt_at, now),
          or(
            eq(capturePromotionWindows.status, "pending"),
            eq(capturePromotionWindows.status, "deferred"),
            and(
              eq(capturePromotionWindows.status, "processing"),
              lte(capturePromotionWindows.lease_expires_at, now),
            ),
          ),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  async complete(params: {
    window: CapturePromotionWindowRow;
    captureIds: string[];
    observation: NewObservation;
    facts: NewObservationPromotionFact[];
  }): Promise<void> {
    const now = new Date();
    await db.transaction(async (tx) => {
      const owned = await tx
        .update(capturePromotionWindows)
        .set({ status: "committing", updated_at: now })
        .where(
          and(
            eq(capturePromotionWindows.id, params.window.id),
            eq(capturePromotionWindows.status, "processing"),
            eq(
              capturePromotionWindows.attempt_count,
              params.window.attempt_count,
            ),
          ),
        )
        .returning({ id: capturePromotionWindows.id });
      if (!owned[0]) {
        throw new TsumugiError("capture promotion window lease was superseded");
      }
      await tx.insert(observations).values(params.observation);
      if (params.facts.length > 0) {
        await tx
          .insert(observationPromotionFacts)
          .values(params.facts)
          .onConflictDoNothing();
      } else {
        await tx
          .update(observations)
          .set({ promotion_state: "completed", promoted_at: now })
          .where(eq(observations.id, params.observation.id));
      }
      await tx.insert(captureObservationLinks).values(
        params.captureIds.map((captureId) => ({
          capture_id: captureId,
          observation_id: params.observation.id,
          window_id: params.window.id,
        })),
      );
      await tx
        .update(captures)
        .set({
          promoted_to_obs_id: params.observation.id,
          promoted_at: now,
          promotion_state: "promoted",
        })
        .where(inArray(captures.id, params.captureIds));
      await tx
        .update(capturePromotionWindows)
        .set({
          status: "completed",
          observation_id: params.observation.id,
          lease_expires_at: null,
          last_error: null,
          completed_at: now,
          input_content: null,
          updated_at: now,
        })
        .where(eq(capturePromotionWindows.id, params.window.id));
    });
  },

  async skip(
    window: CapturePromotionWindowRow,
    captureIds: string[],
    reason: string,
  ): Promise<void> {
    const now = new Date();
    await db.transaction(async (tx) => {
      const owned = await tx
        .update(capturePromotionWindows)
        .set({ status: "committing", updated_at: now })
        .where(
          and(
            eq(capturePromotionWindows.id, window.id),
            eq(capturePromotionWindows.status, "processing"),
            eq(capturePromotionWindows.attempt_count, window.attempt_count),
          ),
        )
        .returning({ id: capturePromotionWindows.id });
      if (!owned[0]) {
        throw new TsumugiError("capture promotion window lease was superseded");
      }
      await tx
        .update(captures)
        .set({ skip_reason: reason, promotion_state: "skipped" })
        .where(inArray(captures.id, captureIds));
      await tx
        .update(capturePromotionWindows)
        .set({
          status: "skipped",
          last_error: null,
          lease_expires_at: null,
          completed_at: now,
          input_content: null,
          updated_at: now,
        })
        .where(eq(capturePromotionWindows.id, window.id));
    });
  },

  async defer(
    row: CapturePromotionWindowRow,
    error: string,
  ): Promise<{ quarantined: boolean; updated: boolean }> {
    const quarantined = row.attempt_count >= WINDOW_QUARANTINE_THRESHOLD;
    const delayMs = Math.min(
      24 * 60 * 60 * 1000,
      60_000 * 2 ** Math.max(0, row.attempt_count - 1),
    );
    const updated = await db
      .update(capturePromotionWindows)
      .set({
        status: quarantined ? "quarantined" : "deferred",
        input_content: quarantined ? null : row.input_content,
        next_attempt_at: new Date(Date.now() + delayMs),
        lease_expires_at: null,
        last_error: error,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(capturePromotionWindows.id, row.id),
          eq(capturePromotionWindows.status, "processing"),
          eq(capturePromotionWindows.attempt_count, row.attempt_count),
        ),
      )
      .returning({ id: capturePromotionWindows.id });
    return { quarantined, updated: updated.length === 1 };
  },

  async clearExpiredContent(
    before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  ): Promise<number> {
    const result = await db
      .update(capturePromotionWindows)
      .set({
        input_content: null,
        status: sql`CASE
          WHEN ${capturePromotionWindows.status} IN ('completed', 'skipped', 'quarantined')
            THEN ${capturePromotionWindows.status}
          ELSE 'expired'
        END`,
        lease_expires_at: null,
        updated_at: new Date(),
      })
      .where(
        and(
          lt(capturePromotionWindows.cutoff_at, before),
          isNotNull(capturePromotionWindows.input_content),
        ),
      );
    return Number(result.rowCount ?? 0);
  },
};
