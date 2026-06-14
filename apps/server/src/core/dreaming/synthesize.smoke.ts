/**
 * Synthesize use case smoke test.
 * Run: pnpm synthesize:smoke
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
import { linkRepo } from "../../data/repos/link.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { newId } from "../../lib/id.js";
import { synthesizeMemories } from "./synthesize.js";

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.log("DATABASE_URL is not set — skipping synthesize smoke test");
  process.exit(0);
}

const lowApiKey = process.env["LLM_LOW_API_KEY"];
if (!lowApiKey) {
  console.log("LLM_LOW_API_KEY is not set — skipping synthesize smoke test");
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
// Test fixtures — three semantically similar OAuth narratives
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
    narrative: "認証実装に OAuth2 を使う方針",
    importance: 6.0,
  },
  {
    id: newId("mem"),
    narrative: "OAuth2 ベースで auth を実装",
    importance: 6.5,
  },
];

const createdMemoryIds: string[] = [];
const createdRunIds: string[] = [];

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

async function cleanup(runId: string): Promise<void> {
  // Remove links to/from created memories.
  for (const id of createdMemoryIds) {
    try {
      await db.execute(
        sql`DELETE FROM links WHERE from_id = ${id} OR to_id = ${id}`,
      );
    } catch {
      // ignore
    }
  }
  // Remove links to/from fixture memories.
  for (const f of FIXTURES) {
    try {
      await db.execute(
        sql`DELETE FROM links WHERE from_id = ${f.id} OR to_id = ${f.id}`,
      );
    } catch {
      // ignore
    }
  }

  // Remove created memories (synthesised).
  for (const id of createdMemoryIds) {
    try {
      await db.execute(sql`DELETE FROM memories WHERE id = ${id}`);
    } catch {
      // ignore
    }
  }

  // Remove fixture memories (archived by synthesize, so use hard delete).
  for (const f of FIXTURES) {
    try {
      await db.execute(sql`DELETE FROM memories WHERE id = ${f.id}`);
    } catch {
      // ignore
    }
  }

  // Remove dreaming_run records.
  for (const rid of createdRunIds) {
    try {
      await db.execute(sql`DELETE FROM dreaming_runs WHERE id = ${rid}`);
    } catch {
      // ignore
    }
  }
  // Also remove the run created during this smoke test.
  try {
    await db.execute(sql`DELETE FROM dreaming_runs WHERE id = ${runId}`);
  } catch {
    // ignore
  }

  console.log("Cleanup done.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Synthesize Memories Smoke Test ===\n");

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

  let runId = "";

  try {
    // Capture active memory count before.
    const beforeCount = await db
      .execute(
        sql`SELECT COUNT(*) AS cnt FROM memories WHERE archived_at IS NULL`,
      )
      .then((r) => Number((r.rows[0] as Record<string, unknown>)["cnt"]));

    console.log(`\nActive memories before synthesize: ${beforeCount}`);

    // Run synthesize with a small maxMemories to pick up only our fixtures.
    console.log("\nRunning synthesizeMemories({ maxMemories: 10 }) ...");
    const result = await synthesizeMemories({ maxMemories: 10 });

    runId = result.runId;
    console.log("Result:", JSON.stringify(result, null, 2));

    // Assertions.
    assert(result.clustersFound >= 1, "clustersFound should be >= 1");
    assert(result.newMemoriesCreated >= 1, "newMemoriesCreated should be >= 1");
    assert(
      result.memoriesArchived >= 3,
      "memoriesArchived should be >= 3 (all 3 fixtures)",
    );
    assert(result.errors.length === 0, "no errors");

    // Verify fixture memories are now archived.
    for (const f of FIXTURES) {
      const row = await memoryRepo.findById(f.id);
      assert(
        row !== null && row.archived_at !== null,
        `fixture ${f.id} should be archived`,
      );
    }

    // Collect new memory IDs for cleanup by querying links from fixtures.
    for (const f of FIXTURES) {
      const fromLinks = await linkRepo.listFrom(f.id);
      for (const link of fromLinks) {
        if (!createdMemoryIds.includes(link.to_id)) {
          createdMemoryIds.push(link.to_id);
        }
      }
    }

    // Verify synthesised memory exists and is active.
    for (const newId of createdMemoryIds) {
      const row = await memoryRepo.findById(newId);
      assert(
        row !== null && row.archived_at === null,
        `synthesised memory ${newId} should be active`,
      );
      assert(
        typeof row?.narrative === "string" && row.narrative.length > 0,
        `synthesised memory ${newId} should have non-empty narrative`,
      );
      console.log(`Synthesised narrative: "${row?.narrative}"`);
    }

    console.log("\nAll smoke tests passed.");
  } finally {
    await cleanup(runId);
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test error:", err);
  process.exit(1);
});
