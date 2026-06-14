/**
 * Decision Contradiction Detector smoke test.
 * Run: pnpm decision-contradiction:smoke
 *
 * Prerequisites:
 *   - tsumugi-postgres running (docker compose up -d postgres)
 *   - DATABASE_URL set (e.g. postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi)
 *   - LLM_MID_API_KEY set (Anthropic key for Sonnet)
 *   - Migrations applied (pnpm db:migrate)
 */

import process from "node:process";
import { sql } from "drizzle-orm";
import { db } from "../../data/client.js";
import { decisionRepo } from "../../data/repos/decision.js";
import { newId } from "../../lib/id.js";
import { detectDecisionContradictions } from "./decision-contradiction.js";

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.log(
    "DATABASE_URL is not set — skipping decision-contradiction smoke test",
  );
  process.exit(0);
}

const midApiKey = process.env["LLM_MID_API_KEY"];
if (!midApiKey) {
  console.log(
    "LLM_MID_API_KEY is not set — skipping decision-contradiction smoke test",
  );
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

interface DecisionFixture {
  id: string;
  content: string;
  /** Days ago to backdate created_at (simulates older decisions). */
  daysAgo: number;
}

const fixture1Id = newId("dec");
const fixture2Id = newId("dec");
const fixture3Id = newId("dec");

const FIXTURES: DecisionFixture[] = [
  {
    id: fixture1Id,
    content: "認証は OAuth 2.0 を採用",
    daysAgo: 30,
  },
  {
    id: fixture2Id,
    content: "DB は Postgres を採用",
    daysAgo: 15,
  },
  {
    id: fixture3Id,
    content: "認証は SAML に変更",
    daysAgo: 0,
  },
];

async function insertFixtures(fixtures: DecisionFixture[]): Promise<void> {
  for (const f of fixtures) {
    // Insert with default created_at first.
    await decisionRepo.insert({
      id: f.id,
      content: f.content,
      status: "in_progress",
    });

    // Backdate created_at via raw SQL so the LLM sees temporal ordering.
    if (f.daysAgo > 0) {
      await db.execute(
        sql`UPDATE decisions SET created_at = now() - ${f.daysAgo} * interval '1 day' WHERE id = ${f.id}`,
      );
    }
  }
  console.log(`Inserted ${fixtures.length} test decisions.`);
}

async function cleanup(runId: string): Promise<void> {
  for (const f of FIXTURES) {
    try {
      await db.execute(sql`DELETE FROM decisions WHERE id = ${f.id}`);
    } catch {
      // ignore
    }
  }
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
  console.log("=== Decision Contradiction Detector Smoke Test ===\n");

  // DB connectivity check.
  try {
    await db.execute(sql`SELECT 1`);
    console.log("DB connection: OK");
  } catch (err) {
    console.error("DB connection failed. Is postgres running?", err);
    process.exit(1);
  }

  // Insert fixture decisions.
  await insertFixtures(FIXTURES);

  let runId = "";

  try {
    console.log("\nRunning detectDecisionContradictions({}) ...");
    const result = await detectDecisionContradictions({});

    runId = result.runId;
    console.log("Result:", JSON.stringify(result, null, 2));

    // Assertions.
    assert(result.scanned >= 3, "scanned should be >= 3");
    assert(
      result.supersededCount >= 1,
      "supersededCount should be >= 1 (OAuth superseded by SAML)",
    );
    assert(result.errors.length === 0, "no errors");

    // fixture1 (OAuth) should now be superseded.
    const d1 = await decisionRepo.findById(fixture1Id);
    assert(d1 !== null, "fixture1 should exist");
    assert(
      d1?.status === "superseded",
      `fixture1 status should be 'superseded', got '${d1?.status}'`,
    );

    // fixture3 (SAML) should point to fixture1 as what it supersedes.
    const d3 = await decisionRepo.findById(fixture3Id);
    assert(d3 !== null, "fixture3 should exist");
    assert(
      d3?.supersedes_id === fixture1Id,
      `fixture3.supersedes_id should be fixture1Id (${fixture1Id}), got '${d3?.supersedes_id}'`,
    );

    // fixture2 (Postgres) should remain in_progress — different topic.
    const d2 = await decisionRepo.findById(fixture2Id);
    assert(d2 !== null, "fixture2 should exist");
    assert(
      d2?.status === "in_progress",
      `fixture2 status should still be 'in_progress', got '${d2?.status}'`,
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
