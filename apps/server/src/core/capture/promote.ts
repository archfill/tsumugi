import { createHash } from "node:crypto";
import { captureRepo } from "../../data/repos/capture.js";
import { capturePromotionWindowRepo } from "../../data/repos/capture-promotion-window.js";
import { withPgAdvisoryLock } from "../../data/advisory-lock.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { newId } from "../../lib/id.js";
import { summarizeObservation } from "../observation/summarize.js";
import { buildCaptureWindows } from "./window.js";

export type PromoteCapturesStoppedReason =
  | "completed"
  | "active_run_in_progress"
  | "run_budget_exceeded"
  | "failure_budget_exceeded";

export interface PromoteCapturesResult {
  capturesSelected: number;
  windowsCreated: number;
  windowsSelected: number;
  promoted: number;
  skipped: number;
  deferred: number;
  quarantined: number;
  deletedPromoted: number;
  runSkipped: boolean;
  stoppedReason: PromoteCapturesStoppedReason;
  errors: string[];
}

function syntheticObservation(
  window: Awaited<
    ReturnType<typeof capturePromotionWindowRepo.listEligible>
  >[number],
) {
  return {
    id: window.id,
    content: window.input_content ?? "",
    type: "other",
    source: window.source,
    source_layer: "capture",
    session_id: window.session_id,
    project_tag: window.project_tag,
    facts: null,
    metadata: {
      promotion_window_id: window.id,
      capture_count: window.capture_count,
      completed_turns: window.completed_turns,
      fallback: window.fallback,
    },
    embedding: null,
    created_at: window.cutoff_at,
    promoted_at: null,
    promotion_state: "ready",
    search_text: window.input_content ?? "",
  };
}

function factRows(observationId: string, facts: string[]) {
  const unique = [...new Set(facts.map((fact) => fact.trim()).filter(Boolean))];
  return unique.map((fact, ordinal) => ({
    id: newId("fact"),
    observation_id: observationId,
    fact_hash: createHash("sha256").update(fact).digest("hex"),
    fact,
    ordinal,
  }));
}

export async function promoteCaptures(
  maxCaptures = 200,
  options?: {
    maxWindows?: number;
    maxRunMs?: number;
    maxFailures?: number;
  },
): Promise<PromoteCapturesResult> {
  return await withPgAdvisoryLock(
    "tsumugi:promote-captures",
    () =>
      promoteCapturesLocked(maxCaptures, {
        maxWindows: options?.maxWindows ?? 10,
        maxRunMs: options?.maxRunMs ?? 10 * 60 * 1000,
        maxFailures: options?.maxFailures ?? 5,
      }),
    async () => ({
      capturesSelected: 0,
      windowsCreated: 0,
      windowsSelected: 0,
      promoted: 0,
      skipped: 0,
      deferred: 0,
      quarantined: 0,
      deletedPromoted: 0,
      runSkipped: true,
      stoppedReason: "active_run_in_progress",
      errors: [],
    }),
  );
}

async function promoteCapturesLocked(
  maxCaptures: number,
  options: { maxWindows: number; maxRunMs: number; maxFailures: number },
): Promise<PromoteCapturesResult> {
  const startedAt = Date.now();
  const ready = await captureRepo.listReady(maxCaptures);
  const candidates = buildCaptureWindows(ready);
  let windowsCreated = 0;
  for (const candidate of candidates) {
    const windowId = newId("win");
    await capturePromotionWindowRepo.create(
      {
        id: windowId,
        source: candidate.source,
        session_id: candidate.sessionId,
        project_tag: candidate.projectTag,
        cutoff_at: candidate.cutoffAt,
        capture_count: candidate.captureIds.length,
        raw_chars: candidate.rawChars,
        completed_turns: candidate.completedTurns,
        fallback: candidate.fallback,
        input_content: candidate.content,
      },
      candidate.captureIds,
    );
    windowsCreated++;
  }

  const windows = await capturePromotionWindowRepo.listEligible(
    options.maxWindows,
  );
  let promoted = 0;
  let skipped = 0;
  let deferred = 0;
  let quarantined = 0;
  let failures = 0;
  let stoppedReason: PromoteCapturesStoppedReason = "completed";
  const errors: string[] = [];

  for (const window of windows) {
    if (Date.now() - startedAt >= options.maxRunMs) {
      stoppedReason = "run_budget_exceeded";
      break;
    }
    if (failures >= options.maxFailures) {
      stoppedReason = "failure_budget_exceeded";
      break;
    }
    const claimedWindow = await capturePromotionWindowRepo.claim(window.id);
    if (!claimedWindow) continue;
    const captures = await captureRepo.listForWindow(claimedWindow.id);
    try {
      const summary = await summarizeObservation(
        syntheticObservation(claimedWindow),
      );
      if (summary.skip) {
        await capturePromotionWindowRepo.skip(
          claimedWindow,
          captures.map((capture) => capture.id),
          summary.reasoning,
        );
        skipped++;
        continue;
      }

      const observationId = newId("obs");
      const embedding = await getEmbedder().embed(summary.narrative);
      await capturePromotionWindowRepo.complete({
        window: claimedWindow,
        captureIds: captures.map((capture) => capture.id),
        observation: {
          id: observationId,
          content: summary.narrative,
          type: "other",
          source: claimedWindow.source,
          source_layer: "capture",
          session_id: claimedWindow.session_id,
          project_tag: claimedWindow.project_tag,
          facts: summary.facts,
          metadata: {
            promotion_window_id: claimedWindow.id,
            capture_ids: captures.map((capture) => capture.id),
            completed_turns: claimedWindow.completed_turns,
            fallback: claimedWindow.fallback,
            promoted_reasoning: summary.reasoning,
          },
          embedding: Array.from(embedding),
          promotion_state: summary.facts.length > 0 ? "processing" : "completed",
        },
        facts: factRows(observationId, summary.facts),
      });
      promoted++;
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      const outcome = await capturePromotionWindowRepo.defer(
        claimedWindow,
        message,
      );
      if (outcome.updated) {
        if (outcome.quarantined) quarantined++;
        else deferred++;
      }
      errors.push(`window(${claimedWindow.id}): ${message}`);
    }
  }

  const deletedPromoted = await captureRepo.deletePromoted();
  return {
    capturesSelected: ready.length,
    windowsCreated,
    windowsSelected: windows.length,
    promoted,
    skipped,
    deferred,
    quarantined,
    deletedPromoted,
    runSkipped: false,
    stoppedReason,
    errors,
  };
}
