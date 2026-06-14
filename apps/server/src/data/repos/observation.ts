import { desc, eq } from "drizzle-orm";
import { db } from "../client.js";
import { observations } from "../schema.js";

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
  // dreaming worker: observations not yet promoted to Layer 2
  // Simplified impl: latest N by created_at (refine per job in phase 2)
  async listPending(limit = 50): Promise<ObservationRow[]> {
    return await db
      .select()
      .from(observations)
      .orderBy(desc(observations.created_at))
      .limit(limit);
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
};
