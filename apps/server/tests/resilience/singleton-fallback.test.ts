import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, LlmModelConfig } from "../../src/lib/config.js";
import type { LlmClient } from "../../src/external/llm/types.js";

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

const request = { system: "system", user: "user" };

function configWithFallback(): Config {
  return {
    databaseUrl: "postgresql://example",
    port: 8000,
    mode: "http",
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
          apiKey: "primary-mid-key",
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
});
