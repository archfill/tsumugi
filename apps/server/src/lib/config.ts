import process from "node:process";
import type { LlmProvider } from "../external/llm/types.js";

export interface LlmModelConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  /** openai-compat 用 base URL。anthropic では使わない。 */
  baseUrl?: string;
}

export interface Config {
  databaseUrl: string;
  port: number;
  mode: "stdio" | "http";
  hfCache?: string;
  llm: {
    low: LlmModelConfig;
    mid: LlmModelConfig;
  };
}

function parseProvider(
  value: string | undefined,
  fallback: LlmProvider,
): LlmProvider {
  if (value === "anthropic" || value === "openai-compat") return value;
  return fallback;
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

  const lowProvider = parseProvider(
    process.env["LLM_LOW_PROVIDER"],
    "anthropic",
  );
  const midProvider = parseProvider(
    process.env["LLM_MID_PROVIDER"],
    "anthropic",
  );

  return {
    databaseUrl,
    port: Number(process.env["PORT"] ?? 8000),
    mode,
    hfCache: process.env["HF_CACHE"],
    llm: {
      low: {
        provider: lowProvider,
        apiKey: process.env["LLM_LOW_API_KEY"] ?? "",
        model:
          process.env["LLM_LOW_MODEL"] ??
          (lowProvider === "anthropic" ? "claude-haiku-4-5" : ""),
        baseUrl: process.env["LLM_LOW_BASE_URL"],
      },
      mid: {
        provider: midProvider,
        apiKey: process.env["LLM_MID_API_KEY"] ?? "",
        model:
          process.env["LLM_MID_MODEL"] ??
          (midProvider === "anthropic" ? "claude-sonnet-4-6" : ""),
        baseUrl: process.env["LLM_MID_BASE_URL"],
      },
    },
  };
}
