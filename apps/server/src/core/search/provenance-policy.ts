import type { SearchCandidate } from "./provenance.js";

export function removeDerivedMemoryCandidates<T extends SearchCandidate>(
  hits: T[],
  derivedMemoryIds: ReadonlySet<string>,
): T[] {
  return hits.filter(
    (hit) => hit.layer !== "memory" || !derivedMemoryIds.has(hit.id),
  );
}
