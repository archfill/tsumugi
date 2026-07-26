import { capturePromotionWindowRepo } from "../../data/repos/capture-promotion-window.js";

/**
 * Explicit compatibility operation. Normal promotion never mutates legacy
 * LLM windows; operators inspect with dryRun first, then invoke apply.
 */
export async function retireLegacyCaptureWindows(options?: {
  apply?: boolean;
  expectedEligible?: number;
}) {
  return await capturePromotionWindowRepo.retireLegacyStopRequeue({
    dryRun: !options?.apply,
    expectedEligible: options?.expectedEligible,
  });
}
