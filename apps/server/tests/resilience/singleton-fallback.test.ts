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
      promote: "",
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
