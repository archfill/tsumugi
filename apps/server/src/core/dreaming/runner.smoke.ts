/**
 * Dreaming Runner smoke test — Phase 2 Wave 4
 * Run: pnpm dreaming:smoke
 *
 * Prerequisites:
 *   - tsumugi-postgres running (docker compose up -d postgres)
 *   - DATABASE_URL set (e.g. postgresql://tsumugi:tsumugi_dev@localhost:5433/tsumugi)
 *   - LLM_LOW_API_KEY set (Anthropic key for Haiku 4.5)
 *   - LLM_MID_API_KEY set (Anthropic key for Sonnet)
 *   - Migrations applied (pnpm db:migrate)
 */

import process from "node:process";
import { sql } from "drizzle-orm";
import { db } from "../../data/client.js";
import { observationRepo } from "../../data/repos/observation.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { decisionRepo } from "../../data/repos/decision.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { newId } from "../../lib/id.js";
import { runDreaming } from "./runner.js";

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  console.log("DATABASE_URL is not set — skipping dreaming runner smoke test");
  process.exit(0);
}

const lowApiKey = process.env["LLM_LOW_API_KEY"];
if (!lowApiKey) {
  console.log(
    "LLM_LOW_API_KEY is not set — skipping dreaming runner smoke test",
  );
  process.exit(0);
}

const midApiKey = process.env["LLM_MID_API_KEY"];
if (!midApiKey) {
  console.log(
    "LLM_MID_API_KEY is not set — skipping dreaming runner smoke test",
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
// Fixtures
// ---------------------------------------------------------------------------

// 2 observations: one that should be skipped (greeting), one with content
const obsSkipId = newId("obs");
const obsContentId = newId("obs");

// 2 memories: semantically similar pair (for synthesize to cluster)
const mem1Id = newId("mem");
const mem2Id = newId("mem");

// 2 decisions: one overrides the other on same topic
const dec1Id = newId("dec");
const dec2Id = newId("dec");

async function insertFixtures(): Promise<void> {
  const embedder = getEmbedder();

  // Observations
  await observationRepo.insert({
    id: obsSkipId,
    content: "こんにちは",
    type: "other",
    source: "other",
    session_id: null,
    project_tag: null,
    facts: null,
    metadata: null,
  });

  await observationRepo.insert({
    id: obsContentId,
    content: "TypeScript を full-stack で採用することに決定した",
    type: "decision",
    source: "claude-code",
    session_id: null,
    project_tag: null,
    facts: null,
    metadata: null,
  });

  // Memories (similar pair)
  const emb1 = Array.from(await embedder.embed("auth は OAuth 2.0 を採用"));
  const emb2 = Array.from(
    await embedder.embed("OAuth2 ベースで認証を実装する"),
  );
  await memoryRepo.insert({
    id: mem1Id,
    narrative: "auth は OAuth 2.0 を採用",
    importance: 7.0,
    kind: "general",
    embedding: emb1,
  });
  await memoryRepo.insert({
    id: mem2Id,
    narrative: "OAuth2 ベースで認証を実装する",
    importance: 6.5,
    kind: "general",
    embedding: emb2,
  });

  // Decisions (same topic, one overrides the other)
  await decisionRepo.insert({
    id: dec1Id,
    content: "認証は OAuth 2.0 を採用",
    status: "in_progress",
  });
  await db.execute(
    sql`UPDATE decisions SET created_at = now() - interval '30 days' WHERE id = ${dec1Id}`,
  );
  await decisionRepo.insert({
    id: dec2Id,
    content: "認証は SAML に変更（セキュリティ要件のため）",
    status: "in_progress",
  });

  console.log("Fixtures inserted.");
}

async function cleanup(runIds: string[]): Promise<void> {
  // Remove observations
  for (const id of [obsSkipId, obsContentId]) {
    try {
      await db.execute(sql`DELETE FROM observations WHERE id = ${id}`);
    } catch {
      // ignore
    }
  }

  // Remove links from memories
  for (const id of [mem1Id, mem2Id]) {
    try {
      await db.execute(
        sql`DELETE FROM links WHERE from_id = ${id} OR to_id = ${id}`,
      );
    } catch {
      // ignore
    }
  }

  // Remove memories
  for (const id of [mem1Id, mem2Id]) {
    try {
      await db.execute(sql`DELETE FROM memories WHERE id = ${id}`);
    } catch {
      // ignore
    }
  }

  // Remove decisions
  for (const id of [dec1Id, dec2Id]) {
    try {
      await db.execute(sql`DELETE FROM decisions WHERE id = ${id}`);
    } catch {
      // ignore
    }
  }

  // Remove dreaming_runs created by the runner and its sub-jobs
  for (const id of runIds) {
    try {
      await db.execute(sql`DELETE FROM dreaming_runs WHERE id = ${id}`);
    } catch {
      // ignore
    }
  }

  // Clean up any memories created by promote-observations / synthesize
  // (those can only be identified by their provenance links from obs/mem fixtures)
  for (const obsId of [obsSkipId, obsContentId]) {
    try {
      const rows = await db.execute(
        sql`SELECT to_id FROM links WHERE from_id = ${obsId}`,
      );
      for (const row of rows.rows) {
        const toId = (row as Record<string, unknown>)["to_id"] as string;
        await db.execute(
          sql`DELETE FROM links WHERE from_id = ${toId} OR to_id = ${toId}`,
        );
        await db.execute(sql`DELETE FROM memories WHERE id = ${toId}`);
        await db.execute(sql`DELETE FROM dreaming_runs WHERE id = ${toId}`);
      }
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
  console.log("=== Dreaming Runner Smoke Test ===\n");

  // DB connectivity check
  try {
    await db.execute(sql`SELECT 1`);
    console.log("DB connection: OK");
  } catch (err) {
    console.error("DB connection failed. Is postgres running?", err);
    process.exit(1);
  }

  await insertFixtures();

  const collectedRunIds: string[] = [];

  try {
    console.log("\nRunning runDreaming({ job: 'full' }) ...");
    const result = await runDreaming({ job: "full" });

    console.log("Result:", JSON.stringify(result, null, 2));

    // Collect sub-run IDs from step details for cleanup
    for (const step of result.steps) {
      const detail = step.detail as Record<string, unknown> | undefined;
      if (detail && typeof detail["runId"] === "string") {
        collectedRunIds.push(detail["runId"]);
      }
    }

    // Top-level assertions
    assert(typeof result.job === "string", "result.job is a string");
    assert(result.job === "full", "result.job === 'full'");
    assert(typeof result.startedAt === "string", "result.startedAt is set");
    assert(typeof result.finishedAt === "string", "result.finishedAt is set");
    assert(
      typeof result.durationMs === "number",
      "result.durationMs is a number",
    );
    assert(result.durationMs >= 0, "result.durationMs >= 0");

    // Steps assertions: full = 4 steps
    assert(
      result.steps.length === 4,
      `steps.length === 4, got ${result.steps.length}`,
    );

    const stepNames = result.steps.map((s) => s.name);
    assert(
      stepNames.includes("promote-observations"),
      "steps includes promote-observations",
    );
    assert(stepNames.includes("synthesize"), "steps includes synthesize");
    assert(stepNames.includes("time-update"), "steps includes time-update");
    assert(
      stepNames.includes("decision-contradiction"),
      "steps includes decision-contradiction",
    );

    // Each step should have ok and name fields
    for (const step of result.steps) {
      assert(
        typeof step.name === "string",
        `step.name is string: ${step.name}`,
      );
      assert(typeof step.ok === "boolean", `step ${step.name} has ok field`);
    }

    console.log("\nAll smoke tests passed.");
  } finally {
    await cleanup(collectedRunIds);
  }
}

main().catch((err: unknown) => {
  console.error("Smoke test error:", err);
  process.exit(1);
});
