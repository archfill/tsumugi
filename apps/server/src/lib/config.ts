import process from "node:process";

export interface LlmModelConfig {
  apiKey: string;
  model: string;
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
      low: {
        apiKey: process.env["LLM_LOW_API_KEY"] ?? "",
        model: process.env["LLM_LOW_MODEL"] ?? "claude-haiku-4-5",
      },
      mid: {
        apiKey: process.env["LLM_MID_API_KEY"] ?? "",
        model: process.env["LLM_MID_MODEL"] ?? "claude-sonnet-4-6",
      },
    },
  };
}
