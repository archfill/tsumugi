/**
 * Bench CLI entry.
 *
 * Usage:
 *   tsx eval/cli.ts                       # run all benches
 *   tsx eval/cli.ts audn                  # run a single bench by name
 *   tsx eval/cli.ts audn promote          # run a subset
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
import { runAudnBench } from "./runners/audn.bench.js";
import { runAudnBatchBench } from "./runners/audn-batch.bench.js";
import { runContradictionBench } from "./runners/contradiction.bench.js";
import { runPromoteBench } from "./runners/promote.bench.js";
import { runSearchBench } from "./runners/search.bench.js";
import { runTimeUpdateBench } from "./runners/time-update.bench.js";
import type { BenchSummary } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "results");

const REGISTRY: Record<string, () => Promise<BenchSummary>> = {
  audn: runAudnBench,
  "audn-synthetic": () => runAudnBench({ includePrivate: false }),
  "audn-private-sample": () =>
    runAudnBench({ includeSynthetic: false, privatePerDecision: 5 }),
  "audn-batch": runAudnBatchBench,
  "audn-batch-synthetic": () =>
    runAudnBatchBench({ includePrivate: false }),
  "audn-batch-private-sample": () =>
    runAudnBatchBench({ includeSynthetic: false, privatePerDecision: 5 }),
  "audn-batch2-synthetic": () =>
    runAudnBatchBench({ includePrivate: false, batchSize: 2 }),
  promote: runPromoteBench,
  search: runSearchBench,
  contradiction: runContradictionBench,
  "time-update": runTimeUpdateBench,
};

const DEFAULT_BENCHES = [
  "audn",
  "promote",
  "search",
  "contradiction",
  "time-update",
];

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
