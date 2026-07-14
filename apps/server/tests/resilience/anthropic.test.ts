import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalError } from "../../src/lib/errors.js";

const anthropicState = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status?: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }

  class APIConnectionError extends Error {}

  class Anthropic {
    static APIError = APIError;
    static APIConnectionError = APIConnectionError;
    messages = { create: anthropicState.create };
  }

  return { default: Anthropic };
});

const { createAnthropicClient } = await import(
  "../../src/external/llm/anthropic.js"
);
const Anthropic = (await import("@anthropic-ai/sdk")).default;

const baseRequest = {
  system: "system",
  user: "user",
  maxTokens: 32,
};

function okMessage(text: string) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 3, output_tokens: 4 },
  };
}

async function flushRetryTimers<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  const guarded = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.advanceTimersByTimeAsync(ms);
  const result = await guarded;
  if (!result.ok) throw result.error;
  return result.value;
}

describe("Anthropic LLM resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    anthropicState.create.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries APIConnectionError and returns the successful content", async () => {
    anthropicState.create
      .mockRejectedValueOnce(
        new (Anthropic.APIConnectionError as unknown as new (
          message: string,
        ) => Error)("connection lost"),
      )
      .mockResolvedValueOnce(okMessage("ok"));

    const client = createAnthropicClient({
      apiKey: "test",
      model: "claude-test",
      maxAttempts: 2,
    });

    await expect(flushRetryTimers(client.complete(baseRequest))).resolves.toMatchObject({
      text: "ok",
    });
    expect(anthropicState.create).toHaveBeenCalledTimes(2);
  });

  it("passes a request timeout override to the SDK", async () => {
    anthropicState.create.mockResolvedValueOnce(okMessage("ok"));
    const client = createAnthropicClient({
      apiKey: "test",
      model: "claude-test",
      maxAttempts: 1,
    });

    await client.complete({ ...baseRequest, timeoutMs: 60_000 });

    expect(anthropicState.create).toHaveBeenCalledWith(
      expect.any(Object),
      { timeout: 60_000, maxRetries: 0 },
    );
  });

  it("retries 5xx APIError", async () => {
    anthropicState.create
      .mockRejectedValueOnce(
        new (Anthropic.APIError as unknown as new (
          status: number,
          message: string,
        ) => Error)(503, "unavailable"),
      )
      .mockResolvedValueOnce(okMessage("recovered"));

    const client = createAnthropicClient({
      apiKey: "test",
      model: "claude-test",
      maxAttempts: 2,
    });

    await expect(flushRetryTimers(client.complete(baseRequest))).resolves.toMatchObject({
      text: "recovered",
    });
    expect(anthropicState.create).toHaveBeenCalledTimes(2);
  });

  it("treats 4xx APIError as permanent", async () => {
    anthropicState.create.mockRejectedValue(
      new (Anthropic.APIError as unknown as new (
        status: number,
        message: string,
      ) => Error)(400, "bad request"),
    );

    const client = createAnthropicClient({
      apiKey: "test",
      model: "claude-test",
      maxAttempts: 3,
    });

    await expect(client.complete(baseRequest)).rejects.toBeInstanceOf(ExternalError);
    expect(anthropicState.create).toHaveBeenCalledTimes(1);
  });

  it("treats max_tokens stop reason as permanent", async () => {
    anthropicState.create.mockResolvedValue({
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "partial" }],
      usage: { input_tokens: 3, output_tokens: 4 },
    });

    const client = createAnthropicClient({
      apiKey: "test",
      model: "claude-test",
      maxAttempts: 3,
    });

    await expect(client.complete(baseRequest)).rejects.toBeInstanceOf(ExternalError);
    expect(anthropicState.create).toHaveBeenCalledTimes(1);
  });

  it("treats refusal stop reason as permanent", async () => {
    anthropicState.create.mockResolvedValue({
      stop_reason: "refusal",
      content: [{ type: "text", text: "no" }],
      usage: { input_tokens: 3, output_tokens: 4 },
    });

    const client = createAnthropicClient({
      apiKey: "test",
      model: "claude-test",
      maxAttempts: 3,
    });

    await expect(client.complete(baseRequest)).rejects.toBeInstanceOf(ExternalError);
    expect(anthropicState.create).toHaveBeenCalledTimes(1);
  });
});
