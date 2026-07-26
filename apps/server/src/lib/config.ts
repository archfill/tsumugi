import process from "node:process";

/**
 * Dreaming scheduler の cron 設定。
 * 空文字列で当該 job を無効化。
 */
export interface SchedulerConfig {
  enabled: boolean;
  promoteCaptures: string;
  sweepCaptures: string;
  archiveOutdated: string;
}

export interface Config {
  databaseUrl: string;
  port: number;
  mode: "stdio" | "http";
  hfCache?: string;
  shutdownDrainTimeoutMs: number;
  scheduler: SchedulerConfig;
}

function parseTimeoutMs(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return timeoutMs;
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
    shutdownDrainTimeoutMs:
      parseTimeoutMs(
        "SHUTDOWN_DRAIN_TIMEOUT_MS",
        process.env["SHUTDOWN_DRAIN_TIMEOUT_MS"],
      ) ?? 120_000,
    scheduler: {
      enabled: process.env["DREAMING_SCHEDULER_ENABLED"] !== "false",
      promoteCaptures:
        process.env["DREAMING_SCHEDULE_PROMOTE_CAPTURES"] ?? "*/5 * * * *",
      sweepCaptures:
        process.env["DREAMING_SCHEDULE_SWEEP_CAPTURES"] ?? "30 2 * * *",
      archiveOutdated: process.env["DREAMING_SCHEDULE_ARCHIVE_OUTDATED"] ?? "",
    },
  };
}
