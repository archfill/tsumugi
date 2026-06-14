import { desc, eq, isNull } from "drizzle-orm";
import { db } from "../client.js";
import { observations } from "../schema.js";

export interface ObservationFactsPatch {
  facts?: string[];
  metadata?: Record<string, unknown>;
}

export type ObservationRow = typeof observations.$inferSelect;
export type NewObservationRow = typeof observations.$inferInsert;

export const observationRepo = {
  async insert(row: NewObservationRow): Promise<void> {
    await db.insert(observations).values(row);
  },
  async findById(id: string): Promise<ObservationRow | null> {
    const rows = await db
      .select()
      .from(observations)
      .where(eq(observations.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  async deleteById(id: string): Promise<void> {
    await db.delete(observations).where(eq(observations.id, id));
  },
  async listRecent(limit = 100): Promise<ObservationRow[]> {
    return await db
      .select()
      .from(observations)
      .orderBy(desc(observations.created_at))
      .limit(limit);
  },
  // dreaming worker: observations not yet promoted to Layer 2
  async listPending(limit = 50): Promise<ObservationRow[]> {
    return await db
      .select()
      .from(observations)
      .where(isNull(observations.promoted_at))
      .orderBy(desc(observations.created_at))
      .limit(limit);
  },
  async markPromoted(id: string, promotedAt = new Date()): Promise<void> {
    await db
      .update(observations)
      .set({ promoted_at: promotedAt })
      .where(eq(observations.id, id));
  },
  async listForSession(
    sessionId: string,
    limit = 200,
  ): Promise<ObservationRow[]> {
    return await db
      .select()
      .from(observations)
      .where(eq(observations.session_id, sessionId))
      .orderBy(desc(observations.created_at))
      .limit(limit);
  },
  async updateFactsAndMetadata(
    id: string,
    patch: ObservationFactsPatch,
  ): Promise<void> {
    await db
      .update(observations)
      .set({
        ...(patch.facts !== undefined
          ? { facts: patch.facts as unknown as never }
          : {}),
        ...(patch.metadata !== undefined
          ? { metadata: patch.metadata as unknown as never }
          : {}),
      })
      .where(eq(observations.id, id));
  },
};
