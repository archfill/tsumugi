import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
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
  async listActive(limit = 100, offset = 0): Promise<MemoryRow[]> {
    return await db
      .select()
      .from(memories)
      .where(isNull(memories.archived_at))
      .orderBy(desc(memories.created_at))
      .limit(limit)
      .offset(offset);
  },
  async countActive(): Promise<number> {
    const r = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM memories WHERE archived_at IS NULL`,
    );
    return Number(r.rows[0]?.n ?? 0);
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
  async markOutdated(id: string, reason: string): Promise<void> {
    await db
      .update(memories)
      .set({
        outdated_at: sql`now()`,
        outdated_reason: reason,
      })
      .where(eq(memories.id, id));
  },
  async listOutdated(limit = 100): Promise<MemoryRow[]> {
    return await db
      .select()
      .from(memories)
      .where(and(isNull(memories.archived_at), isNotNull(memories.outdated_at)))
      .orderBy(desc(memories.outdated_at))
      .limit(limit);
  },
  async archiveOutdated(limit = 100): Promise<number> {
    const rows = await db
      .update(memories)
      .set({ archived_at: sql`now()` })
      .where(
        and(
          isNull(memories.archived_at),
          isNotNull(memories.outdated_at),
          sql`${memories.id} IN (
            SELECT id FROM ${memories}
            WHERE archived_at IS NULL
              AND outdated_at IS NOT NULL
            ORDER BY outdated_at DESC
            LIMIT ${limit}
          )`,
        ),
      )
      .returning({ id: memories.id });
    return rows.length;
  },
};
