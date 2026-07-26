import { captureRepo, type CaptureRow } from "../../data/repos/capture.js";
import { capturePromotionWindowRepo } from "../../data/repos/capture-promotion-window.js";
import { withPgAdvisoryLock } from "../../data/advisory-lock.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { newId } from "../../lib/id.js";

export type PromoteCapturesStoppedReason =
  | "completed"
  | "active_run_in_progress"
  | "run_budget_exceeded"
  | "failure_budget_exceeded"
  | "shutdown_requested";

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

const STOP_PROMOTION_VERSION = "stop:v1";

function stopPromotionKey(capture: CaptureRow): string {
  const checkpoint = capture.turn_id ?? capture.content_hash;
  return `${STOP_PROMOTION_VERSION}:${capture.source}:${capture.session_id}:${checkpoint}`;
}

function emptyResult(): PromoteCapturesResult {
  return {
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
  };
}

export async function promoteCaptures(
  maxCaptures = 200,
  options?: {
    maxWindows?: number;
    maxRunMs?: number;
    maxFailures?: number;
    signal?: AbortSignal;
  },
): Promise<PromoteCapturesResult> {
  return await withPgAdvisoryLock(
    "tsumugi:promote-captures",
    () =>
      promoteCapturesLocked(maxCaptures, {
        maxWindows: options?.maxWindows ?? 10,
        maxRunMs: options?.maxRunMs ?? 10 * 60 * 1000,
        maxFailures: options?.maxFailures ?? 5,
        signal: options?.signal,
      }),
    async () => emptyResult(),
  );
}

async function promoteCapturesLocked(
  maxCaptures: number,
  options: {
    maxWindows: number;
    maxRunMs: number;
    maxFailures: number;
    signal?: AbortSignal;
  },
): Promise<PromoteCapturesResult> {
  const startedAt = Date.now();
  const readyStops = await captureRepo.listReadyStops(maxCaptures);
  let windowsCreated = 0;
  let windowsSelected = 0;
  let promoted = 0;
  let skipped = 0;
  let deferred = 0;
  let quarantined = 0;
  let failures = 0;
  let stoppedReason: PromoteCapturesStoppedReason = "completed";
  const errors: string[] = [];

  for (const capture of readyStops) {
    if (options.signal?.aborted) {
      stoppedReason = "shutdown_requested";
      break;
    }
    const content = capture.continuity_content?.trim();
    if (!content) {
      if (await captureRepo.skipEmptyStop(capture.id)) skipped++;
      continue;
    }
    const created = await capturePromotionWindowRepo.createDeterministicStop({
      id: newId("win"),
      promotionKey: stopPromotionKey(capture),
      capture: { ...capture, continuity_content: content },
    });
    if (created.created) windowsCreated++;
  }

  while (windowsSelected < options.maxWindows) {
    if (options.signal?.aborted) {
      stoppedReason = "shutdown_requested";
      break;
    }
    if (Date.now() - startedAt >= options.maxRunMs) {
      stoppedReason = "run_budget_exceeded";
      break;
    }
    if (failures >= options.maxFailures) {
      stoppedReason = "failure_budget_exceeded";
      break;
    }

    const [window] =
      await capturePromotionWindowRepo.listEligibleDeterministicStops(1);
    if (!window) break;
    const claimedWindow = await capturePromotionWindowRepo.claim(window.id);
    if (!claimedWindow) continue;
    windowsSelected++;

    const captures = await captureRepo.listActiveForWindow(claimedWindow.id);
    const primary = captures[0];
    const content = primary?.continuity_content?.trim();
    if (!primary) {
      const message = "deterministic Stop window has no captures";
      await capturePromotionWindowRepo.defer(claimedWindow, message);
      deferred++;
      errors.push(`window(${claimedWindow.id}): ${message}`);
      continue;
    }
    if (!content) {
      await capturePromotionWindowRepo.skip(
        claimedWindow,
        captures.map((capture) => capture.id),
        "empty_continuity_content",
      );
      skipped++;
      continue;
    }
    if (
      captures.some(
        (capture) =>
          capture.hook_event !== "Stop" ||
          !capture.continuity_content?.trim() ||
          stopPromotionKey(capture) !== claimedWindow.promotion_key,
      )
    ) {
      const message = "deterministic Stop window provenance mismatch";
      await capturePromotionWindowRepo.defer(claimedWindow, message);
      deferred++;
      errors.push(`window(${claimedWindow.id}): ${message}`);
      continue;
    }

    try {
      const observationId = newId("obs");
      const embedding = await getEmbedder().embed(content);
      await capturePromotionWindowRepo.completeDeterministicStop({
        window: claimedWindow,
        captureIds: captures.map((capture) => capture.id),
        observation: {
          id: observationId,
          content,
          type: "other",
          source: primary.source,
          source_layer: "capture",
          session_id: primary.session_id,
          project_tag: primary.project_tag,
          facts: null,
          metadata: {
            capture_id: primary.id,
            turn_id: primary.turn_id,
            content_hash: primary.content_hash,
            hook_event: primary.hook_event,
            promotion_version: STOP_PROMOTION_VERSION,
          },
          embedding: Array.from(embedding),
          created_at: primary.captured_at,
          promoted_at: new Date(),
          promotion_state: "completed",
        },
      });
      promoted++;
    } catch (err) {
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
      failures++;
    }
  }

  const deletedPromoted = await captureRepo.deletePromoted();
  return {
    capturesSelected: readyStops.length,
    windowsCreated,
    windowsSelected,
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
