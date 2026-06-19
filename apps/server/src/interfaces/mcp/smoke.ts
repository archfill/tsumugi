/**
 * Smoke test for MCP tools (save_observation + search_memory).
 *
 * Calls handler functions directly (no transport layer needed).
 *
 * Usage:
 *   DATABASE_URL=postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi \
 *     pnpm exec tsx src/interfaces/mcp/smoke.ts
 *
 * Prerequisites: docker compose up -d tsumugi-postgres && pnpm db:migrate
 */

import process from "node:process";
import { db } from "../../data/client.js";
import { links, memories, observations } from "../../data/schema.js";
import { eq, sql } from "drizzle-orm";
import {
  handleSaveObservation,
  type SaveObservationResult,
} from "./tools/save-observation.js";
import {
  handleSearchMemory,
  type SearchMemoryResult,
} from "./tools/search-memory.js";
import { handleMarkMemoryOutdated } from "./tools/mark-memory-outdated.js";
import { newId } from "../../lib/id.js";
import { timeAwareMemoryUpdate } from "../../core/dreaming/time-update.js";

let savedId: string | null = null;
let otherProjectObservationId: string | null = null;
let memoryId: string | null = null;
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

  try {
    console.log("--- DB preflight ---");
    await db.execute(sql`select 1`);
    assert(true, "database connection is available");

    // 1. save_observation
    console.log("\n--- save_observation ---");
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

    // 3. Seed memory + provenance fixtures for ADR-013 Phase 2/3.
    console.log("\n--- memory/provenance fixtures ---");
    otherProjectObservationId = newId("obs");
    memoryId = newId("mem");
    await db.insert(observations).values({
      id: otherProjectObservationId,
      content: "tsumugi MCP tools smoke other project observation",
      type: "progress",
      source: "other",
      session_id: null,
      project_tag: "other-smoke",
      facts: null,
      metadata: null,
    });
    await db.insert(memories).values({
      id: memoryId,
      narrative: "tsumugi MCP tools smoke provenance memory",
      importance: 5.0,
      kind: "general",
      embedding: null,
    });
    await db.insert(links).values({
      from_id: savedId!,
      to_id: memoryId,
      from_layer: "observation",
      to_layer: "memory",
      relation: "derived_from",
    });
    assert(memoryId.startsWith("mem_"), "memory fixture created");

    // 4. search_memory
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
    assert(
      memoryId !== null && hitIds.includes(memoryId),
      `derived memory appears in project-aware search hits (id: ${memoryId ?? "?"})`,
    );
    assert(
      !hitIds.includes(otherProjectObservationId ?? ""),
      "other project observation is excluded",
    );
    const memoryHit = searchResult.hits.find((h) => h.id === memoryId);
    assert(
      memoryHit?.provenance.some((p) => p.id === savedId) === true,
      "memory hit includes source observation provenance",
    );
    console.log(`  hits: [${hitIds.join(", ")}]`);

    // 5. mark_memory_outdated + time-update archive
    console.log("\n--- mark_memory_outdated ---");
    const outdatedResult = await handleMarkMemoryOutdated({
      memory_id: memoryId,
      reason: "smoke memory is intentionally obsolete",
    });
    assert(outdatedResult.outdated === true, "mark_memory_outdated returns ok");
    const marked = await db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId!));
    assert(marked[0]?.outdated_at instanceof Date, "outdated_at stored");

    const timeUpdateResult = await timeAwareMemoryUpdate({
      maxMemories: 10,
      maxUpdates: 0,
    });
    assert(
      timeUpdateResult.archivedOutdated >= 1,
      "time-update archived outdated memory",
    );
    const archived = await db
      .select()
      .from(memories)
      .where(eq(memories.id, memoryId!));
    assert(archived[0]?.archived_at instanceof Date, "archived_at stored");
  } finally {
    // 6. Cleanup
    console.log("\n--- cleanup ---");
    if (memoryId) {
      await db.delete(links).where(eq(links.to_id, memoryId));
      await db.delete(memories).where(eq(memories.id, memoryId));
      const remaining = await db
        .select()
        .from(memories)
        .where(eq(memories.id, memoryId));
      assert(remaining.length === 0, "smoke memory deleted");
    }
    if (otherProjectObservationId) {
      await db
        .delete(observations)
        .where(eq(observations.id, otherProjectObservationId));
    }
    if (savedId) {
      await db.delete(links).where(eq(links.from_id, savedId));
      await db.delete(observations).where(eq(observations.id, savedId));
      const remaining = await db
        .select()
        .from(observations)
        .where(eq(observations.id, savedId));
      assert(remaining.length === 0, "smoke observation deleted");
    }
  }

  // 7. Summary
  console.log(`\n=== results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("smoke test error:", err);
  process.exit(1);
});
