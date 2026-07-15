import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, LlmModelConfig } from "../../src/lib/config.js";
import type { LlmClient } from "../../src/external/llm/types.js";
import { ProviderUnavailableError } from "../../src/lib/errors.js";

const singletonState = vi.hoisted(() => ({
  primary: {
    complete: vi.fn(),
    completeJson: vi.fn(),
  },
  fallback: {
    complete: vi.fn(),
    completeJson: vi.fn(),
  },
  config: undefined as Config | undefined,
}));
const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/lib/config.js", () => ({
  loadConfig: () => singletonState.config,
}));

vi.mock("../../src/external/llm/anthropic.js", () => ({
  createAnthropicClient: (opts: LlmModelConfig) =>
    opts.apiKey.includes("fallback") ? singletonState.fallback : singletonState.primary,
}));

vi.mock("../../src/external/llm/openai-compat.js", () => ({
  createOpenAiCompatClient: (opts: LlmModelConfig) =>
    opts.apiKey.includes("fallback") ? singletonState.fallback : singletonState.primary,
}));

vi.mock("../../src/lib/logger.js", () => ({ logger: loggerMock }));

const request = { system: "system", user: "user" };

function configWithFallback(): Config {
  return {
    databaseUrl: "postgresql://example",
    port: 8000,
    mode: "http",
    shutdownDrainTimeoutMs: 120_000,
    llm: {
      low: {
        primary: {
          provider: "anthropic",
          apiKey: "primary-key",
          model: "primary-model",
        },
        fallback: {
          provider: "anthropic",
          apiKey: "fallback-key",
          model: "fallback-model",
        },
      },
      mid: {
        primary: {
          provider: "anthropic",
          apiKey: "primary-key",
          model: "primary-mid-model",
        },
      },
    },
    scheduler: {
      enabled: false,
      promoteCaptures: "",
      promoteObservations: "",
      sweepCaptures: "",
      synthesize: "",
      timeUpdate: "",
      decisionContradiction: "",
    },
  };
}

async function loadSingleton() {
  const mod = await import("../../src/external/llm/singleton.js");
  mod.resetLlmCache();
  return mod;
}

describe("LLM singleton fallback", () => {
  beforeEach(() => {
    singletonState.config = configWithFallback();
    for (const client of [singletonState.primary, singletonState.fallback]) {
      client.complete.mockReset();
      client.completeJson.mockReset();
    }
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses fallback when primary fails", async () => {
    singletonState.primary.complete.mockRejectedValue(new Error("primary down"));
    singletonState.fallback.complete.mockResolvedValue({ text: "fallback ok" });

    const { getLlm } = await loadSingleton();
    const client = getLlm("low");

    await expect(client.complete(request)).resolves.toMatchObject({
      text: "fallback ok",
    });
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(1);
    expect(singletonState.fallback.complete).toHaveBeenCalledTimes(1);
  });

  it("does not call fallback when primary succeeds", async () => {
    singletonState.primary.complete.mockResolvedValue({ text: "primary ok" });
    singletonState.fallback.complete.mockResolvedValue({ text: "fallback ok" });

    const { getLlm } = await loadSingleton();
    const client = getLlm("low");

    await expect(client.complete(request)).resolves.toMatchObject({
      text: "primary ok",
    });
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(1);
    expect(singletonState.fallback.complete).not.toHaveBeenCalled();
  });

  it("serializes concurrent calls for the same provider credential", async () => {
    let releaseFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    singletonState.primary.complete
      .mockImplementationOnce(async () => {
        await firstCall;
        return { text: "first" };
      })
      .mockResolvedValueOnce({ text: "second" });

    const { getLlm } = await loadSingleton();
    const client = getLlm("low");
    const first = client.complete(request);
    const second = client.complete(request);

    await vi.waitFor(() => {
      expect(singletonState.primary.complete).toHaveBeenCalledTimes(1);
    });
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { text: "first" },
      { text: "second" },
    ]);
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(2);
  });

  it("throws a combined error when primary and fallback both fail", async () => {
    singletonState.primary.complete.mockRejectedValue(new Error("primary down"));
    singletonState.fallback.complete.mockRejectedValue(new Error("fallback down"));

    const { getLlm } = await loadSingleton();
    const client: LlmClient = getLlm("low");

    await expect(client.complete(request)).rejects.toThrow(
      /primary and fallback both failed/,
    );
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(1);
    expect(singletonState.fallback.complete).toHaveBeenCalledTimes(1);
  });

  it("shares an open provider circuit across tiers with the same credential", async () => {
    singletonState.config!.llm.low.primary = {
      provider: "openai-compat",
      apiKey: "primary-key",
      model: "primary-model",
      baseUrl: "https://example.test/v1/",
    };
    singletonState.config!.llm.mid.primary = {
      provider: "openai-compat",
      apiKey: "primary-key",
      model: "primary-mid-model",
      baseUrl: "https://example.test/v1",
    };
    singletonState.primary.complete.mockRejectedValueOnce(
      new ProviderUnavailableError("provider timeout", "timeout"),
    );
    singletonState.fallback.complete.mockResolvedValueOnce({
      text: "fallback ok",
    });

    const { assertLlmAvailable, getLlm } = await loadSingleton();
    await expect(getLlm("low").complete(request)).resolves.toMatchObject({
      text: "fallback ok",
    });
    getLlm("mid");

    expect(() => assertLlmAvailable("mid")).toThrow(/outside cooldown/);
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(1);
  });

  it("allows one half-open probe after cooldown and recovers on success", async () => {
    singletonState.config!.llm.low.fallback = undefined;
    const now = new Date("2026-07-13T00:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    singletonState.primary.complete
      .mockRejectedValueOnce(
        new ProviderUnavailableError("provider timeout", "timeout"),
      )
      .mockResolvedValueOnce({ text: "recovered" });

    const { assertLlmAvailable, getLlm } = await loadSingleton();
    const client = getLlm("low");

    await expect(client.complete(request)).rejects.toThrow("provider timeout");
    await expect(client.complete(request)).rejects.toThrow(/circuit is open/);
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(1);

    vi.mocked(Date.now).mockReturnValue(now + 5 * 60 * 1000);
    await expect(client.complete(request)).resolves.toEqual({ text: "recovered" });
    expect(() => assertLlmAvailable("low")).not.toThrow();
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(2);
  });

  it("keeps the circuit open for a provider Retry-After longer than the default cooldown", async () => {
    singletonState.config!.llm.low.fallback = undefined;
    const now = new Date("2026-07-13T00:00:00.000Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);
    singletonState.primary.complete
      .mockRejectedValueOnce(
        new ProviderUnavailableError(
          "provider rate limit",
          "rate_limit",
          undefined,
          10 * 60 * 1000,
        ),
      )
      .mockResolvedValueOnce({ text: "recovered" });

    const { getLlm } = await loadSingleton();
    const client = getLlm("low");

    await expect(client.complete(request)).rejects.toThrow("provider rate limit");
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        reason: "rate_limit",
        retryAfterMs: 10 * 60 * 1000,
        cooldownMs: 10 * 60 * 1000,
        openUntil: new Date(now + 10 * 60 * 1000).toISOString(),
      }),
      "llm provider circuit opened",
    );
    vi.mocked(Date.now).mockReturnValue(now + 5 * 60 * 1000);
    await expect(client.complete(request)).rejects.toThrow(/circuit is open/);
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(1);

    vi.mocked(Date.now).mockReturnValue(now + 10 * 60 * 1000);
    await expect(client.complete(request)).resolves.toEqual({ text: "recovered" });
    expect(singletonState.primary.complete).toHaveBeenCalledTimes(2);
  });
});
