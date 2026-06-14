/**
 * Hybrid search smoke test.
 * Run: pnpm exec tsx src/search/smoke.ts
 *
 * Prerequisites:
 *   - tsumugi-postgres container running (docker compose up -d postgres)
 *   - DATABASE_URL env var set (e.g. postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi)
 *   - Migrations applied (pnpm db:migrate)
 */

import process from "node:process";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { newId } from "../db/id.js";
import { hybridSearch } from "./index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  id: string;
  content: string;
  type: string;
  source: string;
}

const FIXTURES: Fixture[] = [
  {
    id: newId("obs"),
    content: "compactSession に user_tiers を渡し忘れて bug 7 が発生",
    type: "blocker",
    source: "claude-code",
  },
  {
    id: newId("obs"),
    content: "yui の auth 設計を pgvector ベースに変更",
    type: "decision",
    source: "yui",
  },
  {
    id: newId("obs"),
    content: "tsumugi MCP server で hybrid search 実装",
    type: "progress",
    source: "claude-code",
  },
  {
    id: newId("obs"),
    content: "今日のランチはカレーライスにした",
    type: "other",
    source: "other",
  },
  {
    id: newId("obs"),
    content: "天気予報では明日は雨らしい",
    type: "other",
    source: "other",
  },
];

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

async function insertFixtures(fixtures: Fixture[]): Promise<void> {
  for (const f of fixtures) {
    await db.execute(sql`
      INSERT INTO observations (id, content, type, source, created_at)
      VALUES (${f.id}, ${f.content}, ${f.type}, ${f.source}, NOW())
      ON CONFLICT (id) DO NOTHING
    `);
  }
  console.log(`Inserted ${fixtures.length} test observations.`);
}

async function deleteFixtures(fixtures: Fixture[]): Promise<void> {
  // drizzle sql`` expands JS arrays as tuple ($1,$2,...), but ANY() needs a
  // real PG array.  Use sql.raw for the list and pass each id as a separate
  // parameter via an IN clause built from sql fragments.
  for (const f of fixtures) {
    await db.execute(sql`
      DELETE FROM observations WHERE id = ${f.id}
    `);
  }
  console.log(`Cleaned up ${fixtures.length} test observations.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Hybrid Search Smoke Test ===\n");

  // 1. Verify DB connectivity
  try {
    await db.execute(sql`SELECT 1`);
    console.log("DB connection: OK");
  } catch (err) {
    console.error("DB connection failed. Is postgres running?", err);
    process.exit(1);
  }

  // 2. Verify pg_bigm extension
  try {
    await db.execute(sql`SELECT bigm_similarity('test', 'test')`);
    console.log("pg_bigm extension: OK");
  } catch {
    console.error(
      "pg_bigm is not available. Run: CREATE EXTENSION IF NOT EXISTS pg_bigm;",
    );
    process.exit(1);
  }

  // 3. Insert fixtures
  await insertFixtures(FIXTURES);

  try {
    // 4. Run hybrid search (bigm only, no embeddings in smoke — embedding column is NULL)
    console.log('\nSearching for "compactSession"...');

    // Note: Since smoke fixtures have no embeddings, vector search will return
    // empty results (WHERE embedding IS NOT NULL filters them out).
    // The bigm leg will still rank correctly.
    const hits = await hybridSearch(
      { query: "compactSession", limit: 5 },
      // Skip embedding computation for smoke by using a pre-computed zero vector
      // (embedding is computed inside hybridSearch; this is a real BGE-M3 call)
    );

    console.log(`\nTop hits (${hits.length}):`);
    for (const h of hits) {
      console.log(`  score=${h.score.toFixed(4)} [${h.layer}] ${h.excerpt}`);
    }

    // 5. Assert: the compactSession fixture should appear in results
    const topId = hits[0]?.id;
    const compactSessionFixture = FIXTURES[0]!;

    // bigm_similarity for exact keyword match should score highest
    assert(hits.length > 0, "hybridSearch returned at least 1 result");

    const found = hits.some((h) => h.id === compactSessionFixture.id);
    assert(
      found,
      `compactSession fixture (id=${compactSessionFixture.id}) appears in top results`,
    );

    console.log(`\nTop result id: ${topId}`);
    console.log("\nSmoke test passed.");
  } finally {
    // 6. Cleanup
    await deleteFixtures(FIXTURES);
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test error:", err);
  process.exit(1);
});
