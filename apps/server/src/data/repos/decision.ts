import { desc, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { decisions } from "../schema.js";

export type DecisionRow = typeof decisions.$inferSelect;
export type NewDecisionRow = typeof decisions.$inferInsert;

export const decisionRepo = {
  async insert(row: NewDecisionRow): Promise<void> {
    await db.insert(decisions).values(row);
  },
  async findById(id: string): Promise<DecisionRow | null> {
    const rows = await db
      .select()
      .from(decisions)
      .where(eq(decisions.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  async listByStatus(status: string, limit = 200): Promise<DecisionRow[]> {
    return await db
      .select()
      .from(decisions)
      .where(eq(decisions.status, status))
      .limit(limit);
  },
  async listRecent(limit = 200): Promise<DecisionRow[]> {
    return await db
      .select()
      .from(decisions)
      .orderBy(desc(decisions.created_at))
      .limit(limit);
  },
  async update(id: string, patch: Partial<NewDecisionRow>): Promise<void> {
    await db
      .update(decisions)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(decisions.id, id));
  },
  async supersede(oldId: string, newId: string): Promise<void> {
    // Mark oldId as superseded
    await db
      .update(decisions)
      .set({ status: "superseded", updated_at: sql`now()` })
      .where(eq(decisions.id, oldId));
    // Point newId at the decision it supersedes
    await db
      .update(decisions)
      .set({ supersedes_id: oldId, updated_at: sql`now()` })
      .where(eq(decisions.id, newId));
  },
};
