import { detectPairsOnly } from "../../src/core/dreaming/decision-contradiction.js";
import {
  fixtures as syntheticFixtures,
  type ContradictionExpected,
  type ContradictionInput,
  type ExpectedPair,
} from "../fixtures/contradiction.synthetic.js";
import { loadPrivateFixtures } from "../load-private.js";
import { runBench } from "../runner.js";
import type { BenchSummary } from "../types.js";

interface ContradictionActual {
  pairs: Array<ExpectedPair & { reasoning: string }>;
  precision: number;
  recall: number;
  f1: number;
}

function pairKey(pair: ExpectedPair): string {
  return `${pair.supersededIndex}:${pair.newIndex}`;
}

function scorePairs(expected: ExpectedPair[], actual: ExpectedPair[]) {
  const expectedSet = new Set(expected.map(pairKey));
  const actualSet = new Set(actual.map(pairKey));
  let truePositive = 0;

  for (const key of actualSet) {
    if (expectedSet.has(key)) truePositive++;
  }

  const precision =
    actualSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : truePositive / actualSet.size;
  const recall =
    expectedSet.size === 0 ? (actualSet.size === 0 ? 1 : 0) : truePositive / expectedSet.size;
  const f1 =
    precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1, truePositive };
}

export async function runContradictionBench(): Promise<BenchSummary> {
  const privateFixtures = await loadPrivateFixtures<
    ContradictionInput,
    ContradictionExpected
  >("contradiction.private.ts");
  const fixtures = [...syntheticFixtures, ...privateFixtures];

  return runBench<ContradictionInput, ContradictionExpected, ContradictionActual>({
    name: "contradiction",
    fixtures,
    concurrency: 4,
    timeoutMs: 60_000,
    run: async (fx) => {
      const detected = await detectPairsOnly(fx.input.decisions);
      const pairs = detected.map((p) => ({
        supersededIndex: p.supersededIndex,
        newIndex: p.newIndex,
        reasoning: p.reasoning,
      }));
      const score = scorePairs(fx.expected.pairs, pairs);
      return {
        passed: score.precision === 1 && score.recall === 1,
        actual: {
          pairs,
          precision: score.precision,
          recall: score.recall,
          f1: score.f1,
        },
      };
    },
    computeMetrics: (outcomes, allFixtures) => {
      const fxById = new Map(allFixtures.map((f) => [f.id, f]));
      let truePositive = 0;
      let detectedTotal = 0;
      let expectedTotal = 0;
      let trueNegative = 0;
      let noPairCases = 0;
      let included = 0;
      let jaccardSum = 0;
      const failures: string[] = [];

      for (const outcome of outcomes) {
        const fx = fxById.get(outcome.caseId);
        if (!fx || fx.tags?.includes("ambiguous") || outcome.error || !outcome.actual) {
          continue;
        }
        included++;
        const actual = outcome.actual as ContradictionActual;
        const expectedKeys = new Set(fx.expected.pairs.map(pairKey));
        const actualKeys = new Set(actual.pairs.map(pairKey));
        expectedTotal += expectedKeys.size;
        detectedTotal += actualKeys.size;

        if (expectedKeys.size === 0) {
          noPairCases++;
          if (actualKeys.size === 0) trueNegative++;
        }

        let intersection = 0;
        for (const key of actualKeys) {
          if (expectedKeys.has(key)) intersection++;
        }
        truePositive += intersection;
        const union = new Set([...expectedKeys, ...actualKeys]).size;
        jaccardSum += union === 0 ? 1 : intersection / union;

        if (!outcome.passed) {
          failures.push(
            `  - ${outcome.caseId}: expected=[${[...expectedKeys].join(", ")}] actual=[${[
              ...actualKeys,
            ].join(", ")}]`,
          );
        }
      }

      const precision =
        detectedTotal === 0 ? (expectedTotal === 0 ? 1 : 0) : truePositive / detectedTotal;
      const recall =
        expectedTotal === 0 ? (detectedTotal === 0 ? 1 : 0) : truePositive / expectedTotal;
      const f1 =
        precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

      return {
        metrics: {
          nonAmbiguousCases: included,
          precision,
          recall,
          f1,
          trueNegativeRate: noPairCases === 0 ? 1 : trueNegative / noPairCases,
          avgJaccard: included === 0 ? 0 : jaccardSum / included,
        },
        detail:
          failures.length === 0
            ? "all expected supersede pairs matched"
            : `failures:\n${failures.join("\n")}`,
      };
    },
  });
}
