/**
 * Smoke test for MCP tools (save_observation + search_memory).
 *
 * Calls handler functions directly (no transport layer needed).
 *
 * Usage:
 *   DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi \
 *     pnpm exec tsx src/mcp/smoke.ts
 *
 * Prerequisites: docker compose up -d tsumugi-postgres && pnpm db:migrate
 */

import process from "node:process";
import { db } from "../db/client.js";
import { observations } from "../db/schema.js";
import { eq } from "drizzle-orm";
import {
  handleSaveObservation,
  type SaveObservationResult,
} from "./tools/save-observation.js";
import {
  handleSearchMemory,
  type SearchMemoryResult,
} from "./tools/search-memory.js";

let savedId: string | null = null;
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  OK  ${message}`);
    passed++;
  } else {
    console.error(`  FAIL  ${message}`);
    failed++;
  }
}

async function run(): Promise<void> {
  console.log("=== tsumugi MCP smoke test ===\n");

  // 1. save_observation
  console.log("--- save_observation ---");
  const saveResult = (await handleSaveObservation({
    content: "smoke test observation: tsumugi MCP tools working",
    type: "progress",
    source: "other",
    project_tag: "tsumugi-smoke",
  })) as SaveObservationResult;

  assert(
    typeof saveResult.id === "string" && saveResult.id.startsWith("obs_"),
    "id has obs_ prefix",
  );
  assert(saveResult.layer === "observation", "layer is observation");
  savedId = saveResult.id;
  console.log(`  saved id: ${savedId}`);

  // 2. Verify DB row exists
  console.log("\n--- DB verification ---");
  if (savedId) {
    const rows = await db
      .select()
      .from(observations)
      .where(eq(observations.id, savedId));
    assert(rows.length === 1, "1 row inserted in DB");
    assert(
      rows[0]?.project_tag === "tsumugi-smoke",
      "project_tag stored correctly",
    );
    assert(
      Array.isArray(rows[0]?.embedding) &&
        (rows[0].embedding?.length ?? 0) === 1024,
      "embedding vector has 1024 dims",
    );
  } else {
    assert(false, "skipped DB check (no saved id)");
  }

  // 3. search_memory
  console.log("\n--- search_memory ---");
  const searchResult = (await handleSearchMemory({
    query: "tsumugi MCP tools smoke",
    limit: 5,
    filter: { project_tag: "tsumugi-smoke" },
  })) as SearchMemoryResult;

  assert(Array.isArray(searchResult.hits), "hits is array");
  const hitIds = searchResult.hits.map((h) => h.id);
  assert(
    savedId !== null && hitIds.includes(savedId),
    `saved observation appears in search hits (id: ${savedId ?? "?"})`,
  );
  console.log(`  hits: [${hitIds.join(", ")}]`);

  // 4. Cleanup
  console.log("\n--- cleanup ---");
  if (savedId) {
    await db.delete(observations).where(eq(observations.id, savedId));
    const remaining = await db
      .select()
      .from(observations)
      .where(eq(observations.id, savedId));
    assert(remaining.length === 0, "smoke observation deleted");
  }

  // 5. Summary
  console.log(`\n=== results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("smoke test error:", err);
  process.exit(1);
});
