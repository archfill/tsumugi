import process from "node:process";
import type { LlmProvider } from "../external/llm/types.js";

export interface LlmModelConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  /** openai-compat 用 base URL。anthropic では使わない。 */
  baseUrl?: string;
}

/** tier ごとの primary + optional fallback (Layer 3)。 */
export interface LlmTierConfig {
  primary: LlmModelConfig;
  fallback?: LlmModelConfig;
}

/**
 * Dreaming scheduler の cron 設定。
 * 空文字列で当該 job を無効化。
 */
export interface SchedulerConfig {
  enabled: boolean;
  promote: string; // promote-observations
  synthesize: string;
  timeUpdate: string;
  decisionContradiction: string;
}

export interface Config {
  databaseUrl: string;
  port: number;
  mode: "stdio" | "http";
  hfCache?: string;
  llm: {
    low: LlmTierConfig;
    mid: LlmTierConfig;
  };
  scheduler: SchedulerConfig;
}

function parseProvider(
  value: string | undefined,
  fallback: LlmProvider,
): LlmProvider {
  if (value === "anthropic" || value === "openai-compat") return value;
  return fallback;
}

function defaultModelFor(provider: LlmProvider, tier: "low" | "mid"): string {
  if (provider !== "anthropic") return "";
  return tier === "low" ? "claude-haiku-4-5" : "claude-sonnet-4-6";
}

function loadTier(tier: "low" | "mid"): LlmTierConfig {
  const upper = tier.toUpperCase();

  // primary
  const primaryProvider = parseProvider(
    process.env[`LLM_${upper}_PROVIDER`],
    "anthropic",
  );
  const primary: LlmModelConfig = {
    provider: primaryProvider,
    apiKey: process.env[`LLM_${upper}_API_KEY`] ?? "",
    model:
      process.env[`LLM_${upper}_MODEL`] ??
      defaultModelFor(primaryProvider, tier),
    baseUrl: process.env[`LLM_${upper}_BASE_URL`],
  };

  // fallback (optional). API key 未設定なら無効。
  const fallbackApiKey = process.env[`LLM_${upper}_FALLBACK_API_KEY`] ?? "";
  if (!fallbackApiKey) {
    return { primary };
  }
  const fallbackProvider = parseProvider(
    process.env[`LLM_${upper}_FALLBACK_PROVIDER`],
    "anthropic",
  );
  const fallback: LlmModelConfig = {
    provider: fallbackProvider,
    apiKey: fallbackApiKey,
    model:
      process.env[`LLM_${upper}_FALLBACK_MODEL`] ??
      defaultModelFor(fallbackProvider, tier),
    baseUrl: process.env[`LLM_${upper}_FALLBACK_BASE_URL`],
  };
  return { primary, fallback };
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  const mode = (
    argv.includes("--stdio")
      ? "stdio"
      : argv.includes("--http")
        ? "http"
        : process.env["TSUMUGI_MODE"] === "stdio"
          ? "stdio"
          : "http"
  ) as "stdio" | "http";

  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  return {
    databaseUrl,
    port: Number(process.env["PORT"] ?? 8000),
    mode,
    hfCache: process.env["HF_CACHE"],
    llm: {
      low: loadTier("low"),
      mid: loadTier("mid"),
    },
    scheduler: {
      enabled: process.env["DREAMING_SCHEDULER_ENABLED"] !== "false",
      promote: process.env["DREAMING_SCHEDULE_PROMOTE"] ?? "*/30 * * * *",
      synthesize: process.env["DREAMING_SCHEDULE_SYNTHESIZE"] ?? "0 */6 * * *",
      timeUpdate: process.env["DREAMING_SCHEDULE_TIME_UPDATE"] ?? "0 3 * * *",
      decisionContradiction:
        process.env["DREAMING_SCHEDULE_DECISION_CONTRADICTION"] ?? "0 4 * * 0",
    },
  };
}
