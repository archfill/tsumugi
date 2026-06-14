import type { BenchOutcome, BenchSummary, FixtureCase } from "./types.js";

export interface RunCaseFn<TInput, TExpected, TActual> {
  (
    fixture: FixtureCase<TInput, TExpected>,
  ): Promise<{ passed: boolean; actual: TActual; error?: string }>;
}

export interface ComputeMetricsFn<TInput, TExpected, TActual> {
  (
    outcomes: BenchOutcome<TActual>[],
    fixtures: FixtureCase<TInput, TExpected>[],
  ): { metrics: Record<string, number>; detail?: string };
}

export interface RunBenchOptions<TInput, TExpected, TActual> {
  name: string;
  fixtures: FixtureCase<TInput, TExpected>[];
  run: RunCaseFn<TInput, TExpected, TActual>;
  computeMetrics?: ComputeMetricsFn<TInput, TExpected, TActual>;
  /** Per-case timeout in ms. Cases exceeding this are marked errored. */
  timeoutMs?: number;
  /** Max parallelism (default 1: sequential). */
  concurrency?: number;
}

async function runWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`bench case timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runBench<TInput, TExpected, TActual>(
  options: RunBenchOptions<TInput, TExpected, TActual>,
): Promise<BenchSummary> {
  const { name, fixtures, run, computeMetrics } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const concurrency = Math.max(1, options.concurrency ?? 1);

  const outcomes: BenchOutcome<TActual>[] = [];
  const start = Date.now();

  let cursor = 0;
  async function worker() {
    while (cursor < fixtures.length) {
      const idx = cursor++;
      const fixture = fixtures[idx]!;
      const caseStart = Date.now();
      try {
        const { passed, actual, error } = await runWithTimeout(
          () => run(fixture),
          timeoutMs,
        );
        outcomes.push({
          caseId: fixture.id,
          description: fixture.description,
          passed,
          actual,
          error,
          durationMs: Date.now() - caseStart,
          tags: fixture.tags,
        });
      } catch (err) {
        outcomes.push({
          caseId: fixture.id,
          description: fixture.description,
          passed: false,
          actual: null,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - caseStart,
          tags: fixture.tags,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  outcomes.sort((a, b) => a.caseId.localeCompare(b.caseId));

  const totalDuration = Date.now() - start;
  const passed = outcomes.filter((o) => o.passed).length;
  const errored = outcomes.filter((o) => o.error && !o.passed).length;
  const failed = outcomes.length - passed - errored;
  const passRate = outcomes.length === 0 ? 0 : passed / outcomes.length;
  const avg =
    outcomes.length === 0
      ? 0
      : outcomes.reduce((a, o) => a + o.durationMs, 0) / outcomes.length;

  const aggregate = computeMetrics
    ? computeMetrics(outcomes, fixtures)
    : undefined;

  return {
    name,
    totalCases: fixtures.length,
    passed,
    failed,
    errored,
    passRate,
    totalDurationMs: totalDuration,
    avgDurationMs: avg,
    outcomes: outcomes as BenchOutcome<unknown>[],
    metrics: aggregate?.metrics,
    detail: aggregate?.detail,
  };
}
