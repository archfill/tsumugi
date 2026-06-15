import { and, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { links } from "../schema.js";

export type LinkRow = typeof links.$inferSelect;
export type NewLinkRow = typeof links.$inferInsert;

export const linkRepo = {
  async insert(row: NewLinkRow): Promise<void> {
    await db.insert(links).values(row).onConflictDoNothing();
  },
  async listFrom(fromId: string): Promise<LinkRow[]> {
    return await db.select().from(links).where(eq(links.from_id, fromId));
  },
  async listTo(toId: string): Promise<LinkRow[]> {
    return await db.select().from(links).where(eq(links.to_id, toId));
  },
  async listRecent(limit = 500, offset = 0): Promise<LinkRow[]> {
    return await db.select().from(links).limit(limit).offset(offset);
  },
  async countAll(): Promise<number> {
    const r = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM links`,
    );
    return Number(r.rows[0]?.n ?? 0);
  },
  async remove(fromId: string, toId: string, relation: string): Promise<void> {
    await db
      .delete(links)
      .where(
        and(
          eq(links.from_id, fromId),
          eq(links.to_id, toId),
          eq(links.relation, relation),
        ),
      );
  },
};
