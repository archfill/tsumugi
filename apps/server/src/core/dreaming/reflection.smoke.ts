/**
 * Reflection use case smoke test — Phase 2 Wave 3D.
 * Run: pnpm reflection:smoke
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
import { observationRepo } from "../../data/repos/observation.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { linkRepo } from "../../data/repos/link.js";
import { newId } from "../../lib/id.js";
import { reflectOnSession } from "./reflection.js";

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.log("DATABASE_URL is not set — skipping reflection smoke test");
  process.exit(0);
}

const lowApiKey = process.env["LLM_LOW_API_KEY"];
if (!lowApiKey) {
  console.log("LLM_LOW_API_KEY is not set — skipping reflection smoke test");
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

const SESSION_ID = "session_smoke_reflection_001";

interface ObsFixture {
  id: string;
  content: string;
  type: string;
}

const FIXTURES: ObsFixture[] = [
  {
    id: newId("obs"),
    content: "compactSession に user_tiers を渡し忘れて bug 7 発生",
    type: "blocker",
  },
  {
    id: newId("obs"),
    content: "fix: user_tiers パラメータを 4 層に伝搬",
    type: "progress",
  },
  {
    id: newId("obs"),
    content: "テスト追加で他層への波及バグも検出",
    type: "progress",
  },
  {
    id: newId("obs"),
    content: "今後の memory 機構は cold path に LLM 集約",
    type: "decision",
  },
];

const createdMemoryIds: string[] = [];

async function insertFixtures(): Promise<void> {
  for (const f of FIXTURES) {
    await observationRepo.insert({
      id: f.id,
      content: f.content,
      type: f.type,
      source: "claude-code",
      session_id: SESSION_ID,
    });
  }
  console.log(`Inserted ${FIXTURES.length} test observations.`);
}

async function cleanup(runId: string): Promise<void> {
  // Remove links involving created memories.
  for (const id of createdMemoryIds) {
    try {
      await db.execute(
        sql`DELETE FROM links WHERE from_id = ${id} OR to_id = ${id}`,
      );
    } catch {
      // ignore
    }
  }

  // Remove links from fixture observations.
  for (const f of FIXTURES) {
    try {
      await db.execute(
        sql`DELETE FROM links WHERE from_id = ${f.id} OR to_id = ${f.id}`,
      );
    } catch {
      // ignore
    }
  }

  // Remove created reflection memories.
  for (const id of createdMemoryIds) {
    try {
      await db.execute(sql`DELETE FROM memories WHERE id = ${id}`);
    } catch {
      // ignore
    }
  }

  // Remove fixture observations.
  for (const f of FIXTURES) {
    try {
      await db.execute(sql`DELETE FROM observations WHERE id = ${f.id}`);
    } catch {
      // ignore
    }
  }

  // Remove dreaming_run record.
  if (runId) {
    try {
      await db.execute(sql`DELETE FROM dreaming_runs WHERE id = ${runId}`);
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
  console.log("=== Reflection Smoke Test ===\n");

  // DB connectivity check.
  try {
    await db.execute(sql`SELECT 1`);
    console.log("DB connection: OK");
  } catch (err) {
    console.error("DB connection failed. Is postgres running?", err);
    process.exit(1);
  }

  // Insert fixture observations.
  await insertFixtures();

  let runId = "";

  try {
    // Run reflection.
    console.log(
      `\nRunning reflectOnSession({ sessionId: '${SESSION_ID}' }) ...`,
    );
    const result = await reflectOnSession({ sessionId: SESSION_ID });

    runId = result.runId;
    console.log("Result:", JSON.stringify(result, null, 2));

    // Assertions.
    assert(
      result.observationsScanned === FIXTURES.length,
      `observationsScanned should be ${FIXTURES.length}`,
    );
    assert(
      result.reflectionsCreated >= 1 && result.reflectionsCreated <= 5,
      `reflectionsCreated should be 1-5, got ${result.reflectionsCreated}`,
    );
    assert(result.errors.length === 0, "no errors");

    // Collect created memory IDs from provenance links.
    for (const f of FIXTURES) {
      const fromLinks = await linkRepo.listFrom(f.id);
      for (const link of fromLinks) {
        if (!createdMemoryIds.includes(link.to_id)) {
          createdMemoryIds.push(link.to_id);
        }
      }
    }

    // Verify each reflection memory has kind='reflection'.
    assert(
      createdMemoryIds.length === result.reflectionsCreated,
      `link count (${createdMemoryIds.length}) should match reflectionsCreated (${result.reflectionsCreated})`,
    );

    for (const memId of createdMemoryIds) {
      const row = await memoryRepo.findById(memId);
      assert(row !== null, `reflection memory ${memId} should exist`);
      assert(
        row?.kind === "reflection",
        `reflection memory ${memId} kind should be 'reflection', got '${row?.kind}'`,
      );
      assert(
        typeof row?.narrative === "string" && row.narrative.startsWith("["),
        `reflection memory ${memId} narrative should start with '[type]'`,
      );
      console.log(`  Reflection: "${row?.narrative}"`);
    }

    // Verify provenance link count = observations × reflections.
    const expectedLinkCount = FIXTURES.length * result.reflectionsCreated;
    let totalLinks = 0;
    for (const f of FIXTURES) {
      const links = await linkRepo.listFrom(f.id);
      totalLinks += links.length;
    }
    assert(
      totalLinks === expectedLinkCount,
      `provenance links should be ${expectedLinkCount} (${FIXTURES.length} obs × ${result.reflectionsCreated} reflections), got ${totalLinks}`,
    );

    console.log("\nAll smoke tests passed.");
  } finally {
    await cleanup(runId);
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test error:", err);
  process.exit(1);
});
