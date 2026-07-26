/**
 * Bench CLI entry.
 *
 * Usage:
 *   tsx eval/cli.ts       # run the search bench
 *   tsx eval/cli.ts search
 *
 * Output:
 *   - human-readable report on stdout
 *   - JSON archive under eval/results/bench-<timestamp>.json
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../src/lib/logger.js";
import {
  buildOverall,
  renderAll,
  renderOverall,
  saveReport,
} from "./report.js";
import { runSearchBench } from "./runners/search.bench.js";
import type { BenchSummary } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");

const REGISTRY: Record<string, () => Promise<BenchSummary>> = {
  search: runSearchBench,
};

const DEFAULT_BENCHES = ["search"];

async function main() {
  const argv = process.argv.slice(2);
  const requested = argv.length === 0 ? DEFAULT_BENCHES : argv;

  const unknown = requested.filter((n) => !(n in REGISTRY));
  if (unknown.length > 0) {
    console.error(`unknown bench(es): ${unknown.join(", ")}`);
    console.error(`available: ${Object.keys(REGISTRY).join(", ")}`);
    process.exit(2);
  }

  logger.info({ benches: requested }, "starting bench run");
  const summaries: BenchSummary[] = [];
  for (const name of requested) {
    const fn = REGISTRY[name]!;
    try {
      const s = await fn();
      summaries.push(s);
    } catch (err) {
      console.error(
        `bench '${name}' crashed:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
  }

  const overall = buildOverall(summaries, new Date().toISOString());
  console.log(renderAll(summaries));
  console.log(renderOverall(overall));

  const path = await saveReport(overall, RESULTS_DIR);
  console.log(`\n→ saved report: ${path}`);

  if (overall.errored > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
