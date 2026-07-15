import type { AdminDreamingRunMetadata } from "@tsumugi/shared";

export interface DreamingRunMetrics {
  factsSelected: number | null;
  factBatchesSelected: number | null;
  factBatchFallbacks: number | null;
  factsCompleted: number | null;
  factsDeferred: number | null;
  stoppedReason: string | null;
  fallbackRate: number | null;
}

function nonnegativeNumber(
  metadata: AdminDreamingRunMetadata | null,
  key: keyof AdminDreamingRunMetadata,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function readDreamingRunMetrics(
  metadata: AdminDreamingRunMetadata | null,
): DreamingRunMetrics | null {
  const factsSelected = nonnegativeNumber(metadata, "factsSelected");
  const factBatchesSelected = nonnegativeNumber(
    metadata,
    "factBatchesSelected",
  );
  const factBatchFallbacks = nonnegativeNumber(metadata, "factBatchFallbacks");
  const factsCompleted = nonnegativeNumber(metadata, "factsCompleted");
  const factsDeferred = nonnegativeNumber(metadata, "factsDeferred");
  const stoppedReason =
    typeof metadata?.stoppedReason === "string" ? metadata.stoppedReason : null;

  if (
    factsSelected === null &&
    factBatchesSelected === null &&
    factBatchFallbacks === null &&
    factsCompleted === null &&
    factsDeferred === null &&
    stoppedReason === null
  ) {
    return null;
  }

  return {
    factsSelected,
    factBatchesSelected,
    factBatchFallbacks,
    factsCompleted,
    factsDeferred,
    stoppedReason,
    fallbackRate:
      factBatchesSelected !== null &&
      factBatchesSelected > 0 &&
      factBatchFallbacks !== null
        ? factBatchFallbacks / factBatchesSelected
        : null,
  };
}

export function formatRunCount(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

export function formatFallbackRate(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}
