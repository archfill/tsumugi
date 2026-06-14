import { loadConfig } from "./lib/config.js";
import { startStdio } from "./interfaces/mcp/transport-stdio.js";
import { startHttp } from "./interfaces/mcp/transport-http.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.mode === "stdio") {
    await startStdio();
  } else {
    await startHttp(config.port);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
