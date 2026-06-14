/**
 * Hybrid search public API.
 *
 * Combines pg_bigm keyword search and pgvector cosine similarity search,
 * fused via Reciprocal Rank Fusion (RRF).
 */

import { SearchInput as SearchInputSchema } from "@tsumugi/shared";
import type { SearchInput, SearchHit } from "@tsumugi/shared";
import { getEmbedder } from "../embedding/singleton.js";
import { bigmSearch } from "./bigm.js";
import { vectorSearch } from "./vector.js";
import { rrfFuse } from "./rrf.js";

export type { SearchHit };

export interface HybridSearchOptions {
  /** RRF k constant (default 60). */
  rrfK?: number;
  /** Layers to search (default: both). */
  layers?: ("observation" | "memory")[];
}

/**
 * Hybrid search across observations and memories.
 *
 * 1. Validates input with Zod.
 * 2. Embeds the query with BGE-M3.
 * 3. Runs bigm + vector search in parallel per requested layer.
 * 4. Fuses results with RRF and returns top `limit` hits.
 */
export async function hybridSearch(
  input: SearchInput,
  opts?: HybridSearchOptions,
): Promise<SearchHit[]> {
  // 1. Validate.
  const parsed = SearchInputSchema.parse(input);
  const { query, limit, filter } = parsed;

  const k = opts?.rrfK ?? 60;
  const layers = opts?.layers ?? ["observation", "memory"];

  // Determine which filters make memory search irrelevant.
  // memories table lacks source / session_id / project_tag columns.
  const hasObservationOnlyFilter =
    filter?.source !== undefined ||
    filter?.session_id !== undefined ||
    filter?.project_tag !== undefined;

  const effectiveLayers = hasObservationOnlyFilter
    ? layers.filter((l) => l === "observation")
    : layers;

  // 2. Embed query.
  const embedder = getEmbedder();
  const embedding = await embedder.embed(query);

  // 3. Run bigm + vector in parallel for each layer.
  const bigmPromises = effectiveLayers.map((layer) =>
    bigmSearch({ query, layer, limit, filter }),
  );
  const vectorPromises = effectiveLayers.map((layer) =>
    vectorSearch({ embedding, layer, limit, filter }),
  );

  const [bigmResults, vectorResults] = await Promise.all([
    Promise.all(bigmPromises),
    Promise.all(vectorPromises),
  ]);

  // Flatten per-layer results into ranked lists.
  const bigmFlat = bigmResults.flat();
  const vectorFlat = vectorResults.flat();

  // 4. RRF fusion.
  const fused = rrfFuse([bigmFlat, vectorFlat], { k });

  // 5. Trim and map to SearchHit.
  return fused.slice(0, limit).map((item) => ({
    id: item.id,
    layer: item.layer,
    excerpt: item.excerpt,
    score: item.score,
    tags: [],
  }));
}
