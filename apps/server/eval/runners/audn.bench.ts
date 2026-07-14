import { judgeOnly } from "../../src/core/dreaming/audn.js";
import { runBench } from "../runner.js";
import type { BenchSummary } from "../types.js";
import {
  loadAudnFixtures,
  type AudnExpected,
  type AudnFixtureLoadOptions,
  type AudnInput,
} from "./audn.fixtures.js";
import {
  computeAudnMetrics,
  evaluateAudnResult,
  type AudnActual,
} from "./audn.metrics.js";

export type AudnBenchOptions = AudnFixtureLoadOptions;

export async function runAudnBench(
  options: AudnBenchOptions = {},
): Promise<BenchSummary> {
  const fixtures = await loadAudnFixtures(options);

  return runBench<AudnInput, AudnExpected, AudnActual>({
    name: "audn",
    fixtures,
    concurrency: 4,
    // A provider request may use three 30-second attempts plus retry delays.
    // Keep the bench timeout above that budget so provider retry is not
    // misclassified as a fixture failure.
    timeoutMs: 180_000,
    run: async (fx) => {
      const result = await judgeOnly({
        newFact: fx.input.newFact,
        existingMemoryNarratives: fx.input.existingMemoryNarratives,
      });
      return evaluateAudnResult(fx.expected, result);
    },
    computeMetrics: computeAudnMetrics,
  });
}
