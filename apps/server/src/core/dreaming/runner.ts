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

import { observationRepo } from "../../data/repos/observation.js";
import { summarizeObservation } from "../observation/summarize.js";
import { audnJudge } from "./audn.js";
import { synthesizeMemories } from "./synthesize.js";
import { timeAwareMemoryUpdate } from "./time-update.js";
import { detectDecisionContradictions } from "./decision-contradiction.js";
import { reflectOnSession } from "./reflection.js";
import { ValidationError } from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DreamingJob =
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
  /** Required for 'reflection' job. */
  sessionId?: string;
  /** Max observations to promote per run (default 50). */
  maxObservations?: number;
  /** Max memories to load for synthesize / time-update (default 500). */
  maxMemories?: number;
  /** Max memories to actually rewrite in time-update (default 50). */
  maxUpdates?: number;
}

// ---------------------------------------------------------------------------
// Step runners
// ---------------------------------------------------------------------------

async function stepPromoteObservations(
  maxObservations: number,
): Promise<DreamingStepResult> {
  try {
    const observations = await observationRepo.listPending(maxObservations);
    let promoted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const observation of observations) {
      try {
        const summary = await summarizeObservation(observation);
        if (summary.skip) {
          await observationRepo.markPromoted(observation.id);
          skipped++;
          continue;
        }
        let hasAudnError = false;
        // Call AUDN judge for each fact extracted from this observation.
        for (const fact of summary.facts) {
          try {
            await audnJudge({
              newFact: fact,
              sourceObservationId: observation.id,
            });
          } catch (err) {
            hasAudnError = true;
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`audn(obs=${observation.id}): ${msg}`);
          }
        }
        if (hasAudnError) {
          continue;
        }
        await observationRepo.markPromoted(observation.id);
        promoted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`summarize(obs=${observation.id}): ${msg}`);
      }
    }

    return {
      name: "promote-observations",
      ok: true,
      detail: {
        total: observations.length,
        promoted,
        skipped,
        errors,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "promote-observations",
      ok: false,
      error: msg,
    };
  }
}

async function stepSynthesize(
  maxMemories: number,
): Promise<DreamingStepResult> {
  try {
    const result = await synthesizeMemories({ maxMemories });
    return {
      name: "synthesize",
      ok: true,
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
): Promise<DreamingStepResult> {
  try {
    const result = await timeAwareMemoryUpdate({ maxMemories, maxUpdates });
    return {
      name: "time-update",
      ok: true,
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

async function stepDecisionContradiction(): Promise<DreamingStepResult> {
  try {
    const result = await detectDecisionContradictions({});
    return {
      name: "decision-contradiction",
      ok: true,
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

async function stepReflection(sessionId: string): Promise<DreamingStepResult> {
  try {
    const result = await reflectOnSession({ sessionId });
    return {
      name: "reflection",
      ok: true,
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
export async function runDreaming(
  opts: DreamingRunOptions,
): Promise<DreamingRunResult> {
  const {
    job,
    sessionId,
    maxObservations = 50,
    maxMemories = 500,
    maxUpdates = 50,
  } = opts;

  if (job === "reflection" && !sessionId) {
    throw new ValidationError(
      "runDreaming: sessionId is required for job='reflection'",
    );
  }

  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const steps: DreamingStepResult[] = [];

  switch (job) {
    case "promote-observations":
      steps.push(await stepPromoteObservations(maxObservations));
      break;

    case "synthesize":
      steps.push(await stepSynthesize(maxMemories));
      break;

    case "time-update":
      steps.push(await stepTimeUpdate(maxMemories, maxUpdates));
      break;

    case "decision-contradiction":
      steps.push(await stepDecisionContradiction());
      break;

    case "reflection":
      steps.push(await stepReflection(sessionId!));
      break;

    case "full":
      // Sequence: promote → synthesize → time-update → decision-contradiction
      steps.push(await stepPromoteObservations(maxObservations));
      steps.push(await stepSynthesize(maxMemories));
      steps.push(await stepTimeUpdate(maxMemories, maxUpdates));
      steps.push(await stepDecisionContradiction());
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

  return {
    job,
    startedAt,
    finishedAt,
    durationMs,
    steps,
  };
}
