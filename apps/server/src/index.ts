import process from "node:process";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { startStdio } from "./interfaces/mcp/transport-stdio.js";
import { startHttp } from "./interfaces/mcp/transport-http.js";
import { runMigrations } from "./data/migrate.js";
import { pool } from "./data/client.js";
import { warmupEmbedder } from "./external/embedding/singleton.js";
import type { RuntimeShutdownResult } from "./interfaces/mcp/runtime-shutdown.js";

interface AppRuntime {
  shutdown: () => Promise<RuntimeShutdownResult>;
}

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations();
  // Fire-and-forget: pre-load BGE-M3 in the background so the first user
  // request doesn't pay the ~600MB download cost. Requests arriving during
  // warm-up simply await the embedder's cached pipeline promise.
  warmupEmbedder();
  let runtime: AppRuntime;
  if (config.mode === "stdio") {
    runtime = await startStdio(config.shutdownDrainTimeoutMs);
  } else {
    runtime = await startHttp(config.port, {
      scheduler: config.scheduler,
      shutdownDrainTimeoutMs: config.shutdownDrainTimeoutMs,
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown requested");
    try {
      const result = await runtime.shutdown();
      if (result.drained) {
        await pool.end();
        logger.info({ signal }, "graceful shutdown completed");
        process.exit(0);
      }
      logger.warn(
        { signal, runningJobs: result.runningJobs },
        "shutdown deadline exceeded; interrupted runs will recover on startup",
      );
      process.exit(1);
    } catch (err) {
      logger.error(
        {
          signal,
          err: err instanceof Error ? err.message : String(err),
        },
        "graceful shutdown failed",
      );
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    "fatal error during startup",
  );
  process.exit(1);
});
