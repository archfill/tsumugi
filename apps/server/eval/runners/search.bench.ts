import { like } from "drizzle-orm";
import { db } from "../../src/data/client.js";
import { memories } from "../../src/data/schema.js";
import { memoryRepo } from "../../src/data/repos/memory.js";
import { hybridSearch } from "../../src/core/search/hybrid.js";
import { getEmbedder } from "../../src/external/embedding/singleton.js";
import { logger } from "../../src/lib/logger.js";
import {
  fixtures as syntheticFixtures,
  seedMemories,
  type SearchExpected,
  type SearchInput,
} from "../fixtures/search.synthetic.js";
import { loadPrivateFixtures } from "../load-private.js";
import { runBench } from "../runner.js";
import type { BenchSummary } from "../types.js";

interface SearchActual {
  hitIds: string[];
  bestRank: number | null;
}

const SEED_ID_PREFIX = "mem_evalseed_";

async function wipeSeedMemories(): Promise<number> {
  const result = await db
    .delete(memories)
    .where(like(memories.id, `${SEED_ID_PREFIX}%`));
  return result.rowCount ?? 0;
}

async function seedSearchMemories(): Promise<void> {
  const embedder = getEmbedder();
  for (const m of seedMemories) {
    const embedding = Array.from(await embedder.embed(m.narrative));
    await memoryRepo.insert({
      id: m.id,
      narrative: m.narrative,
      importance: m.importance ?? 5.0,
      kind: m.kind ?? "general",
      embedding,
    });
  }
}

export async function runSearchBench(): Promise<BenchSummary> {
  const removed = await wipeSeedMemories();
  if (removed > 0) {
    logger.info(
      { removed },
      "search bench: cleaned up leftover seed memories before seeding",
    );
  }
  await seedSearchMemories();
  logger.info({ count: seedMemories.length }, "search bench: seeded memories");

  const privateFixtures = await loadPrivateFixtures<
    SearchInput,
    SearchExpected
  >("search.private.ts");
  const fixtures = [...syntheticFixtures, ...privateFixtures];

  try {
    return await runBench<SearchInput, SearchExpected, SearchActual>({
      name: "search",
      fixtures,
      concurrency: 4,
      timeoutMs: 30_000,
      run: async (fx) => {
        const hits = await hybridSearch(
          { query: fx.input.query, limit: fx.input.limit },
          { layers: ["memory"] },
        );
        const hitIds = hits.map((h) => h.id);
        const seedHitIds = hitIds.filter((id) => id.startsWith(SEED_ID_PREFIX));
        let bestRank: number | null = null;
        if (fx.expected.expectNoHits) {
          // Pass if no SEED hits returned (irrelevant query).
          return {
            passed: seedHitIds.length === 0,
            actual: { hitIds, bestRank },
          };
        }
        for (let i = 0; i < hitIds.length; i++) {
          if (fx.expected.expectedIds.includes(hitIds[i]!)) {
            bestRank = i + 1;
            break;
          }
        }
        // Pass if at least one expected ID is in top-k.
        return {
          passed: bestRank !== null,
          actual: { hitIds, bestRank },
        };
      },
      computeMetrics: (outcomes, allFixtures) => {
        const fxById = new Map(allFixtures.map((f) => [f.id, f]));
        let top1 = 0,
          top3 = 0,
          top5 = 0;
        let rrSum = 0,
          relevantCases = 0;
        let irrelevantCases = 0,
          irrelevantPass = 0;
        const failures: string[] = [];
        for (const o of outcomes) {
          const fx = fxById.get(o.caseId);
          if (!fx) continue;
          if (o.error) continue;
          if (!o.actual) continue;
          const actual = o.actual as SearchActual;
          if (fx.expected.expectNoHits) {
            irrelevantCases++;
            if (o.passed) irrelevantPass++;
            else
              failures.push(
                `  - ${o.caseId}: irrelevant query returned seed hits`,
              );
            continue;
          }
          relevantCases++;
          const r = actual.bestRank;
          if (r !== null) {
            rrSum += 1 / r;
            if (r === 1) top1++;
            if (r <= 3) top3++;
            if (r <= 5) top5++;
          } else {
            failures.push(
              `  - ${o.caseId}: no expected id in top-${fx.input.limit}`,
            );
          }
        }
        const metrics: Record<string, number> = {
          relevantCases,
          recallAt1: relevantCases === 0 ? 0 : top1 / relevantCases,
          recallAt3: relevantCases === 0 ? 0 : top3 / relevantCases,
          recallAt5: relevantCases === 0 ? 0 : top5 / relevantCases,
          mrr: relevantCases === 0 ? 0 : rrSum / relevantCases,
          irrelevantCases,
          irrelevantRejectRate:
            irrelevantCases === 0 ? 1 : irrelevantPass / irrelevantCases,
        };
        const detail =
          failures.length === 0
            ? "all relevant queries hit, all irrelevant queries rejected ✓"
            : `failures:\n${failures.join("\n")}`;
        return { metrics, detail };
      },
    });
  } finally {
    const cleaned = await wipeSeedMemories();
    logger.info({ cleaned }, "search bench: wiped seed memories after run");
  }
}
