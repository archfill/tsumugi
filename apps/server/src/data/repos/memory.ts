import { eq, isNull, sql } from "drizzle-orm";
import { db } from "../client.js";
import { memories } from "../schema.js";

export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;

export const memoryRepo = {
  async insert(row: NewMemoryRow): Promise<void> {
    await db.insert(memories).values(row);
  },
  async findById(id: string): Promise<MemoryRow | null> {
    const rows = await db
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  async listActive(limit = 100): Promise<MemoryRow[]> {
    return await db
      .select()
      .from(memories)
      .where(isNull(memories.archived_at))
      .limit(limit);
  },
  async update(id: string, patch: Partial<NewMemoryRow>): Promise<void> {
    await db
      .update(memories)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(memories.id, id));
  },
  async archive(id: string): Promise<void> {
    await db
      .update(memories)
      .set({ archived_at: sql`now()` })
      .where(eq(memories.id, id));
  },
};
