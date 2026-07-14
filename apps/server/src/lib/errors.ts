export class TsumugiError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends TsumugiError {}
export class NotFoundError extends TsumugiError {}
export class ExternalError extends TsumugiError {} // embedding / LLM / external API

export type ProviderFailureReason =
  | "auth"
  | "circuit_open"
  | "network"
  | "rate_limit"
  | "server_error"
  | "timeout";

/** Provider-wide failure that should not count toward item quarantine. */
export class ProviderUnavailableError extends ExternalError {
  constructor(
    message: string,
    public readonly reason: ProviderFailureReason,
    cause?: unknown,
    /** Provider-specified minimum delay before another request. */
    public readonly retryAfterMs?: number,
  ) {
    super(message, cause);
  }
}

/** Retryable malformed/empty provider output that remains item-scoped. */
export class ExternalResponseError extends ExternalError {}

export function isRetryableExternalError(
  error: unknown,
): error is ProviderUnavailableError | ExternalResponseError {
  if (error instanceof ProviderUnavailableError) {
    return error.reason !== "auth" && error.reason !== "circuit_open";
  }
  return error instanceof ExternalResponseError;
}
