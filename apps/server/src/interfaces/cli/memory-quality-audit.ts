#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadConfig } from "../../lib/config.js";
import { ValidationError } from "../../lib/errors.js";

const AuditCliInput = z
  .object({
    includeCandidates: z.boolean().default(false),
    candidateLimit: z.number().int().positive().max(100).default(20),
    rowLimit: z.number().int().positive().max(100_000).default(20_000),
    thinMaxCharactersExclusive: z.number().int().min(20).max(500).default(100),
    agedDaysInclusive: z.number().int().positive().max(3650).default(365),
    nearDuplicateMinScore: z.number().min(0.5).max(0.99).default(0.88),
  })
  .strict();

export function parseMemoryQualityAuditArgs(argv: string[]) {
  const input: Record<string, unknown> = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--include-candidates") {
      input["includeCandidates"] = true;
      continue;
    }
    if (arg === "--sample-limit") {
      const value = argv[++index];
      if (value === undefined) {
        throw new ValidationError("--sample-limit requires a value");
      }
      input["candidateLimit"] = Number(value);
      continue;
    }
    if (arg === "--row-limit") {
      const value = argv[++index];
      if (value === undefined) {
        throw new ValidationError("--row-limit requires a value");
      }
      input["rowLimit"] = Number(value);
      continue;
    }
    if (arg === "--thin-max-chars") {
      input["thinMaxCharactersExclusive"] = Number(argv[++index]);
      continue;
    }
    if (arg === "--aged-days") {
      input["agedDaysInclusive"] = Number(argv[++index]);
      continue;
    }
    if (arg === "--near-duplicate-score") {
      input["nearDuplicateMinScore"] = Number(argv[++index]);
      continue;
    }
    throw new ValidationError(`unknown audit option: ${arg ?? ""}`);
  }
  return AuditCliInput.parse(input);
}

async function main(): Promise<void> {
  const options = parseMemoryQualityAuditArgs(process.argv.slice(2));
  // Validate the existing runtime configuration before loading the DB-backed
  // audit modules. This command never loads a .env file.
  loadConfig();
  const [{ memoryAuditRepo }, { buildMemoryQualityReport }] = await Promise.all([
    import("../../data/repos/memory-audit.js"),
    import("../../core/memory/quality-audit.js"),
  ]);
  const rows = await memoryAuditRepo.listForQualityAudit(options.rowLimit);
  const report = buildMemoryQualityReport(rows, options);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    // Do not serialize driver errors or records: either can contain sensitive
    // runtime details. The exit code signals failure to automation.
    process.stderr.write("memory quality audit failed\n");
    process.exitCode = 1;
  });
}
