import type { PromoteCapturesResult } from "../capture/promote.js";

export type DreamingJob =
  | "promote-captures"
  | "sweep-captures"
  | "archive-outdated"
  // One-release compatibility aliases for removed server-LLM jobs.
  | "promote-observations"
  | "synthesize"
  | "time-update"
  | "decision-contradiction"
  | "reflection"
  | "full";

export interface DreamingStepResult {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export interface DreamingRunResult {
  job: DreamingJob;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: DreamingStepResult[];
}

export interface DreamingRunOptions {
  job: DreamingJob;
  signal?: AbortSignal;
  sessionId?: string;
  maxCaptures?: number;
  maxObservations?: number;
  maxMemories?: number;
  maxUpdates?: number;
  timeUpdateMaxRunMs?: number;
  timeUpdateMaxFailures?: number;
  timeUpdateMaxConsecutiveFailures?: number;
  timeUpdateStaleRunMs?: number;
}

const REMOVED_SERVER_LLM_JOBS = new Set<DreamingJob>([
  "promote-observations",
  "synthesize",
  "time-update",
  "decision-contradiction",
  "reflection",
  "full",
]);

function removedServerLlmResult(job: DreamingJob): DreamingRunResult {
  const timestamp = new Date().toISOString();
  return {
    job,
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    steps: [
      {
        name: job,
        ok: true,
        detail: { skipped: true, reason: "removed_server_llm" },
      },
    ],
  };
}

function promotionNeedsAttention(result: PromoteCapturesResult): boolean {
  return (
    result.errors.length > 0 ||
    result.stoppedReason === "run_budget_exceeded" ||
    result.stoppedReason === "failure_budget_exceeded" ||
    result.stoppedReason === "shutdown_requested"
  );
}

async function stepPromoteCaptures(
  maxCaptures: number,
  signal?: AbortSignal,
): Promise<DreamingStepResult> {
  const [{ dreamingRunRepo }, { newId }, { promoteCaptures }] =
    await Promise.all([
      import("../../data/repos/dreaming-run.js"),
      import("../../lib/id.js"),
      import("../capture/promote.js"),
    ]);
  const runId = newId("drun");
  try {
    await dreamingRunRepo.insert({
      id: runId,
      job_kind: "promote-captures",
      status: "pending",
      input_count: maxCaptures,
      output_count: 0,
    });
    await dreamingRunRepo.markRunning(runId);
    const result = await promoteCaptures(maxCaptures, { signal });
    const outputCount = result.promoted + result.skipped;
    const needsAttention = promotionNeedsAttention(result);
    if (needsAttention) {
      await dreamingRunRepo.markPartial(
        runId,
        outputCount,
        result.errors.join("\n") ||
          `promotion stopped: ${result.stoppedReason}`,
        { ...result },
      );
    } else {
      await dreamingRunRepo.markCompleted(runId, outputCount, { ...result });
    }
    return {
      name: "promote-captures",
      ok: !needsAttention,
      detail: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dreamingRunRepo.markFailed(runId, message);
    return { name: "promote-captures", ok: false, error: message };
  }
}

async function stepSweepCaptures(): Promise<DreamingStepResult> {
  try {
    const [{ captureRepo }, { capturePromotionWindowRepo }] =
      await Promise.all([
        import("../../data/repos/capture.js"),
        import("../../data/repos/capture-promotion-window.js"),
      ]);
    const [deletedPromoted, deletedExpired, clearedWindowContent] =
      await Promise.all([
        captureRepo.deletePromoted(),
        captureRepo.sweepExpired(),
        capturePromotionWindowRepo.clearExpiredContent(),
      ]);
    return {
      name: "sweep-captures",
      ok: true,
      detail: { deletedPromoted, deletedExpired, clearedWindowContent },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "sweep-captures", ok: false, error: message };
  }
}

async function stepArchiveOutdated(
  maxMemories: number,
): Promise<DreamingStepResult> {
  const [{ dreamingRunRepo }, { newId }, { archiveOutdatedMemories }] =
    await Promise.all([
      import("../../data/repos/dreaming-run.js"),
      import("../../lib/id.js"),
      import("./archive-outdated.js"),
    ]);
  const runId = newId("drun");
  try {
    await dreamingRunRepo.insert({
      id: runId,
      job_kind: "archive-outdated",
      status: "pending",
      input_count: maxMemories,
      output_count: 0,
    });
    await dreamingRunRepo.markRunning(runId);
    const detail = await archiveOutdatedMemories(runId, maxMemories);
    return {
      name: "archive-outdated",
      ok: true,
      detail: { runId, ...detail },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dreamingRunRepo.markFailed(runId, message);
    return {
      name: "archive-outdated",
      ok: false,
      error: message,
      detail: { runId },
    };
  }
}

async function runActiveDreaming(
  opts: DreamingRunOptions,
): Promise<DreamingRunResult> {
  const { recoverStaleDreamingRuns } = await import("./recover.js");
  await recoverStaleDreamingRuns();

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let step: DreamingStepResult;
  switch (opts.job) {
    case "promote-captures":
      step = await stepPromoteCaptures(
        opts.maxCaptures ?? 200,
        opts.signal,
      );
      break;
    case "sweep-captures":
      step = await stepSweepCaptures();
      break;
    case "archive-outdated":
      step = await stepArchiveOutdated(opts.maxMemories ?? 500);
      break;
    default:
      return removedServerLlmResult(opts.job);
  }

  const durationMs = Date.now() - startedMs;
  const { dreamingRunDurationSeconds, dreamingRunsTotal } = await import(
    "../../lib/metrics.js"
  );
  dreamingRunDurationSeconds.observe({ job: opts.job }, durationMs / 1000);
  dreamingRunsTotal.inc({
    job: opts.job,
    status: step.ok ? "success" : "partial",
  });
  return {
    job: opts.job,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    steps: [step],
  };
}

export async function runDreaming(
  opts: DreamingRunOptions,
): Promise<DreamingRunResult> {
  // Compatibility jobs must not load DB modules, recover stale runs, create a
  // run record, claim durable work, or change retry/quarantine state.
  if (REMOVED_SERVER_LLM_JOBS.has(opts.job)) {
    return removedServerLlmResult(opts.job);
  }
  const { dreamingExecutionCoordinator } = await import("./execution.js");
  return await dreamingExecutionCoordinator.run(
    opts.job,
    opts.signal,
    (signal) => runActiveDreaming({ ...opts, signal }),
  );
}
