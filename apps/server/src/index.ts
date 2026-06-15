import process from "node:process";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { startStdio } from "./interfaces/mcp/transport-stdio.js";
import { startHttp } from "./interfaces/mcp/transport-http.js";
import { runMigrations } from "./data/migrate.js";
import { warmupEmbedder } from "./external/embedding/singleton.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations();
  // Fire-and-forget: pre-load BGE-M3 in the background so the first user
  // request doesn't pay the ~600MB download cost. Requests arriving during
  // warm-up simply await the embedder's cached pipeline promise.
  warmupEmbedder();
  if (config.mode === "stdio") {
    await startStdio();
  } else {
    await startHttp(config.port);
  }
}

main().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    "fatal error during startup",
  );
  process.exit(1);
});
