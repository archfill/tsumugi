import type { SearchHit } from "@tsumugi/shared";
import { linkRepo } from "../../data/repos/link.js";

export type SearchLayer = "observation" | "memory";

export interface SearchCandidate {
  id: string;
  layer: SearchLayer;
}

export interface SearchResultCandidate extends SearchCandidate {
  excerpt: string;
  score: number;
  tags?: string[];
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function hitKey(hit: SearchCandidate): string {
  return `${hit.layer}:${hit.id}`;
}

export async function filterMemoryHitsByProjectTag<
  T extends SearchCandidate,
>(hits: T[], projectTag: string | undefined): Promise<T[]> {
  if (!projectTag) return hits;

  const memoryIds = [
    ...new Set(
      hits.filter((hit) => hit.layer === "memory").map((hit) => hit.id),
    ),
  ];
  if (memoryIds.length === 0) return hits;

  const allowedMemoryIds = new Set(
    await linkRepo.listMemoryIdsDerivedFromProject(memoryIds, projectTag),
  );

  return hits.filter(
    (hit) => hit.layer === "observation" || allowedMemoryIds.has(hit.id),
  );
}

export async function attachProvenance(
  hits: SearchResultCandidate[],
): Promise<SearchHit[]> {
  const observationIds = hits
    .filter((hit) => hit.layer === "observation")
    .map((hit) => hit.id);
  const memoryIds = hits
    .filter((hit) => hit.layer === "memory")
    .map((hit) => hit.id);

  const rows = await linkRepo.listSearchProvenance({
    observationIds,
    memoryIds,
  });

  const byHit = new Map<
    string,
    Array<{
      layer: SearchLayer;
      id: string;
      relation: "derived_from" | "supersedes" | "related_to";
      created_at: string;
    }>
  >();

  for (const row of rows) {
    const key = hitKey({ id: row.hit_id, layer: row.hit_layer });
    const items = byHit.get(key) ?? [];
    items.push({
      layer: row.layer,
      id: row.id,
      relation: row.relation,
      created_at: toIsoString(row.created_at),
    });
    byHit.set(key, items);
  }

  return hits.map((hit) => ({
    id: hit.id,
    layer: hit.layer,
    excerpt: hit.excerpt,
    score: hit.score,
    tags: hit.tags ?? [],
    provenance: byHit.get(hitKey(hit)) ?? [],
  }));
}
