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

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText:
      status >= 500
        ? "Server Error"
        : status === 429
          ? "Too Many Requests"
          : "OK",
    headers: { "Content-Type": "application/json", ...headers },
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

function requestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
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

  it("sends an enabled GLM reasoning profile when configured", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "glm-5.2",
      baseUrl: "https://example.test/v1",
      dialect: "zai",
      thinking: "enabled",
      reasoningEffort: "high",
    });

    await client.complete(baseRequest);

    expect(requestBody(fetchMock)).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    });
  });

  it("disables thinking without sending reasoning_effort", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "glm-5.2",
      baseUrl: "https://example.test/v1",
      dialect: "zai",
      thinking: "disabled",
    });

    await client.complete(baseRequest);

    const body = requestBody(fetchMock);
    expect(body).toMatchObject({ thinking: { type: "disabled" } });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("omits Z.ai-specific fields for the generic dialect", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      dialect: "generic",
      thinking: "enabled",
      reasoningEffort: "high",
    });

    await client.complete(baseRequest);

    const body = requestBody(fetchMock);
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("uses a slower backoff for 429 responses without Retry-After", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: "rate limited" }, 429))
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
      maxAttempts: 4,
    });

    const pending = client.complete(baseRequest);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({
      text: "after retry",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("honors a longer Retry-After delay in seconds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "rate limited" },
          429,
          { "Retry-After": "10" },
        ),
      )
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

    const pending = client.complete(baseRequest);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ text: "after retry" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After in HTTP-date format", async () => {
    const now = new Date("2026-07-14T00:00:00.000Z");
    vi.setSystemTime(now);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "unavailable" },
          503,
          { "Retry-After": new Date(now.getTime() + 7_000).toUTCString() },
        ),
      )
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

    const pending = client.complete(baseRequest);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ text: "after retry" });
  });

  it("defers a long Retry-After to the provider circuit", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: "rate limited" },
        429,
        { "Retry-After": "60" },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 3,
    });

    await expect(client.complete(baseRequest)).rejects.toMatchObject({
      reason: "rate_limit",
      retryAfterMs: 60_000,
    } satisfies Partial<ProviderUnavailableError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps an overflowing Retry-After delay at 24 hours", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        { error: "rate limited" },
        429,
        { "Retry-After": "9".repeat(400) },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createOpenAiCompatClient({
      apiKey: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      maxAttempts: 3,
    });

    await expect(client.complete(baseRequest)).rejects.toMatchObject({
      reason: "rate_limit",
      retryAfterMs: 24 * 60 * 60 * 1000,
    } satisfies Partial<ProviderUnavailableError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores an invalid Retry-After value and uses rate-limit backoff", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "rate limited" },
          429,
          { "Retry-After": "not-a-date" },
        ),
      )
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

    const pending = client.complete(baseRequest);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ text: "after retry" });
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
