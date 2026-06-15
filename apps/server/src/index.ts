import process from "node:process";
import { loadConfig } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import { startStdio } from "./interfaces/mcp/transport-stdio.js";
import { startHttp } from "./interfaces/mcp/transport-http.js";
import { runMigrations } from "./data/migrate.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations();
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
