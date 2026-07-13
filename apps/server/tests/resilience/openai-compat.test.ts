import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExternalError,
  ProviderUnavailableError,
} from "../../src/lib/errors.js";
import { createOpenAiCompatClient } from "../../src/external/llm/openai-compat.js";

const baseRequest = {
  system: "system",
  user: "user",
  maxTokens: 32,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 500 ? "Server Error" : status === 429 ? "Too Many Requests" : "OK",
    headers: { "Content-Type": "application/json" },
  });
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

describe("OpenAI-compatible LLM resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries transient 5xx responses and returns the successful content", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 502))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 2,
      timeoutMs: 10_000,
    });

    const result = await flushRetryTimers(client.complete(baseRequest));

    expect(result.text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 429 responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "after retry" }, finish_reason: "stop" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 2,
    });

    await expect(flushRetryTimers(client.complete(baseRequest))).resolves.toMatchObject({
      text: "after retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries empty content and then throws after the retry budget", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
        jsonResponse({
          choices: [{ message: { content: "" }, finish_reason: null }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 2,
    });

    await expect(flushRetryTimers(client.complete(baseRequest))).rejects.toBeInstanceOf(
      ExternalError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats content_filter as permanent", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "" }, finish_reason: "content_filter" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 3,
    });

    await expect(client.complete(baseRequest)).rejects.toBeInstanceOf(ExternalError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats 4xx responses as permanent", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "bad request" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 3,
    });

    await expect(client.complete(baseRequest)).rejects.toBeInstanceOf(ExternalError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies auth errors as provider-wide without retrying", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 3,
    });

    await expect(client.complete(baseRequest)).rejects.toMatchObject({
      reason: "auth",
    } satisfies Partial<ProviderUnavailableError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(
        jsonResponse({
          choices: [{ message: { content: "network recovered" }, finish_reason: "stop" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 2,
      timeoutMs: 10_000,
    });

    await expect(flushRetryTimers(client.complete(baseRequest))).resolves.toMatchObject({
      text: "network recovered",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
