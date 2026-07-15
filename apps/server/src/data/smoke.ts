/**
 * Database integration smoke test.
 *
 * Requires:
 *   - DATABASE_URL
 *   - migrated database schema
 */

import process from "node:process";
import { observationRepo } from "./repos/observation.js";
import { dreamingRunRepo } from "./repos/dreaming-run.js";
import { newId } from "../lib/id.js";

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.log("DATABASE_URL is not set — skipping database smoke test");
  process.exit(0);
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  console.log(`[PASS] ${message}`);
}

const observationId = newId("obs");
const dreamingRunId = newId("drun");

try {
  await observationRepo.insert({
    id: observationId,
    content: "database smoke: promoted_at pending filter",
    type: "progress",
    source: "other",
    session_id: null,
    project_tag: "tsumugi-db-smoke",
    facts: null,
    metadata: null,
  });

  const inserted = await observationRepo.findById(observationId);
  assert(inserted !== null, "observation inserted");
  assert(inserted?.promoted_at === null, "new observation is not promoted");

  const pendingBefore = await observationRepo.listPending(100);
  assert(
    pendingBefore.some((row) => row.id === observationId),
    "new observation appears in pending list",
  );

  await observationRepo.markPromoted(observationId);

  const promoted = await observationRepo.findById(observationId);
  assert(promoted?.promoted_at instanceof Date, "promoted_at is recorded");

  const pendingAfter = await observationRepo.listPending(100);
  assert(
    !pendingAfter.some((row) => row.id === observationId),
    "promoted observation is excluded from pending list",
  );

  await dreamingRunRepo.insert({
    id: dreamingRunId,
    job_kind: "database-smoke",
    status: "pending",
    input_count: 1,
    output_count: 0,
  });
  await dreamingRunRepo.markRunning(dreamingRunId);

  const runningRun = await dreamingRunRepo.findById(dreamingRunId);
  assert(runningRun?.status === "running", "dreaming run is marked running");
  assert(
    typeof runningRun?.metadata?.["ownerId"] === "string",
    "dreaming run ownership is retained",
  );
  assert(
    typeof runningRun?.metadata?.["heartbeatAt"] === "string",
    "dreaming run heartbeat is recorded",
  );

  await dreamingRunRepo.markCompleted(dreamingRunId, 1);
  const completedRun = await dreamingRunRepo.findById(dreamingRunId);
  assert(
    completedRun?.status === "completed",
    "owned dreaming run reaches a terminal state",
  );
} finally {
  await Promise.all([
    dreamingRunRepo.deleteById(dreamingRunId),
    observationRepo.deleteById(observationId),
  ]);
}
