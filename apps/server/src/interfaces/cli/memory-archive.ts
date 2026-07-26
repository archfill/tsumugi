#!/usr/bin/env node
import process from "node:process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../../lib/config.js";
import { ValidationError } from "../../lib/errors.js";

function requireMutationGate(): void {
  if (process.env["TSUMUGI_ALLOW_MEMORY_ARCHIVE_MUTATION"] !== "true") {
    throw new ValidationError("memory archive mutation gate is not enabled");
  }
}

function valueAfter(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new ValidationError(`${flag} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ValidationError(`${label} must be a positive integer`);
  return parsed;
}

async function reviewedIdsFromFile(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8");
  const ids = content.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (ids.some((id) => !/^mem_[A-Za-z0-9_-]+$/u.test(id))) {
    throw new ValidationError("review file must contain one memory id per line");
  }
  return ids;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const command = argv[0];
  loadConfig();
  const actions = await import("../../core/memory/archive.js");

  if (command === "preview-exact-duplicates") {
    const limit = argv.includes("--limit") ? positiveInteger(valueAfter(argv, "--limit"), "--limit") : 10_000;
    process.stdout.write(`${JSON.stringify(await actions.previewExactDuplicateArchive(limit))}\n`);
    return;
  }
  if (command === "plan-exact-duplicates") {
    requireMutationGate();
    const limit = argv.includes("--limit") ? positiveInteger(valueAfter(argv, "--limit"), "--limit") : 10_000;
    process.stdout.write(`${JSON.stringify(await actions.createExactDuplicateArchivePlan(limit))}\n`);
    return;
  }
  if (command === "plan-reviewed-metadata") {
    requireMutationGate();
    const ids = await reviewedIdsFromFile(valueAfter(argv, "--ids-file"));
    process.stdout.write(`${JSON.stringify(await actions.createReviewedMetadataArchivePlan(ids))}\n`);
    return;
  }
  if (command === "apply") {
    requireMutationGate();
    const result = await actions.applyMemoryArchivePlan(
      valueAfter(argv, "--batch-id"),
      positiveInteger(valueAfter(argv, "--confirm-count"), "--confirm-count"),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "restore") {
    requireMutationGate();
    const result = await actions.restoreMemoryArchiveBatch(
      valueAfter(argv, "--batch-id"),
      positiveInteger(valueAfter(argv, "--confirm-count"), "--confirm-count"),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new ValidationError("unknown memory archive command");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("memory archive command failed\n");
    process.exitCode = 1;
  });
}
