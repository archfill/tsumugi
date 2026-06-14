/**
 * pgvector cosine-similarity search for observations and memories.
 *
 * Uses `embedding <=> $vec` (cosine distance) for ordering.
 * Score = 1 - cosine_distance  (range 0‥1, higher = more similar).
 *
 * Float32Array → pgvector literal '[v0,v1,…]'::vector
 * Using toFixed(6) to avoid scientific notation (e.g. 1e-7) which pgvector
 * cannot parse.
 */

import { sql } from "drizzle-orm";
import { db } from "../../data/client.js";
import type { SearchInput } from "@tsumugi/shared";

export interface VectorHit {
  id: string;
  score: number;
  layer: "observation" | "memory";
  excerpt: string;
}

/** Convert a Float32Array (or number[]) to a pgvector literal string. */
function toVectorLiteral(v: Float32Array | number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < v.length; i++) {
    parts.push((v[i] ?? 0).toFixed(6));
  }
  return `[${parts.join(",")}]`;
}

/** Truncate text, keeping up to 200 chars. */
function makeExcerpt(text: string): string {
  if (text.length <= 200) return text;
  return text.slice(0, 200) + "…";
}

export async function vectorSearch(params: {
  embedding: Float32Array | number[];
  layer: "observation" | "memory";
  limit: number;
  filter?: SearchInput["filter"];
}): Promise<VectorHit[]> {
  const { embedding, layer, limit, filter } = params;
  const fetchLimit = limit * 3;
  const vecLiteral = toVectorLiteral(embedding);

  if (layer === "observation") {
    return vectorObservations({
      vecLiteral,
      limit: fetchLimit,
      filter,
    });
  } else {
    return vectorMemories({ vecLiteral, limit: fetchLimit });
  }
}

async function vectorObservations(params: {
  vecLiteral: string;
  limit: number;
  filter?: SearchInput["filter"];
}): Promise<VectorHit[]> {
  const { vecLiteral, limit, filter } = params;

  // Cast the literal to vector once; use as a SQL expression.
  const vecExpr = sql`${vecLiteral}::vector`;

  let whereSql = sql`embedding IS NOT NULL`;

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

  const result = await db.execute<
    Record<string, unknown> & { id: string; score: number; content: string }
  >(sql`
    SELECT
      id,
      1 - (embedding <=> ${vecExpr}) AS score,
      content
    FROM observations
    WHERE ${whereSql}
    ORDER BY embedding <=> ${vecExpr}
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    score: row.score,
    layer: "observation" as const,
    excerpt: makeExcerpt(row.content),
  }));
}

async function vectorMemories(params: {
  vecLiteral: string;
  limit: number;
}): Promise<VectorHit[]> {
  const { vecLiteral, limit } = params;

  const vecExpr = sql`${vecLiteral}::vector`;

  const result = await db.execute<
    Record<string, unknown> & { id: string; score: number; narrative: string }
  >(sql`
    SELECT
      id,
      1 - (embedding <=> ${vecExpr}) AS score,
      narrative
    FROM memories
    WHERE embedding IS NOT NULL
      AND archived_at IS NULL
    ORDER BY embedding <=> ${vecExpr}
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    score: row.score,
    layer: "memory" as const,
    excerpt: makeExcerpt(row.narrative),
  }));
}
