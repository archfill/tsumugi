import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
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
  async listRecent(limit = 100, offset = 0): Promise<ObservationRow[]> {
    return await db
      .select()
      .from(observations)
      .orderBy(desc(observations.created_at))
      .limit(limit)
      .offset(offset);
  },
  async countAll(): Promise<number> {
    const r = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM observations`,
    );
    return Number(r.rows[0]?.n ?? 0);
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
  /**
   * セッション ID から最新の non-null project_tag を解決する。
   * search_memory のデフォルト挙動で session_id 指定時に project_tag を
   * 自動補完するために使う (ADR-013 G)。
   *
   * 該当 observation が無いか、すべての observation で project_tag が
   * null なら null を返す。
   */
  async getLatestProjectTagBySession(
    sessionId: string,
  ): Promise<string | null> {
    const rows = await db
      .select({ project_tag: observations.project_tag })
      .from(observations)
      .where(
        and(
          eq(observations.session_id, sessionId),
          isNotNull(observations.project_tag),
        ),
      )
      .orderBy(desc(observations.created_at))
      .limit(1);
    return rows[0]?.project_tag ?? null;
  },
};
