/**
 * Exponential backoff retry helper for external I/O (LLM, embedding, etc).
 *
 * - Backoff doubles each attempt starting at `baseMs`, capped at `maxMs`.
 * - Each sleep is jittered by ±30% to avoid thundering herd.
 * - `shouldRetry(err)` decides whether a thrown error is transient.
 *   Permanent errors (content filter, auth, schema) should return false.
 */

export interface RetryOptions {
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  /** Base backoff in ms before the second attempt (default 500). */
  baseMs?: number;
  /** Cap for backoff (default 8000). */
  maxMs?: number;
  /** Decide whether the error is transient. Default: always retry. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Override the computed delay for a specific error/attempt. */
  getDelayMs?: (
    err: unknown,
    attempt: number,
    defaultDelayMs: number,
  ) => number;
  /** Called when an attempt fails. Useful for logging. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === maxAttempts;
      if (isLastAttempt || !shouldRetry(err, attempt)) {
        throw err;
      }
      const backoff = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
      const jitter = (Math.random() - 0.5) * backoff * 0.6;
      const defaultDelay = Math.max(0, Math.round(backoff + jitter));
      const requestedDelay = opts.getDelayMs?.(err, attempt, defaultDelay);
      const delay =
        requestedDelay !== undefined && Number.isFinite(requestedDelay)
          ? Math.max(0, Math.round(requestedDelay))
          : defaultDelay;
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Race a promise against a timeout. Throws when the timeout fires first.
 * The original promise keeps running; we just stop waiting for it.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  errorMessage = `operation timed out after ${timeoutMs}ms`,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fn(ac.signal);
  } catch (err) {
    if (ac.signal.aborted) {
      throw new Error(errorMessage);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
