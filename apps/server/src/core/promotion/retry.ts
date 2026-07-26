import { RetryPromotionIssueInput } from "@tsumugi/shared";
import { captureRepo } from "../../data/repos/capture.js";
import { capturePromotionWindowRepo } from "../../data/repos/capture-promotion-window.js";
import { promotionRecoveryRepo } from "../../data/repos/promotion-recovery.js";
import { ValidationError } from "../../lib/errors.js";

async function retryWindow(id: string): Promise<void> {
  const window = await capturePromotionWindowRepo.findById(id);
  if (
    !window ||
    window.promotion_kind !== "stop_checkpoint" ||
    !["deferred", "quarantined"].includes(window.status)
  ) {
    throw new ValidationError("promotion window is not retryable");
  }

  const captures = await captureRepo.listActiveForWindow(id);
  if (
    captures.length !== window.capture_count ||
    captures.some(
      (capture) =>
        capture.promotion_window_id !== id ||
        capture.hook_event !== "Stop" ||
        !capture.continuity_content?.trim(),
    )
  ) {
    throw new ValidationError(
      "promotion window source captures are no longer available",
    );
  }

  let inputContent = window.input_content;
  if (!inputContent) {
    inputContent = captures[0]!.continuity_content!.trim();
  }

  if (
    !(await promotionRecoveryRepo.retryWindow(
      id,
      inputContent,
      captures.map((capture) => capture.id),
    ))
  ) {
    throw new ValidationError("promotion window retry state changed");
  }
}

export async function retryPromotionIssue(raw: unknown): Promise<{
  ok: true;
  kind: "window" | "fact" | "observation";
  id: string;
  skipped?: true;
  reason?: "removed_server_llm";
}> {
  const input = RetryPromotionIssueInput.parse(raw);
  switch (input.kind) {
    case "window":
      await retryWindow(input.id);
      return { ok: true, kind: input.kind, id: input.id };
    case "fact":
    case "observation":
      return {
        ok: true,
        kind: input.kind,
        id: input.id,
        skipped: true,
        reason: "removed_server_llm",
      };
  }
}
