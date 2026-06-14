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
