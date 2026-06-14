#!/usr/bin/env node
/**
 * Dreaming CLI entry point — Phase 2 Wave 4
 *
 * Allows running dreaming jobs from the command line or cron.
 *
 * Usage:
 *   tsx src/core/dreaming/cli.ts [job] [sessionId]
 *
 * Examples:
 *   tsx src/core/dreaming/cli.ts full
 *   tsx src/core/dreaming/cli.ts promote-observations
 *   tsx src/core/dreaming/cli.ts reflection ses_abc123
 */

import process from "node:process";
import { runDreaming, type DreamingJob } from "./runner.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const job = (args[0] ?? "full") as DreamingJob;
  const sessionId = args[1];

  const result = await runDreaming({
    job,
    sessionId,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
