import { removeDerivedMemoryCandidates } from "./provenance-policy.js";

type Candidate = { id: string; layer: "observation" | "memory"; score: number };
type Case = { id: string; candidates: Candidate[]; relevantId: string; derived: string[]; limit: number };

export const provenancePolicyCases: Case[] = [
  { id: "linked_preferred", relevantId: "obs_a", derived: ["mem_a"], limit: 2, candidates: [
    { id: "mem_a", layer: "memory", score: 3 }, { id: "obs_a", layer: "observation", score: 2 }, { id: "mem_standalone", layer: "memory", score: 1 },
  ] },
  { id: "standalone_relevant", relevantId: "mem_standalone", derived: ["mem_pair"], limit: 2, candidates: [
    { id: "mem_standalone", layer: "memory", score: 3 }, { id: "obs_b", layer: "observation", score: 2 }, { id: "mem_pair", layer: "memory", score: 1 },
  ] },
  { id: "memory_only", relevantId: "mem_only", derived: [], limit: 2, candidates: [
    { id: "mem_only", layer: "memory", score: 2 }, { id: "mem_other", layer: "memory", score: 1 },
  ] },
];

function metrics(rows: Array<{ hits: Candidate[]; relevantId: string }>) {
  const total = rows.length;
  let r1 = 0, r5 = 0, mrr = 0, count = 0;
  for (const row of rows) {
    const rank = row.hits.findIndex((hit) => hit.id === row.relevantId) + 1;
    if (rank === 1) r1++;
    if (rank > 0 && rank <= 5) r5++;
    if (rank > 0) mrr += 1 / rank;
    count += row.hits.length;
  }
  return { recallAt1: r1 / total, recallAt5: r5 / total, mrr: mrr / total, averageReturnedCount: count / total };
}

export function evaluateProvenancePolicy() {
  const baselineRows = provenancePolicyCases.map((item) => ({ hits: item.candidates.slice(0, item.limit), relevantId: item.relevantId }));
  const afterRows = provenancePolicyCases.map((item) => ({ hits: removeDerivedMemoryCandidates(item.candidates, new Set(item.derived)).slice(0, item.limit), relevantId: item.relevantId }));
  return {
    baseline: { ...metrics(baselineRows), linkedSuppressedCount: 0 },
    after: { ...metrics(afterRows), linkedSuppressedCount: provenancePolicyCases.reduce((n, item) => n + item.derived.length, 0) },
  };
}
