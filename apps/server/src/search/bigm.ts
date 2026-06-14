/**
 * pg_bigm keyword search for observations and memories.
 *
 * Uses:
 *   - `LIKE likequery($q)` as a rough pre-filter (uses GIN bigm index)
 *   - `bigm_similarity($q, content)` as the score
 *   - observations.content  / memories.narrative as the text column
 *
 * memories do NOT have source / session_id / project_tag columns, so those
 * filters are honoured only for observations. If such a filter is supplied
 * and layer = 'memory', the caller is expected to skip this function entirely
 * (see hybridSearch in index.ts).
 */

import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import type { SearchInput } from "@tsumugi/shared";

export interface BigmHit {
  id: string;
  score: number;
  layer: "observation" | "memory";
  excerpt: string;
}

type BigmRow = Record<string, unknown> & {
  id: string;
  score: number;
  content: string;
};

/** Truncate text around its beginning, keeping up to 200 chars. */
function makeExcerpt(text: string): string {
  if (text.length <= 200) return text;
  return text.slice(0, 200) + "…";
}

export async function bigmSearch(params: {
  query: string;
  layer: "observation" | "memory";
  limit: number;
  filter?: SearchInput["filter"];
}): Promise<BigmHit[]> {
  const { query, layer, limit, filter } = params;
  const fetchLimit = limit * 3;

  if (layer === "observation") {
    return bigmObservations({ query, limit: fetchLimit, filter });
  } else {
    return bigmMemories({ query, limit: fetchLimit });
  }
}

async function bigmObservations(params: {
  query: string;
  limit: number;
  filter?: SearchInput["filter"];
}): Promise<BigmHit[]> {
  const { query, limit, filter } = params;

  // Build dynamic WHERE clauses.  We use sql`` fragments and concatenate.
  // The base conditions: content must match likequery.
  let whereSql = sql`content LIKE likequery(${query})`;

  if (filter?.type) {
    whereSql = sql`${whereSql} AND type = ${filter.type}`;
  }
  if (filter?.source) {
    whereSql = sql`${whereSql} AND source = ${filter.source}`;
  }
  if (filter?.session_id) {
    whereSql = sql`${whereSql} AND session_id = ${filter.session_id}`;
  }
  if (filter?.project_tag) {
    whereSql = sql`${whereSql} AND project_tag = ${filter.project_tag}`;
  }

  const result = await db.execute<BigmRow>(sql`
    SELECT
      id,
      bigm_similarity(${query}, content) AS score,
      content
    FROM observations
    WHERE ${whereSql}
    ORDER BY bigm_similarity(${query}, content) DESC
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    score: row.score,
    layer: "observation" as const,
    excerpt: makeExcerpt(row.content),
  }));
}

async function bigmMemories(params: {
  query: string;
  limit: number;
}): Promise<BigmHit[]> {
  const { query, limit } = params;

  const result = await db.execute<
    Record<string, unknown> & { id: string; score: number; narrative: string }
  >(sql`
    SELECT
      id,
      bigm_similarity(${query}, narrative) AS score,
      narrative
    FROM memories
    WHERE narrative LIKE likequery(${query})
      AND archived_at IS NULL
    ORDER BY bigm_similarity(${query}, narrative) DESC
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    score: row.score,
    layer: "memory" as const,
    excerpt: makeExcerpt(row.narrative),
  }));
}
