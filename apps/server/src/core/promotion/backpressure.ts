/** Two scheduled observation-promotion runs at the default 50 facts/run. */
export const DEFAULT_MAX_OUTSTANDING_FACTS = 100;
/** Two scheduled capture-promotion runs at the default 10 windows/run. */
export const DEFAULT_MAX_OUTSTANDING_WINDOWS = 20;

export function isBackpressureActive(
  outstandingItems: number,
  maxOutstandingItems: number,
): boolean {
  return outstandingItems >= maxOutstandingItems;
}
