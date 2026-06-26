import { and, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { links } from "../schema.js";

export type LinkRow = typeof links.$inferSelect;
export type NewLinkRow = typeof links.$inferInsert;
export type LinkRelation = "derived_from" | "supersedes" | "related_to";
export type LinkLayer = "observation" | "memory";

export interface SearchProvenanceRow extends Record<string, unknown> {
  hit_id: string;
  hit_layer: LinkLayer;
  id: string;
  layer: LinkLayer;
  relation: LinkRelation;
  created_at: Date;
}

function textArray(values: string[]) {
  if (values.length === 0) {
    return sql`ARRAY[]::text[]`;
  }
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

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
  /**
   * Return final SearchHit provenance in batch.
   *
   * Link direction is observation -> memory for derived_from. For memory hits,
   * provenance points to incoming sources. For observation hits, provenance
   * points to outgoing derived memories. created_at is the linked entity time,
   * not link creation time.
   */
  async listSearchProvenance(params: {
    observationIds: string[];
    memoryIds: string[];
  }): Promise<SearchProvenanceRow[]> {
    const observationIds = params.observationIds;
    const memoryIds = params.memoryIds;
    if (observationIds.length === 0 && memoryIds.length === 0) return [];
    const observationIdArray = textArray(observationIds);
    const memoryIdArray = textArray(memoryIds);

    const result = await db.execute<SearchProvenanceRow>(sql`
      WITH hit_provenance AS (
        SELECT
          l.to_id AS hit_id,
          l.to_layer AS hit_layer,
          l.from_id AS id,
          l.from_layer AS layer,
          l.relation AS relation,
          o.created_at AS created_at
        FROM links l
        JOIN observations o ON o.id = l.from_id
        WHERE
          ${memoryIdArray} <> '{}'::text[]
          AND l.to_id = ANY(${memoryIdArray})
          AND l.to_layer = 'memory'
          AND l.from_layer = 'observation'

        UNION ALL

        SELECT
          l.from_id AS hit_id,
          l.from_layer AS hit_layer,
          l.to_id AS id,
          l.to_layer AS layer,
          l.relation AS relation,
          m.created_at AS created_at
        FROM links l
        JOIN memories m ON m.id = l.to_id
        WHERE
          ${observationIdArray} <> '{}'::text[]
          AND l.from_id = ANY(${observationIdArray})
          AND l.from_layer = 'observation'
          AND l.to_layer = 'memory'
      )
      SELECT
        hit_id,
        hit_layer,
        id,
        layer,
        relation,
        created_at
      FROM hit_provenance
    `);
    return result.rows;
  },
  /**
   * Project-aware memory retrieval filter. Only derived_from observation links
   * are treated as project ownership evidence.
   */
  async listMemoryIdsDerivedFromProject(
    memoryIds: string[],
    projectTag: string,
  ): Promise<string[]> {
    if (memoryIds.length === 0) return [];
    const memoryIdArray = textArray(memoryIds);
    const result = await db.execute<{ id: string }>(sql`
      SELECT DISTINCT l.to_id AS id
      FROM links l
      JOIN observations o ON o.id = l.from_id
      WHERE
        l.to_id = ANY(${memoryIdArray})
        AND l.to_layer = 'memory'
        AND l.from_layer = 'observation'
        AND l.relation = 'derived_from'
        AND o.project_tag = ${projectTag}
    `);
    return result.rows.map((row) => row.id);
  },
};
