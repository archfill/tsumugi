/**
 * Reciprocal Rank Fusion (RRF) implementation.
 *
 * Standard formula:  score(item) = Σ_list  1 / (k + rank_in_list)
 * where rank is 1-based and k=60 is the standard default.
 */

export interface RrfInput {
  id: string;
  layer: "observation" | "memory";
  excerpt: string;
}

export interface RrfResult extends RrfInput {
  score: number;
}

/**
 * Fuse multiple ranked lists via RRF.
 *
 * @param lists  Each list is already ranked (index 0 = rank 1).
 * @param opts   k controls rank discounting (default 60).
 * @returns      De-duplicated items sorted by descending RRF score.
 */
export function rrfFuse(
  lists: Array<Array<RrfInput>>,
  opts?: { k?: number },
): RrfResult[] {
  const k = opts?.k ?? 60;

  // Accumulate RRF scores by id.
  const scores = new Map<string, number>();
  // Keep the first-seen payload per id.
  const payloads = new Map<string, RrfInput>();

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      const rank = i + 1; // 1-based
      const contribution = 1 / (k + rank);

      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
      if (!payloads.has(item.id)) {
        payloads.set(item.id, item);
      }
    }
  }

  // Build result array and sort descending.
  const results: RrfResult[] = [];
  for (const [id, score] of scores) {
    const payload = payloads.get(id)!;
    results.push({ id, score, layer: payload.layer, excerpt: payload.excerpt });
  }
  results.sort((a, b) => b.score - a.score);

  return results;
}
