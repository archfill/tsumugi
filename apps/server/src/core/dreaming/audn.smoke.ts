/**
 * AUDN judge smoke test.
 * Run: pnpm audn:smoke
 *
 * Prerequisites:
 *   - tsumugi-postgres running (docker compose up -d postgres)
 *   - DATABASE_URL set (e.g. postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi)
 *   - LLM_MID_API_KEY set (Anthropic key for Sonnet 4.6)
 *   - Migrations applied (pnpm db:migrate)
 */

import process from "node:process";
import { sql } from "drizzle-orm";
import { db } from "../../data/client.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { linkRepo } from "../../data/repos/link.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { newId } from "../../lib/id.js";
import { audnJudge } from "./audn.js";

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

const midApiKey = process.env["LLM_MID_API_KEY"];
if (!midApiKey) {
  console.log("LLM_MID_API_KEY is not set — skipping AUDN smoke test");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  }
  console.log(`[PASS] ${message}`);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface MemoryFixture {
  id: string;
  narrative: string;
  importance: number;
}

const FIXTURES: MemoryFixture[] = [
  {
    id: newId("mem"),
    narrative: "auth は OAuth 2.0 を採用",
    importance: 7.0,
  },
  {
    id: newId("mem"),
    narrative: "DB は Postgres 16 を採用",
    importance: 6.0,
  },
];

const DUMMY_OBS_ID = "obs_dummy_smoke_audn_001";

const createdMemoryIds: string[] = [];
const createdLinkPairs: Array<{ from: string; to: string; relation: string }> =
  [];

async function insertFixtures(fixtures: MemoryFixture[]): Promise<void> {
  const embedder = getEmbedder();
  for (const f of fixtures) {
    const embedding = Array.from(await embedder.embed(f.narrative));
    await memoryRepo.insert({
      id: f.id,
      narrative: f.narrative,
      importance: f.importance,
      kind: "general",
      embedding,
    });
  }
  console.log(`Inserted ${fixtures.length} test memories.`);
}

async function cleanup(): Promise<void> {
  // Remove links first.
  for (const { from, to, relation } of createdLinkPairs) {
    try {
      await linkRepo.remove(from, to, relation);
    } catch {
      // ignore
    }
  }

  // Remove fixture memories.
  for (const id of FIXTURES.map((f) => f.id)) {
    try {
      await db.execute(sql`DELETE FROM memories WHERE id = ${id}`);
    } catch {
      // ignore
    }
  }

  // Remove any memories created by audnJudge (ADD results).
  for (const id of createdMemoryIds) {
    try {
      await db.execute(sql`DELETE FROM memories WHERE id = ${id}`);
    } catch {
      // ignore
    }
  }

  console.log("Cleanup done.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== AUDN Judge Smoke Test ===\n");

  // DB connectivity check.
  try {
    await db.execute(sql`SELECT 1`);
    console.log("DB connection: OK");
  } catch (err) {
    console.error("DB connection failed. Is postgres running?", err);
    process.exit(1);
  }

  // Insert fixture memories.
  await insertFixtures(FIXTURES);

  try {
    // ------------------------------------------------------------------
    // Test 1: UPDATE — "auth は SAML に変更" should update fixture[0]
    // ------------------------------------------------------------------
    console.log('\n--- Test 1: UPDATE ("auth は SAML に変更") ---');

    const result1 = await audnJudge({
      newFact: "auth は SAML に変更",
      sourceObservationId: DUMMY_OBS_ID,
      topK: 5,
    });

    console.log("decision:", result1.decision);
    console.log("targetMemoryId:", result1.targetMemoryId);
    console.log("reasoning:", result1.reasoning);

    assert(result1.decision === "UPDATE", "decision should be UPDATE");
    assert(
      result1.targetMemoryId === FIXTURES[0]!.id,
      `targetMemoryId should be fixture[0].id (${FIXTURES[0]!.id})`,
    );

    // Verify narrative was actually updated in DB.
    const updated = await memoryRepo.findById(FIXTURES[0]!.id);
    assert(
      updated !== null && updated.narrative !== "auth は OAuth 2.0 を採用",
      "narrative should be updated in DB",
    );
    console.log("Updated narrative:", updated?.narrative);

    // Track link for cleanup.
    if (result1.targetMemoryId) {
      createdLinkPairs.push({
        from: DUMMY_OBS_ID,
        to: result1.targetMemoryId,
        relation: "derived_from",
      });
    }

    // ------------------------------------------------------------------
    // Test 2: ADD — "logger は pino を使う" should add a new memory
    // ------------------------------------------------------------------
    console.log('\n--- Test 2: ADD ("logger は pino を使う") ---');

    const beforeCount = await db
      .execute(
        sql`SELECT COUNT(*) AS cnt FROM memories WHERE archived_at IS NULL`,
      )
      .then((r) => Number((r.rows[0] as Record<string, unknown>)["cnt"]));

    const result2 = await audnJudge({
      newFact: "logger は pino を使う",
      sourceObservationId: DUMMY_OBS_ID,
      topK: 5,
    });

    console.log("decision:", result2.decision);
    console.log("resultMemoryId:", result2.resultMemoryId);
    console.log("reasoning:", result2.reasoning);

    assert(result2.decision === "ADD", "decision should be ADD");
    assert(
      typeof result2.resultMemoryId === "string",
      "resultMemoryId should be set",
    );

    const afterCount = await db
      .execute(
        sql`SELECT COUNT(*) AS cnt FROM memories WHERE archived_at IS NULL`,
      )
      .then((r) => Number((r.rows[0] as Record<string, unknown>)["cnt"]));

    assert(
      afterCount === beforeCount + 1,
      `memory count should increase by 1 (was ${beforeCount}, now ${afterCount})`,
    );

    if (result2.resultMemoryId) {
      createdMemoryIds.push(result2.resultMemoryId);
      createdLinkPairs.push({
        from: DUMMY_OBS_ID,
        to: result2.resultMemoryId,
        relation: "derived_from",
      });
    }

    console.log("\nAll smoke tests passed.");
  } finally {
    await cleanup();
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test error:", err);
  process.exit(1);
});
