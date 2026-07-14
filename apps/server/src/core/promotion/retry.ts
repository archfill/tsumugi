import { RetryPromotionIssueInput } from "@tsumugi/shared";
import { buildCaptureWindows } from "../capture/window.js";
import { captureRepo } from "../../data/repos/capture.js";
import { capturePromotionWindowRepo } from "../../data/repos/capture-promotion-window.js";
import { promotionRecoveryRepo } from "../../data/repos/promotion-recovery.js";
import { ValidationError } from "../../lib/errors.js";

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

async function retryWindow(id: string): Promise<void> {
  const window = await capturePromotionWindowRepo.findById(id);
  if (!window || !["deferred", "quarantined"].includes(window.status)) {
    throw new ValidationError("promotion window is not retryable");
  }

  const captures = await captureRepo.listForWindow(id);
  if (
    captures.length !== window.capture_count ||
    captures.some((capture) => capture.promotion_window_id !== id)
  ) {
    throw new ValidationError(
      "promotion window source captures are no longer available",
    );
  }

  let inputContent = window.input_content;
  if (!inputContent) {
    const candidate = buildCaptureWindows(captures).find((item) =>
      sameIds(item.captureIds, captures.map((capture) => capture.id)),
    );
    if (!candidate) {
      throw new ValidationError(
        "promotion window source captures are no longer available",
      );
    }
    inputContent = candidate.content;
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
}> {
  const input = RetryPromotionIssueInput.parse(raw);
  let updated = false;
  switch (input.kind) {
    case "window":
      await retryWindow(input.id);
      updated = true;
      break;
    case "fact":
      updated = await promotionRecoveryRepo.retryFact(input.id);
      break;
    case "observation":
      updated = await promotionRecoveryRepo.retryObservation(input.id);
      break;
  }
  if (!updated) {
    throw new ValidationError(`${input.kind} is not retryable`);
  }
  return { ok: true, kind: input.kind, id: input.id };
}
