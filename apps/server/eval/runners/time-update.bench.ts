import { timeUpdateOnly } from "../../src/core/dreaming/time-update.js";
import { getEmbedder } from "../../src/external/embedding/singleton.js";
import {
  fixtures as syntheticFixtures,
  type TimeUpdateExpected,
  type TimeUpdateInput,
} from "../fixtures/time-update.synthetic.js";
import { loadPrivateFixtures } from "../load-private.js";
import { runBench } from "../runner.js";
import type { BenchSummary } from "../types.js";

interface TimeUpdateActual {
  narrative: string;
  reasoning: string;
  cosineSimilarity: number;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function runTimeUpdateBench(): Promise<BenchSummary> {
  const privateFixtures = await loadPrivateFixtures<
    TimeUpdateInput,
    TimeUpdateExpected
  >("time-update.private.ts");
  const fixtures = [...syntheticFixtures, ...privateFixtures];
  const embedder = getEmbedder();

  return runBench<TimeUpdateInput, TimeUpdateExpected, TimeUpdateActual>({
    name: "time-update",
    fixtures,
    concurrency: 4,
    timeoutMs: 90_000,
    run: async (fx) => {
      const result = await timeUpdateOnly(fx.input);
      const [actualEmbedding, expectedEmbedding] = await Promise.all([
        embedder.embed(result.narrative),
        embedder.embed(fx.expected.narrative),
      ]);
      const cosineSimilarity = cosine(actualEmbedding, expectedEmbedding);
      const minCosine = fx.expected.minCosine ?? 0.85;

      return {
        passed: cosineSimilarity >= minCosine,
        actual: {
          narrative: result.narrative,
          reasoning: result.reasoning,
          cosineSimilarity,
        },
      };
    },
    computeMetrics: (outcomes, allFixtures) => {
      const fxById = new Map(allFixtures.map((f) => [f.id, f]));
      let included = 0;
      let pass = 0;
      let cosineSum = 0;
      const failures: string[] = [];

      for (const outcome of outcomes) {
        const fx = fxById.get(outcome.caseId);
        if (!fx || fx.tags?.includes("ambiguous") || outcome.error || !outcome.actual) {
          continue;
        }
        included++;
        const actual = outcome.actual as TimeUpdateActual;
        cosineSum += actual.cosineSimilarity;
        if (outcome.passed) {
          pass++;
        } else {
          failures.push(
            `  - ${outcome.caseId}: cosine=${actual.cosineSimilarity.toFixed(3)} expected="${fx.expected.narrative}" actual="${actual.narrative}"`,
          );
        }
      }

      return {
        metrics: {
          nonAmbiguousCases: included,
          avgCosineSimilarity: included === 0 ? 0 : cosineSum / included,
          cosinePassRate: included === 0 ? 0 : pass / included,
        },
        detail:
          failures.length === 0
            ? "all time-update rewrites met cosine threshold"
            : `failures:\n${failures.join("\n")}`,
      };
    },
  });
}
