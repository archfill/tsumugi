import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/lib/config.js";

describe("LLM tier profiles", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost/test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads GLM-5.2 Coding Plan profiles for LOW and MID", () => {
    vi.stubEnv("LLM_LOW_PROVIDER", "openai-compat");
    vi.stubEnv("LLM_LOW_MODEL", "glm-5.2");
    vi.stubEnv("LLM_LOW_OPENAI_DIALECT", "zai");
    vi.stubEnv("LLM_LOW_THINKING", "disabled");
    vi.stubEnv("LLM_LOW_TIMEOUT_MS", "30000");
    vi.stubEnv("LLM_MID_PROVIDER", "openai-compat");
    vi.stubEnv("LLM_MID_MODEL", "glm-5.2");
    vi.stubEnv("LLM_MID_OPENAI_DIALECT", "zai");
    vi.stubEnv("LLM_MID_THINKING", "enabled");
    vi.stubEnv("LLM_MID_REASONING_EFFORT", "high");
    vi.stubEnv("LLM_MID_TIMEOUT_MS", "90000");

    const config = loadConfig(["--http"]);

    expect(config.llm.low.primary).toMatchObject({
      provider: "openai-compat",
      model: "glm-5.2",
      openAiDialect: "zai",
      thinking: "disabled",
      timeoutMs: 30_000,
    });
    expect(config.llm.mid.primary).toMatchObject({
      provider: "openai-compat",
      model: "glm-5.2",
      openAiDialect: "zai",
      thinking: "enabled",
      reasoningEffort: "high",
      timeoutMs: 90_000,
    });
    expect(config.shutdownDrainTimeoutMs).toBe(120_000);
  });

  it("loads a custom graceful shutdown drain timeout", () => {
    vi.stubEnv("SHUTDOWN_DRAIN_TIMEOUT_MS", "45000");

    expect(loadConfig(["--http"]).shutdownDrainTimeoutMs).toBe(45_000);
  });

  it("rejects an invalid graceful shutdown drain timeout", () => {
    vi.stubEnv("SHUTDOWN_DRAIN_TIMEOUT_MS", "0");

    expect(() => loadConfig(["--http"])).toThrow(
      "SHUTDOWN_DRAIN_TIMEOUT_MS must be a positive integer",
    );
  });

  it("rejects reasoning effort unless thinking is enabled", () => {
    vi.stubEnv("LLM_MID_PROVIDER", "openai-compat");
    vi.stubEnv("LLM_MID_OPENAI_DIALECT", "zai");
    vi.stubEnv("LLM_MID_THINKING", "disabled");
    vi.stubEnv("LLM_MID_REASONING_EFFORT", "high");

    expect(() => loadConfig(["--http"])).toThrow(
      "LLM_MID_REASONING_EFFORT requires LLM_MID_THINKING=enabled",
    );
  });

  it("rejects Z.ai reasoning fields for the generic dialect", () => {
    vi.stubEnv("LLM_LOW_PROVIDER", "openai-compat");
    vi.stubEnv("LLM_LOW_THINKING", "disabled");

    expect(() => loadConfig(["--http"])).toThrow(
      "LLM_LOW_THINKING and LLM_LOW_REASONING_EFFORT require " +
        "LLM_LOW_PROVIDER=openai-compat and LLM_LOW_OPENAI_DIALECT=zai",
    );
  });
});
