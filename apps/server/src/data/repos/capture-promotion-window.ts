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
  async retireLegacyStopRequeue(options: {
    dryRun: boolean;
    expectedEligible?: number;
  }): Promise<{
    eligible: number;
    unsafe: number;
    retired: number;
    releasedStops: number;
    blocked: boolean;
  }> {
    return await db.transaction(async (tx) => {
      const windows = await tx.execute<{
        id: string;
        capture_count: number;
      }>(sql`
        SELECT id, capture_count FROM capture_promotion_windows
        WHERE promotion_kind = 'window'
          AND status IN ('pending', 'processing', 'committing', 'deferred', 'quarantined')
        FOR UPDATE
      `);
      const plan: Array<{ id: string; stopIds: string[]; terminalIds: string[] }> = [];
      let unsafe = 0;
      for (const window of windows.rows) {
        const source = await tx
          .select()
          .from(captures)
          .where(eq(captures.promotion_window_id, window.id))
          .for("update");
        const stops = source.filter(
          (capture) =>
            capture.hook_event === "Stop" &&
            Boolean(capture.continuity_content?.trim()),
        );
        const safe =
          source.length === Number(window.capture_count) &&
          source.every((capture) => capture.promotion_state === "windowed") &&
          stops.length > 0;
        if (!safe) {
          unsafe++;
          continue;
        }
        plan.push({
          id: window.id,
          stopIds: stops.map((capture) => capture.id),
          terminalIds: source
            .filter((capture) => !stops.some((stop) => stop.id === capture.id))
            .map((capture) => capture.id),
        });
      }
      const eligible = plan.length;
      const releasedStops = plan.reduce((total, item) => total + item.stopIds.length, 0);
      const blocked =
        unsafe > 0 ||
        (options.expectedEligible !== undefined &&
          options.expectedEligible !== eligible);
      if (options.dryRun || blocked) {
        return { eligible, unsafe, retired: 0, releasedStops, blocked };
      }
      for (const item of plan) {
        await tx
          .update(captures)
          .set({ promotion_window_id: null, promotion_state: "ready" })
          .where(inArray(captures.id, item.stopIds));
        if (item.terminalIds.length > 0) {
          await tx
            .update(captures)
            .set({
              promotion_state: "skipped",
              skip_reason: "legacy_window_retired_non_checkpoint",
            })
            .where(inArray(captures.id, item.terminalIds));
        }
        await tx
          .update(capturePromotionWindows)
          .set({
            status: "retired",
            input_content: null,
            lease_expires_at: null,
            last_error: "retired_for_deterministic_stop_requeue",
            updated_at: new Date(),
            completed_at: new Date(),
          })
          .where(eq(capturePromotionWindows.id, item.id));
      }
      return { eligible, unsafe, retired: eligible, releasedStops, blocked: false };
    });
  },

  async findById(id: string): Promise<CapturePromotionWindowRow | null> {
    const rows = await db
      .select()
      .from(capturePromotionWindows)
      .where(eq(capturePromotionWindows.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async create(
    row: NewCapturePromotionWindow,
    captureIds: string[],
  ): Promise<void> {
    return await db.transaction(async (tx) => {
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

  async createDeterministicStop(row: {
    id: string;
    promotionKey: string;
    capture: {
      id: string;
      source: string;
      session_id: string;
      project_tag: string | null;
      captured_at: Date;
      continuity_content: string;
    };
  }): Promise<{ windowId: string; created: boolean }> {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(capturePromotionWindows)
        .values({
        id: row.id,
        source: row.capture.source,
        session_id: row.capture.session_id,
        project_tag: row.capture.project_tag,
        promotion_kind: "stop_checkpoint",
        promotion_key: row.promotionKey,
        cutoff_at: row.capture.captured_at,
        capture_count: 1,
        raw_chars: row.capture.continuity_content.length,
        completed_turns: 1,
        fallback: false,
        input_content: row.capture.continuity_content,
        })
        .onConflictDoNothing()
        .returning({ id: capturePromotionWindows.id });
      const existing =
        (inserted[0]
          ? {
              id: inserted[0].id,
              status: "pending",
              observation_id: null,
            }
          : undefined) ??
        (
          await tx
            .select({
              id: capturePromotionWindows.id,
              status: capturePromotionWindows.status,
              observation_id: capturePromotionWindows.observation_id,
            })
            .from(capturePromotionWindows)
            .where(eq(capturePromotionWindows.promotion_key, row.promotionKey))
            .limit(1)
        )[0];
      if (!existing) {
        throw new TsumugiError("deterministic Stop window was not found");
      }
      if (existing.status === "completed" && existing.observation_id) {
        await tx
          .insert(captureObservationLinks)
          .values({
            capture_id: row.capture.id,
            observation_id: existing.observation_id,
            window_id: existing.id,
          })
          .onConflictDoNothing();
        await tx
          .update(captures)
          .set({
            promotion_window_id: existing.id,
            promoted_to_obs_id: existing.observation_id,
            promoted_at: new Date(),
            promotion_state: "promoted",
          })
          .where(
            and(
              eq(captures.id, row.capture.id),
              eq(captures.promotion_state, "ready"),
            ),
          );
        return { windowId: existing.id, created: Boolean(inserted[0]) };
      }
      if (
        ["skipped", "quarantined", "expired", "retired"].includes(
          existing.status,
        )
      ) {
        await tx
          .update(capturePromotionWindows)
          .set({
            status: "pending",
            input_content: row.capture.continuity_content,
            completed_at: null,
            failure_count: 0,
            next_attempt_at: new Date(),
            lease_expires_at: null,
            last_error: null,
            updated_at: new Date(),
          })
          .where(eq(capturePromotionWindows.id, existing.id));
      }
      const assigned = await tx
        .update(captures)
        .set({ promotion_window_id: existing.id, promotion_state: "windowed" })
        .where(
          and(
            eq(captures.id, row.capture.id),
            eq(captures.hook_event, "Stop"),
            eq(captures.promotion_state, "ready"),
          ),
        )
        .returning({ id: captures.id });
      if (!assigned[0]) {
        throw new TsumugiError("Stop capture was no longer ready for promotion");
      }
      const activeCaptures = await tx
        .select({
          id: captures.id,
          continuity_content: captures.continuity_content,
        })
        .from(captures)
        .where(
          and(
            eq(captures.promotion_window_id, existing.id),
            eq(captures.promotion_state, "windowed"),
          ),
        );
      await tx
        .update(capturePromotionWindows)
        .set({
          capture_count: activeCaptures.length,
          raw_chars: activeCaptures.reduce(
            (total, capture) => total + (capture.continuity_content?.trim().length ?? 0),
            0,
          ),
          updated_at: new Date(),
        })
        .where(eq(capturePromotionWindows.id, existing.id));
      return { windowId: existing.id, created: Boolean(inserted[0]) };
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

  async listEligibleDeterministicStops(
    limit = 10,
  ): Promise<CapturePromotionWindowRow[]> {
    const now = new Date();
    return await db
      .select()
      .from(capturePromotionWindows)
      .where(
        and(
          eq(capturePromotionWindows.promotion_kind, "stop_checkpoint"),
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
      .orderBy(asc(capturePromotionWindows.created_at))
      .limit(limit);
  },

  async countOutstanding(): Promise<number> {
    const result = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM capture_promotion_windows
      WHERE status IN ('pending', 'deferred', 'processing', 'committing')
    `);
    return Number(result.rows[0]?.count ?? 0);
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

  async completeDeterministicStop(params: {
    window: CapturePromotionWindowRow;
    captureIds: string[];
    observation: NewObservation;
  }): Promise<void> {
    const now = new Date();
    await db.transaction(async (tx) => {
      const owned = await tx
        .update(capturePromotionWindows)
        .set({ status: "committing", updated_at: now })
        .where(
          and(
            eq(capturePromotionWindows.id, params.window.id),
            eq(capturePromotionWindows.promotion_kind, "stop_checkpoint"),
            eq(capturePromotionWindows.status, "processing"),
            eq(capturePromotionWindows.attempt_count, params.window.attempt_count),
          ),
        )
        .returning({ id: capturePromotionWindows.id });
      if (!owned[0]) {
        throw new TsumugiError("capture promotion window lease was superseded");
      }
      await tx.insert(observations).values(params.observation);
      await tx.insert(captureObservationLinks).values(
        params.captureIds.map((captureId) => ({
          capture_id: captureId,
          observation_id: params.observation.id,
          window_id: params.window.id,
        })),
      );
      const promoted = await tx
        .update(captures)
        .set({
          promoted_to_obs_id: params.observation.id,
          promoted_at: now,
          promotion_state: "promoted",
        })
        .where(
          and(
            inArray(captures.id, params.captureIds),
            eq(captures.promotion_window_id, params.window.id),
            eq(captures.promotion_state, "windowed"),
          ),
        )
        .returning({ id: captures.id });
      if (promoted.length !== params.captureIds.length) {
        throw new TsumugiError("Stop capture ownership was superseded");
      }
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
    options?: { countsTowardQuarantine?: boolean },
  ): Promise<{ quarantined: boolean; updated: boolean }> {
    const failureCount =
      row.failure_count + (options?.countsTowardQuarantine === false ? 0 : 1);
    const quarantined = failureCount >= WINDOW_QUARANTINE_THRESHOLD;
    const delayMs = Math.min(
      24 * 60 * 60 * 1000,
      60_000 * 2 ** Math.max(0, failureCount - 1),
    );
    const updated = await db
      .update(capturePromotionWindows)
      .set({
        status: quarantined ? "quarantined" : "deferred",
        input_content: quarantined ? null : row.input_content,
        next_attempt_at: new Date(Date.now() + delayMs),
        lease_expires_at: null,
        last_error: error,
        failure_count: failureCount,
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
