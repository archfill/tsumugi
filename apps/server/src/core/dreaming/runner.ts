/**
 * Dreaming Runner — Phase 2 Wave 4 (Orchestrator)
 *
 * Runs one or more dreaming jobs in order and records per-step results.
 * Each step is individually try/caught; failure of one step does not abort
 * subsequent steps (best-effort execution).
 *
 * Usage:
 *   const result = await runDreaming({ job: 'full' });
 *   const result = await runDreaming({ job: 'reflection', sessionId: 'ses_...' });
 */

import { captureRepo } from "../../data/repos/capture.js";
import { capturePromotionWindowRepo } from "../../data/repos/capture-promotion-window.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import { promoteCaptures } from "../capture/promote.js";
import { promoteObservations } from "../observation/promote.js";
import { synthesizeMemories } from "./synthesize.js";
import { timeAwareMemoryUpdate } from "./time-update.js";
import { detectDecisionContradictions } from "./decision-contradiction.js";
import { reflectOnSession } from "./reflection.js";
import { ValidationError } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import {
  dreamingRunDurationSeconds,
  dreamingRunsTotal,
} from "../../lib/metrics.js";
import { dreamingExecutionCoordinator } from "./execution.js";
import { recoverStaleDreamingRuns } from "./recover.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DreamingJob =
  | "promote-captures" // summarize Layer 1 captures into Layer 2 observations
  | "sweep-captures"
  | "promote-observations" // summarize + AUDN judge for pending observations
  | "synthesize"
  | "time-update"
  | "decision-contradiction"
  | "reflection"
  | "full"; // all jobs in sequence (except reflection)

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
  /** Cooperative shutdown signal checked between durable work items. */
  signal?: AbortSignal;
  /** Required for 'reflection' job. */
  sessionId?: string;
  /** Max observations to promote per run (default 50). */
  maxObservations?: number;
  /** Max captures to promote per run (default 50). */
  maxCaptures?: number;
  /** Max memories to load for synthesize / time-update (default 500). */
  maxMemories?: number;
  /** Max memories to actually rewrite in time-update (default 50). */
  maxUpdates?: number;
  /** Max wall-clock time for time-update before graceful stop. */
  timeUpdateMaxRunMs?: number;
  /** Max per-memory LLM failures before time-update stops early. */
  timeUpdateMaxFailures?: number;
  /** Max consecutive per-memory LLM failures before time-update stops early. */
  timeUpdateMaxConsecutiveFailures?: number;
  /** Age after which a previous running time-update is marked stale. */
  timeUpdateStaleRunMs?: number;
}

function promotionNeedsAttention(result: {
  errors: string[];
  stoppedReason: string;
}): boolean {
  return (
    result.errors.length > 0 ||
    result.stoppedReason === "waiting_for_retry" ||
    result.stoppedReason === "shutdown_requested"
  );
}

// ---------------------------------------------------------------------------
// Step runners
// ---------------------------------------------------------------------------

async function stepPromoteObservations(
  maxObservations: number,
  signal?: AbortSignal,
): Promise<DreamingStepResult> {
  const runId = newId("drun");
  try {
    await dreamingRunRepo.insert({
      id: runId,
      job_kind: "promote-observations",
      status: "pending",
      input_count: maxObservations,
      output_count: 0,
    });
    await dreamingRunRepo.markRunning(runId);
    const result = await promoteObservations({
      maxObservations,
      maxFacts: maxObservations,
      signal,
    });
    const needsAttention = promotionNeedsAttention(result);
    if (needsAttention) {
      await dreamingRunRepo.markPartial(
        runId,
        result.factsCompleted,
        result.errors.join("\n") || `promotion stopped: ${result.stoppedReason}`,
        { ...result },
      );
    } else {
      await dreamingRunRepo.markCompleted(runId, result.factsCompleted, {
        ...result,
      });
    }
    return {
      name: "promote-observations",
      ok: !needsAttention,
      detail: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dreamingRunRepo.markFailed(runId, msg);
    return {
      name: "promote-observations",
      ok: false,
      error: msg,
    };
  }
}

async function stepPromoteCaptures(
  maxCaptures: number,
  signal?: AbortSignal,
): Promise<DreamingStepResult> {
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
    const needsAttention = promotionNeedsAttention(result);
    if (needsAttention) {
      await dreamingRunRepo.markPartial(
        runId,
        result.promoted + result.skipped,
        result.errors.join("\n") || `promotion stopped: ${result.stoppedReason}`,
        { ...result },
      );
    } else {
      await dreamingRunRepo.markCompleted(
        runId,
        result.promoted + result.skipped,
        { ...result },
      );
    }
    return {
      name: "promote-captures",
      ok: !needsAttention,
      detail: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dreamingRunRepo.markFailed(runId, msg);
    return {
      name: "promote-captures",
      ok: false,
      error: msg,
    };
  }
}

async function stepSweepCaptures(): Promise<DreamingStepResult> {
  try {
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "sweep-captures",
      ok: false,
      error: msg,
    };
  }
}

async function stepSynthesize(
  maxMemories: number,
  signal?: AbortSignal,
): Promise<DreamingStepResult> {
  try {
    const result = await synthesizeMemories({ maxMemories, signal });
    return {
      name: "synthesize",
      ok:
        result.errors.length === 0 && result.stoppedReason !== "shutdown_requested",
      detail: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "synthesize",
      ok: false,
      error: msg,
    };
  }
}

async function stepTimeUpdate(
  maxMemories: number,
  maxUpdates: number,
  opts?: {
    maxRunMs?: number;
    maxFailures?: number;
    maxConsecutiveFailures?: number;
    staleRunMs?: number;
    signal?: AbortSignal;
  },
): Promise<DreamingStepResult> {
  try {
    const result = await timeAwareMemoryUpdate({
      maxMemories,
      maxUpdates,
      maxRunMs: opts?.maxRunMs,
      maxFailures: opts?.maxFailures,
      maxConsecutiveFailures: opts?.maxConsecutiveFailures,
      staleRunMs: opts?.staleRunMs,
      signal: opts?.signal,
    });
    return {
      name: "time-update",
      ok:
        result.errors.length === 0 && result.stoppedReason !== "shutdown_requested",
      detail: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "time-update",
      ok: false,
      error: msg,
    };
  }
}

async function stepDecisionContradiction(
  signal?: AbortSignal,
): Promise<DreamingStepResult> {
  try {
    const result = await detectDecisionContradictions({ signal });
    return {
      name: "decision-contradiction",
      ok: result.stoppedReason !== "shutdown_requested",
      detail: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "decision-contradiction",
      ok: false,
      error: msg,
    };
  }
}

async function stepReflection(
  sessionId: string,
  signal?: AbortSignal,
): Promise<DreamingStepResult> {
  try {
    const result = await reflectOnSession({ sessionId, signal });
    return {
      name: "reflection",
      ok:
        result.errors.length === 0 && result.stoppedReason !== "shutdown_requested",
      detail: result,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "reflection",
      ok: false,
      error: msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run one or more dreaming jobs.
 *
 * - Each step is wrapped in try/catch; failure continues to next step (best-effort).
 * - 'full' runs: promote-observations → synthesize → time-update → decision-contradiction.
 *   reflection is excluded from full because it requires an explicit sessionId.
 * - 'reflection' requires opts.sessionId; throws ValidationError if missing.
 */
async function runDreamingInternal(
  opts: DreamingRunOptions,
): Promise<DreamingRunResult> {
  const {
    job,
    sessionId,
    maxObservations = 50,
    maxCaptures = 200,
    maxMemories = 500,
    maxUpdates = 50,
    timeUpdateMaxRunMs,
    timeUpdateMaxFailures,
    timeUpdateMaxConsecutiveFailures,
    timeUpdateStaleRunMs,
    signal,
  } = opts;

  if (job === "reflection" && !sessionId) {
    throw new ValidationError(
      "runDreaming: sessionId is required for job='reflection'",
    );
  }

  await recoverStaleDreamingRuns();

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const steps: DreamingStepResult[] = [];

  switch (job) {
    case "promote-captures":
      steps.push(await stepPromoteCaptures(maxCaptures, signal));
      break;

    case "sweep-captures":
      steps.push(await stepSweepCaptures());
      break;

    case "promote-observations":
      steps.push(await stepPromoteObservations(maxObservations, signal));
      break;

    case "synthesize":
      steps.push(await stepSynthesize(maxMemories, signal));
      break;

    case "time-update":
      steps.push(
        await stepTimeUpdate(maxMemories, maxUpdates, {
          maxRunMs: timeUpdateMaxRunMs,
          maxFailures: timeUpdateMaxFailures,
          maxConsecutiveFailures: timeUpdateMaxConsecutiveFailures,
          staleRunMs: timeUpdateStaleRunMs,
          signal,
        }),
      );
      break;

    case "decision-contradiction":
      steps.push(await stepDecisionContradiction(signal));
      break;

    case "reflection":
      steps.push(await stepReflection(sessionId!, signal));
      break;

    case "full":
      // Sequence: capture promotion → observation promotion → synthesize → time-update → decision-contradiction
      steps.push(await stepPromoteCaptures(maxCaptures, signal));
      if (signal?.aborted) break;
      steps.push(await stepPromoteObservations(maxObservations, signal));
      if (signal?.aborted) break;
      steps.push(await stepSynthesize(maxMemories, signal));
      if (signal?.aborted) break;
      steps.push(
        await stepTimeUpdate(maxMemories, maxUpdates, {
          maxRunMs: timeUpdateMaxRunMs,
          maxFailures: timeUpdateMaxFailures,
          maxConsecutiveFailures: timeUpdateMaxConsecutiveFailures,
          staleRunMs: timeUpdateStaleRunMs,
          signal,
        }),
      );
      if (signal?.aborted) break;
      steps.push(await stepDecisionContradiction(signal));
      break;

    default: {
      const _exhaustive: never = job;
      throw new ValidationError(
        `runDreaming: unknown job '${String(_exhaustive)}'`,
      );
    }
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  // Record metrics: 'success' if every step succeeded, otherwise 'partial'
  const allOk = steps.every((s) => s.ok);
  dreamingRunDurationSeconds.observe({ job }, durationMs / 1000);
  dreamingRunsTotal.inc({ job, status: allOk ? "success" : "partial" });

  return {
    job,
    startedAt,
    finishedAt,
    durationMs,
    steps,
  };
}

export function runDreaming(
  opts: DreamingRunOptions,
): Promise<DreamingRunResult> {
  return dreamingExecutionCoordinator.run(opts.job, opts.signal, (signal) =>
    runDreamingInternal({ ...opts, signal }),
  );
}
