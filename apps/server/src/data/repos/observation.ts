import { eq } from "drizzle-orm";
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
};
