import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { TsumugiError } from "../../lib/errors.js";
import { db } from "../client.js";
import { captures } from "../schema.js";

export type CaptureRow = typeof captures.$inferSelect;
export type NewCaptureRow = typeof captures.$inferInsert;

export const captureRepo = {
  async insertIdempotent(
    row: NewCaptureRow,
  ): Promise<{ id: string; inserted: boolean }> {
    if (!row.turn_id) {
      const inserted = await db
        .insert(captures)
        .values(row)
        .returning({ id: captures.id });
      return { id: inserted[0]!.id, inserted: true };
    }

    const inserted = await db
      .insert(captures)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: captures.id });
    if (inserted[0]) return { id: inserted[0].id, inserted: true };

    const checkpoint =
      row.hook_event === "UserPromptSubmit" || row.hook_event === "Stop";
    const logicalKey = and(
      eq(captures.source, row.source),
      eq(captures.session_id, row.session_id),
      eq(captures.hook_event, row.hook_event),
      eq(captures.turn_id, row.turn_id),
      ...(checkpoint ? [] : [eq(captures.content_hash, row.content_hash)]),
    );
    const existing = await db
      .select({ id: captures.id })
      .from(captures)
      .where(logicalKey)
      .limit(1);
    if (!existing[0]) {
      throw new TsumugiError(
        "capture insert conflicted but existing row was not found",
      );
    }
    return { id: existing[0].id, inserted: false };
  },
  async listReady(limit = 200): Promise<CaptureRow[]> {
    return await db
      .select()
      .from(captures)
      .where(
        and(
          isNull(captures.promoted_to_obs_id),
          isNull(captures.skip_reason),
          eq(captures.promotion_state, "ready"),
        ),
      )
      .orderBy(asc(captures.captured_at))
      .limit(limit);
  },
  async assignWindow(windowId: string, captureIds: string[]): Promise<void> {
    if (captureIds.length === 0) return;
    await db
      .update(captures)
      .set({ promotion_window_id: windowId, promotion_state: "windowed" })
      .where(
        and(
          inArray(captures.id, captureIds),
          eq(captures.promotion_state, "ready"),
        ),
      );
  },
  async listForWindow(windowId: string): Promise<CaptureRow[]> {
    return await db
      .select()
      .from(captures)
      .where(eq(captures.promotion_window_id, windowId))
      .orderBy(asc(captures.captured_at));
  },
  async listContinuityCandidates(params: {
    projectTag: string;
    excludeSessionId?: string;
    limit?: number;
  }): Promise<CaptureRow[]> {
    const conditions = [
      eq(captures.project_tag, params.projectTag),
      eq(captures.hook_event, "Stop"),
      isNull(captures.promoted_to_obs_id),
      isNull(captures.skip_reason),
    ];
    if (params.excludeSessionId) {
      conditions.push(ne(captures.session_id, params.excludeSessionId));
    }
    return await db
      .select()
      .from(captures)
      .where(and(...conditions))
      .orderBy(desc(captures.captured_at))
      .limit(params.limit ?? 50);
  },
  async markPromoted(
    id: string,
    observationId: string,
    promotedAt = new Date(),
  ): Promise<void> {
    await db
      .update(captures)
      .set({
        promoted_to_obs_id: observationId,
        promoted_at: promotedAt,
        promotion_state: "promoted",
      })
      .where(eq(captures.id, id));
  },
  async markSkipped(id: string, reason: string): Promise<void> {
    await db
      .update(captures)
      .set({ skip_reason: reason, promotion_state: "skipped" })
      .where(eq(captures.id, id));
  },
  async deletePromoted(
    before = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  ): Promise<number> {
    const result = await db
      .delete(captures)
      .where(
        and(
          sql`${captures.promoted_to_obs_id} IS NOT NULL`,
          lt(captures.promoted_at, before),
        ),
      );
    return Number(result.rowCount ?? 0);
  },
  async sweepExpired(now = new Date()): Promise<number> {
    const result = await db.delete(captures).where(lt(captures.expires_at, now));
    return Number(result.rowCount ?? 0);
  },
};
