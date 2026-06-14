/**
 * Time-Aware Memory Update smoke test.
 * Run: pnpm time-update:smoke
 *
 * Prerequisites:
 *   - tsumugi-postgres running (docker compose up -d postgres)
 *   - DATABASE_URL set (e.g. postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi)
 *   - LLM_LOW_API_KEY set (Anthropic key for Haiku 4.5)
 *   - Migrations applied (pnpm db:migrate)
 */

import process from "node:process";
import { sql } from "drizzle-orm";
import { db } from "../../data/client.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { newId } from "../../lib/id.js";
import { timeAwareMemoryUpdate } from "./time-update.js";

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

const dbUrl = process.env["DATABASE_URL"];
if (!dbUrl) {
  console.log("DATABASE_URL is not set — skipping time-update smoke test");
  process.exit(0);
}

const lowApiKey = process.env["LLM_LOW_API_KEY"];
if (!lowApiKey) {
  console.log("LLM_LOW_API_KEY is not set — skipping time-update smoke test");
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

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  id: string;
  narrative: string;
  importance: number;
  kind: string;
  daysOld: number;
}

const FIXTURES: Fixture[] = [
  {
    id: newId("mem"),
    narrative: "TypeScript 4.5 を採用している",
    importance: 6.0,
    kind: "general",
    daysOld: 30, // 14-60 days → factor 0.9
  },
  {
    id: newId("mem"),
    narrative: "DB は MySQL 5.7 を本番で使っている",
    importance: 7.0,
    kind: "decision",
    daysOld: 100, // 60-180 days → factor 0.7
  },
  {
    id: newId("mem"),
    narrative: "デプロイは手動 FTP でやっていた",
    importance: 5.0,
    kind: "general",
    daysOld: 200, // >= 180 days → factor 0.5, kind += ',historical'
  },
];

const createdIds: string[] = FIXTURES.map((f) => f.id);

// ---------------------------------------------------------------------------
// Setup & cleanup
// ---------------------------------------------------------------------------

async function insertFixtures(): Promise<void> {
  const embedder = getEmbedder();
  for (const f of FIXTURES) {
    const embedding = Array.from(await embedder.embed(f.narrative));
    await memoryRepo.insert({
      id: f.id,
      narrative: f.narrative,
      importance: f.importance,
      kind: f.kind,
      embedding,
    });
    // Backdate created_at via raw SQL to simulate aged memories.
    const past = daysAgo(f.daysOld);
    await db.execute(
      sql`UPDATE memories SET created_at = ${past.toISOString()} WHERE id = ${f.id}`,
    );
  }
  console.log(`Inserted ${FIXTURES.length} fixture memories (backdated).`);
}

async function cleanup(): Promise<void> {
  for (const id of createdIds) {
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
  console.log("=== Time-Aware Memory Update Smoke Test ===\n");

  // DB connectivity check.
  try {
    await db.execute(sql`SELECT 1`);
    console.log("DB connection: OK");
  } catch (err) {
    console.error("DB connection failed. Is postgres running?", err);
    process.exit(1);
  }

  await insertFixtures();

  try {
    console.log("\n--- Running timeAwareMemoryUpdate ---");
    const result = await timeAwareMemoryUpdate({ maxUpdates: 10 });

    console.log(`runId:   ${result.runId}`);
    console.log(`scanned: ${result.scanned}`);
    console.log(`updated: ${result.updated}`);
    console.log(`errors:  ${result.errors.length}`);

    assert(result.updated >= 3, `updated >= 3 (got ${result.updated})`);
    assert(result.errors.length === 0, "no errors during update");

    // --- Fixture 0: 30 days old → importance *= 0.9, no 'historical' ---
    const fix0 = await memoryRepo.findById(FIXTURES[0]!.id);
    assert(fix0 !== null, "fixture 0 still exists");
    assert(
      fix0!.narrative !== FIXTURES[0]!.narrative,
      "fixture 0 narrative was rewritten",
    );
    console.log(`  fixture 0 new narrative: ${fix0!.narrative}`);
    const exp0 = Math.max(0.1, FIXTURES[0]!.importance * 0.9);
    assert(
      Math.abs(fix0!.importance - exp0) < 0.01,
      `fixture 0 importance ~= ${exp0.toFixed(2)} (got ${fix0!.importance})`,
    );
    assert(
      !fix0!.kind.includes("historical"),
      "fixture 0 kind does not include 'historical'",
    );

    // --- Fixture 1: 100 days old → importance *= 0.7, no 'historical' ---
    const fix1 = await memoryRepo.findById(FIXTURES[1]!.id);
    assert(fix1 !== null, "fixture 1 still exists");
    assert(
      fix1!.narrative !== FIXTURES[1]!.narrative,
      "fixture 1 narrative was rewritten",
    );
    console.log(`  fixture 1 new narrative: ${fix1!.narrative}`);
    const exp1 = Math.max(0.1, FIXTURES[1]!.importance * 0.7);
    assert(
      Math.abs(fix1!.importance - exp1) < 0.01,
      `fixture 1 importance ~= ${exp1.toFixed(2)} (got ${fix1!.importance})`,
    );
    assert(
      !fix1!.kind.includes("historical"),
      "fixture 1 kind does not include 'historical'",
    );

    // --- Fixture 2: 200 days old → importance *= 0.5, kind += ',historical' ---
    const fix2 = await memoryRepo.findById(FIXTURES[2]!.id);
    assert(fix2 !== null, "fixture 2 still exists");
    assert(
      fix2!.narrative !== FIXTURES[2]!.narrative,
      "fixture 2 narrative was rewritten",
    );
    console.log(`  fixture 2 new narrative: ${fix2!.narrative}`);
    const exp2 = Math.max(0.1, FIXTURES[2]!.importance * 0.5);
    assert(
      Math.abs(fix2!.importance - exp2) < 0.01,
      `fixture 2 importance ~= ${exp2.toFixed(2)} (got ${fix2!.importance})`,
    );
    assert(
      fix2!.kind.includes("historical"),
      `fixture 2 kind includes 'historical' (got '${fix2!.kind}')`,
    );

    console.log("\nAll smoke tests passed.");
  } finally {
    await cleanup();
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test error:", err);
  process.exit(1);
});
