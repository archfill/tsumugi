import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import { logger } from "../../lib/logger.js";

const DEFAULT_STALE_RUN_MS = 2 * 60 * 60 * 1000;

export async function recoverStaleDreamingRuns(options?: {
  now?: Date;
  staleRunMs?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const staleRunMs = options?.staleRunMs ?? DEFAULT_STALE_RUN_MS;
  const staleBefore = new Date(now.getTime() - staleRunMs);
  const recovered = await dreamingRunRepo.markStaleNonTerminal(
    staleBefore,
    `dreaming run exceeded stale threshold (${staleRunMs}ms)`,
  );
  if (recovered > 0) {
    logger.warn(
      { recovered, staleBefore: staleBefore.toISOString(), staleRunMs },
      "recovered stale dreaming runs",
    );
  }
  return recovered;
}
