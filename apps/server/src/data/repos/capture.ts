import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "../client.js";
import { captures } from "../schema.js";

export type CaptureRow = typeof captures.$inferSelect;
export type NewCaptureRow = typeof captures.$inferInsert;

export const captureRepo = {
  async insert(row: NewCaptureRow): Promise<void> {
    await db.insert(captures).values(row);
  },
  async listUnpromoted(limit = 50): Promise<CaptureRow[]> {
    return await db
      .select()
      .from(captures)
      .where(
        and(isNull(captures.promoted_to_obs_id), isNull(captures.skip_reason)),
      )
      .orderBy(asc(captures.captured_at))
      .limit(limit);
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
      })
      .where(eq(captures.id, id));
  },
  async markSkipped(id: string, reason: string): Promise<void> {
    await db
      .update(captures)
      .set({ skip_reason: reason })
      .where(eq(captures.id, id));
  },
  async deletePromoted(): Promise<number> {
    const result = await db
      .delete(captures)
      .where(sql`${captures.promoted_to_obs_id} IS NOT NULL`);
    return Number(result.rowCount ?? 0);
  },
  async sweepExpired(now = new Date()): Promise<number> {
    const result = await db.delete(captures).where(lt(captures.expires_at, now));
    return Number(result.rowCount ?? 0);
  },
};
