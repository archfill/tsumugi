import process from "node:process";
import type {
  LlmProvider,
  LlmOpenAiDialect,
  LlmReasoningEffort,
  LlmThinkingMode,
} from "../external/llm/types.js";
import { TsumugiError } from "./errors.js";

export interface LlmModelConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  /** openai-compat 用 base URL。anthropic では使わない。 */
  baseUrl?: string;
  /** openai-compat の request dialect。未指定時は generic。 */
  openAiDialect?: LlmOpenAiDialect;
  /** Z.ai dialect が対応する thinking mode。 */
  thinking?: LlmThinkingMode;
  /** thinking 有効時の reasoning budget。 */
  reasoningEffort?: LlmReasoningEffort;
  /** openai-compat の per-attempt timeout。 */
  timeoutMs?: number;
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
  promoteCaptures: string;
  promoteObservations: string;
  sweepCaptures: string;
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

function parseOpenAiDialect(
  name: string,
  value: string | undefined,
): LlmOpenAiDialect | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "generic" || value === "zai") return value;
  throw new TsumugiError(`${name} must be 'generic' or 'zai'`);
}

function parseThinking(
  name: string,
  value: string | undefined,
): LlmThinkingMode | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "enabled" || value === "disabled") return value;
  throw new TsumugiError(`${name} must be 'enabled' or 'disabled'`);
}

function parseReasoningEffort(
  name: string,
  value: string | undefined,
): LlmReasoningEffort | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "high" || value === "max") return value;
  throw new TsumugiError(`${name} must be 'high' or 'max'`);
}

function parseTimeoutMs(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TsumugiError(`${name} must be a positive integer`);
  }
  return timeoutMs;
}

function validateReasoningProfile(
  prefix: string,
  config: LlmModelConfig,
): LlmModelConfig {
  if (
    (config.thinking || config.reasoningEffort) &&
    (config.provider !== "openai-compat" || config.openAiDialect !== "zai")
  ) {
    throw new TsumugiError(
      `${prefix}_THINKING and ${prefix}_REASONING_EFFORT require ` +
        `${prefix}_PROVIDER=openai-compat and ${prefix}_OPENAI_DIALECT=zai`,
    );
  }
  if (config.reasoningEffort && config.thinking !== "enabled") {
    throw new TsumugiError(
      `${prefix}_REASONING_EFFORT requires ${prefix}_THINKING=enabled`,
    );
  }
  return config;
}

function loadTier(tier: "low" | "mid"): LlmTierConfig {
  const upper = tier.toUpperCase();

  // primary
  const primaryProvider = parseProvider(
    process.env[`LLM_${upper}_PROVIDER`],
    "anthropic",
  );
  const primary = validateReasoningProfile(`LLM_${upper}`, {
    provider: primaryProvider,
    apiKey: process.env[`LLM_${upper}_API_KEY`] ?? "",
    model:
      process.env[`LLM_${upper}_MODEL`] ??
      defaultModelFor(primaryProvider, tier),
    baseUrl: process.env[`LLM_${upper}_BASE_URL`],
    openAiDialect: parseOpenAiDialect(
      `LLM_${upper}_OPENAI_DIALECT`,
      process.env[`LLM_${upper}_OPENAI_DIALECT`],
    ),
    thinking: parseThinking(
      `LLM_${upper}_THINKING`,
      process.env[`LLM_${upper}_THINKING`],
    ),
    reasoningEffort: parseReasoningEffort(
      `LLM_${upper}_REASONING_EFFORT`,
      process.env[`LLM_${upper}_REASONING_EFFORT`],
    ),
    timeoutMs: parseTimeoutMs(
      `LLM_${upper}_TIMEOUT_MS`,
      process.env[`LLM_${upper}_TIMEOUT_MS`] ?? process.env["LLM_TIMEOUT_MS"],
    ),
  });

  // fallback (optional). API key 未設定なら無効。
  const fallbackApiKey = process.env[`LLM_${upper}_FALLBACK_API_KEY`] ?? "";
  if (!fallbackApiKey) {
    return { primary };
  }
  const fallbackProvider = parseProvider(
    process.env[`LLM_${upper}_FALLBACK_PROVIDER`],
    "anthropic",
  );
  const fallback = validateReasoningProfile(`LLM_${upper}_FALLBACK`, {
    provider: fallbackProvider,
    apiKey: fallbackApiKey,
    model:
      process.env[`LLM_${upper}_FALLBACK_MODEL`] ??
      defaultModelFor(fallbackProvider, tier),
    baseUrl: process.env[`LLM_${upper}_FALLBACK_BASE_URL`],
    openAiDialect: parseOpenAiDialect(
      `LLM_${upper}_FALLBACK_OPENAI_DIALECT`,
      process.env[`LLM_${upper}_FALLBACK_OPENAI_DIALECT`],
    ),
    thinking: parseThinking(
      `LLM_${upper}_FALLBACK_THINKING`,
      process.env[`LLM_${upper}_FALLBACK_THINKING`],
    ),
    reasoningEffort: parseReasoningEffort(
      `LLM_${upper}_FALLBACK_REASONING_EFFORT`,
      process.env[`LLM_${upper}_FALLBACK_REASONING_EFFORT`],
    ),
    timeoutMs: parseTimeoutMs(
      `LLM_${upper}_FALLBACK_TIMEOUT_MS`,
      process.env[`LLM_${upper}_FALLBACK_TIMEOUT_MS`] ??
        process.env[`LLM_${upper}_TIMEOUT_MS`] ??
        process.env["LLM_TIMEOUT_MS"],
    ),
  });
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
      promoteCaptures:
        process.env["DREAMING_SCHEDULE_PROMOTE_CAPTURES"] ??
        "0,30 * * * *",
      promoteObservations:
        process.env["DREAMING_SCHEDULE_PROMOTE_OBSERVATIONS"] ??
        process.env["DREAMING_SCHEDULE_PROMOTE"] ??
        "5,35 * * * *",
      sweepCaptures:
        process.env["DREAMING_SCHEDULE_SWEEP_CAPTURES"] ?? "30 2 * * *",
      synthesize: process.env["DREAMING_SCHEDULE_SYNTHESIZE"] ?? "0 */6 * * *",
      timeUpdate: process.env["DREAMING_SCHEDULE_TIME_UPDATE"] ?? "0 3 * * *",
      decisionContradiction:
        process.env["DREAMING_SCHEDULE_DECISION_CONTRADICTION"] ?? "0 4 * * 0",
    },
  };
}
