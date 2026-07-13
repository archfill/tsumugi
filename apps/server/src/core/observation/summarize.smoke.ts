/**
 * Smoke test for the observation summarize use case.
 * Run: pnpm summarize:smoke
 * Requires LLM_LOW_API_KEY (and DATABASE_URL) to be set in env.
 *
 * Tests:
 *   1. Casual greeting observation → skip=true expected
 *   2. "Fixed bug 7" observation   → skip=false, facts mentioning bug 7 expected
 */

import process from "node:process";
import { summarizeObservation } from "./summarize.js";
import type { ObservationRow } from "../../data/repos/observation.js";

const apiKey = process.env["LLM_LOW_API_KEY"];
if (!apiKey) {
  console.log("LLM_LOW_API_KEY is not set — skipping summarize smoke test");
  process.exit(0);
}

// Minimal fake ObservationRow — only fields used by summarize are needed
function fakeObs(overrides: Partial<ObservationRow>): ObservationRow {
  return {
    id: "obs_smoke_" + Math.random().toString(36).slice(2, 8),
    content: "",
    type: "other",
    source: "claude-code",
    source_layer: "agent",
    session_id: null,
    project_tag: null,
    facts: null,
    metadata: null,
    embedding: null,
    created_at: new Date(),
    promoted_at: null,
    promotion_state: "ready",
    // generated column on the DB side; mirror that here for type completeness
    search_text: overrides.content ?? "",
    ...overrides,
  };
}

let failures = 0;

// ---------------------------------------------------------------------------
// Case 1: casual greeting → skip=true
// ---------------------------------------------------------------------------
console.log("\n--- Case 1: casual greeting ---");
const case1 = fakeObs({
  id: "obs_smoke_case1",
  content: "やあ、元気？今日はいい天気だね。",
  type: "other",
  source: "claude-code",
});

const result1 = await summarizeObservation(case1);
console.log(JSON.stringify(result1, null, 2));

if (!result1.skip) {
  console.error("FAIL: expected skip=true for greeting, got skip=false");
  failures++;
} else {
  console.log("PASS: skip=true as expected");
}

// ---------------------------------------------------------------------------
// Case 2: bug fix observation → skip=false, facts reference bug 7
// ---------------------------------------------------------------------------
console.log("\n--- Case 2: bug 7 fix ---");
const case2 = fakeObs({
  id: "obs_smoke_case2",
  content:
    "bug 7 を修正した。routing_decisions.session_id カラムが varchar(64) で " +
    "truncate されていたのが原因で、varchar(128) に拡張することで解消した。" +
    "マイグレーション適用済み、本番でも確認完了。",
  type: "progress",
  source: "claude-code",
});

const result2 = await summarizeObservation(case2);
console.log(JSON.stringify(result2, null, 2));

if (result2.skip) {
  console.error("FAIL: expected skip=false for bug fix, got skip=true");
  failures++;
} else {
  console.log("PASS: skip=false as expected");
}

const hasBug7Fact = result2.facts.some(
  (f) => f.includes("bug 7") || f.includes("bug7") || f.includes("varchar"),
);
if (!hasBug7Fact) {
  console.error(
    "FAIL: expected at least one fact referencing 'bug 7' or 'varchar'",
  );
  failures++;
} else {
  console.log("PASS: facts contain bug 7 / varchar reference");
}

if (result2.narrative.length === 0) {
  console.error("FAIL: narrative should not be empty for non-skip observation");
  failures++;
} else {
  console.log("PASS: narrative is non-empty");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(
  `\n--- summarize smoke: ${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`} ---`,
);
if (failures > 0) {
  process.exit(1);
}
