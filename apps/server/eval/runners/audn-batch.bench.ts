import { judgeOnlyBatch } from "../../src/core/dreaming/audn.js";
import type { BenchOutcome, BenchSummary } from "../types.js";
import {
  loadAudnFixtures,
  type AudnExpected,
  type AudnFixture,
  type AudnFixtureLoadOptions,
} from "./audn.fixtures.js";
import {
  computeAudnMetrics,
  evaluateAudnResult,
  type AudnActual,
} from "./audn.metrics.js";

const DEFAULT_BATCH_SIZE = 3;
const BATCH_TIMEOUT_MS = 240_000;
const DECISION_ORDER: AudnExpected["decision"][] = [
  "ADD",
  "UPDATE",
  "DELETE",
  "NOOP",
];

export interface AudnBatchBenchOptions extends AudnFixtureLoadOptions {
  batchSize?: number;
}

function interleaveByDecision(fixtures: AudnFixture[]): AudnFixture[] {
  const buckets = new Map(
    DECISION_ORDER.map((decision) => [
      decision,
      fixtures.filter((fixture) => fixture.expected.decision === decision),
    ]),
  );
  const ordered: AudnFixture[] = [];
  while ([...buckets.values()].some((bucket) => bucket.length > 0)) {
    for (const decision of DECISION_ORDER) {
      const fixture = buckets.get(decision)?.shift();
      if (fixture) ordered.push(fixture);
    }
  }
  return ordered;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`AUDN batch timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runAudnBatchBench(
  options: AudnBatchBenchOptions = {},
): Promise<BenchSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("AUDN batch size must be a positive integer");
  }
  const fixtures = interleaveByDecision(await loadAudnFixtures(options));
  const batches = chunk(fixtures, batchSize);
  const outcomes: BenchOutcome<AudnActual>[] = [];
  const startedAt = Date.now();
  let logicalBatchCalls = 0;

  for (const batch of batches) {
    const batchStartedAt = Date.now();
    if (
      batch.some(
        (fixture) => fixture.input.existingMemoryNarratives.length > 0,
      )
    ) {
      logicalBatchCalls++;
    }

    try {
      const results = await withTimeout(
        judgeOnlyBatch(
          batch.map((fixture) => ({
            factId: fixture.id,
            newFact: fixture.input.newFact,
            existingMemoryNarratives:
              fixture.input.existingMemoryNarratives,
          })),
        ),
        BATCH_TIMEOUT_MS,
      );
      const resultsById = new Map(
        results.map((result) => [result.factId, result]),
      );
      const durationMs = Math.round(
        (Date.now() - batchStartedAt) / batch.length,
      );
      for (const fixture of batch) {
        const result = resultsById.get(fixture.id);
        if (!result) {
          outcomes.push({
            caseId: fixture.id,
            description: fixture.description,
            passed: false,
            actual: null,
            error: "batch result missing fixture",
            durationMs,
            tags: fixture.tags,
          });
          continue;
        }
        const evaluated = evaluateAudnResult(fixture.expected, result);
        outcomes.push({
          caseId: fixture.id,
          description: fixture.description,
          ...evaluated,
          durationMs,
          tags: fixture.tags,
        });
      }
    } catch (error) {
      const durationMs = Math.round(
        (Date.now() - batchStartedAt) / batch.length,
      );
      const message = error instanceof Error ? error.message : String(error);
      for (const fixture of batch) {
        outcomes.push({
          caseId: fixture.id,
          description: fixture.description,
          passed: false,
          actual: null,
          error: message,
          durationMs,
          tags: fixture.tags,
        });
      }
    }
  }

  const aggregate = computeAudnMetrics(outcomes, fixtures);
  const logicalSingleCalls = fixtures.filter(
    (fixture) => fixture.input.existingMemoryNarratives.length > 0,
  ).length;
  aggregate.metrics["batchSize"] = batchSize;
  aggregate.metrics["logicalBatchCalls"] = logicalBatchCalls;
  aggregate.metrics["logicalSingleCalls"] = logicalSingleCalls;
  aggregate.metrics["logicalCallReduction"] =
    logicalSingleCalls === 0
      ? 0
      : 1 - logicalBatchCalls / logicalSingleCalls;

  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const errored = outcomes.filter((outcome) => outcome.error).length;
  const failed = outcomes.length - passed - errored;
  const totalDurationMs = Date.now() - startedAt;
  return {
    name: "audn-batch",
    totalCases: outcomes.length,
    passed,
    failed,
    errored,
    passRate: outcomes.length === 0 ? 0 : passed / outcomes.length,
    totalDurationMs,
    avgDurationMs:
      outcomes.length === 0 ? 0 : totalDurationMs / outcomes.length,
    outcomes,
    metrics: aggregate.metrics,
    detail: aggregate.detail,
  };
}
