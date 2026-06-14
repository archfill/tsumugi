/**
 * Decision Contradiction Detector — Phase 2 Wave 3C.
 *
 * Loads in_progress decisions and calls a MID-tier LLM to find pairs where
 * a newer decision supersedes an older one on the same topic. Detected pairs
 * are persisted via decisionRepo.supersede(). Run history is recorded in
 * dreaming_runs.
 *
 * Usage:
 *   const result = await detectDecisionContradictions({ maxDecisions: 200 });
 */

import { getLlm } from "../../external/llm/index.js";
import { decisionRepo } from "../../data/repos/decision.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import { newId } from "../../lib/id.js";
import { ExternalError } from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContradictionResult {
  runId: string;
  scanned: number;
  supersededCount: number;
  errors: string[];
}

export interface DetectDecisionContradictionsOptions {
  /** Maximum number of in_progress decisions to scan (default 200). */
  maxDecisions?: number;
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Decision Contradiction Detector.
Compare multiple decisions and detect pairs where the later decision clearly
supersedes an earlier one on the same subject.

## Be conservative
- Different subjects                                → not a supersede
- Supplementary or additive information             → not a supersede (keep both)
- Same subject AND content has clearly changed       → supersede

## Output language
Write reasoning in the same natural language as the inputs. Preserve code
symbols / identifiers / English product names verbatim.

## Output JSON
{
  "pairs": [
    { "superseded_index": number, "new_index": number, "reasoning": string }
  ]
}

An empty pairs array is valid (no supersede relationships).`;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ContradictionPair {
  superseded_index: number;
  new_index: number;
  reasoning: string;
}

interface LlmContradictionResponse {
  pairs: ContradictionPair[];
}

function isContradictionPair(v: unknown): v is ContradictionPair {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["superseded_index"] === "number" &&
    typeof obj["new_index"] === "number" &&
    typeof obj["reasoning"] === "string"
  );
}

function isLlmContradictionResponse(v: unknown): v is LlmContradictionResponse {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    Array.isArray(obj["pairs"]) &&
    (obj["pairs"] as unknown[]).every(isContradictionPair)
  );
}

// ---------------------------------------------------------------------------
// Pure detection (no DB side effects)
// ---------------------------------------------------------------------------

export interface DecisionForDetection {
  /** ISO date string (YYYY-MM-DD) shown to the LLM. */
  isoDate: string;
  content: string;
}

export interface DetectedPair {
  supersededIndex: number;
  newIndex: number;
  reasoning: string;
}

/**
 * Pure LLM-based supersede detection — feeds a list of decisions to the MID
 * tier LLM and returns the detected supersede pairs. No DB writes, no
 * dreaming_run record. Used by `detectDecisionContradictions` (with DB-loaded
 * decisions) and by evaluation benches (with fixture-provided decisions).
 */
export async function detectPairsOnly(
  decisions: DecisionForDetection[],
): Promise<DetectedPair[]> {
  if (decisions.length <= 1) return [];

  const userPrompt =
    `in_progress decisions:\n` +
    decisions.map((d, i) => `[${i}] (${d.isoDate}) ${d.content}`).join("\n") +
    "\n\nDetect supersede pairs.";

  const llm = getLlm("mid");

  const raw = await llm.completeJson<unknown>({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    jsonResponse: true,
    temperature: 0.0,
  });

  if (!isLlmContradictionResponse(raw)) {
    throw new ExternalError(
      `Decision contradiction LLM returned unexpected shape: ${JSON.stringify(raw)}`,
    );
  }

  const pairs: DetectedPair[] = [];
  for (const p of raw.pairs) {
    if (
      p.superseded_index < 0 ||
      p.superseded_index >= decisions.length ||
      p.new_index < 0 ||
      p.new_index >= decisions.length ||
      p.superseded_index === p.new_index
    ) {
      continue;
    }
    pairs.push({
      supersededIndex: p.superseded_index,
      newIndex: p.new_index,
      reasoning: p.reasoning,
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Detect and resolve decision contradictions.
 *
 * 1. Load in_progress decisions (up to maxDecisions).
 * 2. Return early if 0 or 1 decision (no pair possible).
 * 3. Call MID-tier LLM to find superseding pairs.
 * 4. For each pair, call decisionRepo.supersede(oldId, newId).
 * 5. Record dreaming_run history.
 */
export async function detectDecisionContradictions(
  opts: DetectDecisionContradictionsOptions = {},
): Promise<ContradictionResult> {
  const { maxDecisions = 200 } = opts;

  const runId = newId("drun");
  const errors: string[] = [];
  let supersededCount = 0;

  // Record run start.
  await dreamingRunRepo.insert({
    id: runId,
    job_kind: "decision-contradiction",
    status: "pending",
    input_count: 0,
    output_count: 0,
  });

  try {
    await dreamingRunRepo.markRunning(runId);

    // 1. Load in_progress decisions.
    const decisions = await decisionRepo.listByStatus(
      "in_progress",
      maxDecisions,
    );

    // Update input_count.
    await dreamingRunRepo.update(runId, { input_count: decisions.length });

    // 2. Return early if too few decisions to compare.
    if (decisions.length <= 1) {
      await dreamingRunRepo.markCompleted(runId, 0);
      return {
        runId,
        scanned: decisions.length,
        supersededCount: 0,
        errors: [],
      };
    }

    // 3. Build user prompt and call MID-tier LLM.
    const userPrompt =
      `in_progress decisions:\n` +
      decisions
        .map(
          (d, i) =>
            `[${i}] (${d.created_at.toISOString().slice(0, 10)}) ${d.content}`,
        )
        .join("\n") +
      "\n\nDetect supersede pairs.";

    const llm = getLlm("mid");

    const raw = await llm.completeJson<unknown>({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      jsonResponse: true,
      temperature: 0.0,
    });

    if (!isLlmContradictionResponse(raw)) {
      throw new ExternalError(
        `Decision contradiction LLM returned unexpected shape: ${JSON.stringify(raw)}`,
      );
    }

    // 4. Apply supersede for each detected pair.
    for (const pair of raw.pairs) {
      const { superseded_index, new_index } = pair;

      // Guard against out-of-bounds indices.
      if (
        superseded_index < 0 ||
        superseded_index >= decisions.length ||
        new_index < 0 ||
        new_index >= decisions.length ||
        superseded_index === new_index
      ) {
        errors.push(
          `Invalid pair indices: superseded_index=${superseded_index}, new_index=${new_index}`,
        );
        continue;
      }

      const oldDecision = decisions[superseded_index]!;
      const newDecision = decisions[new_index]!;

      try {
        await decisionRepo.supersede(oldDecision.id, newDecision.id);
        supersededCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`supersede(${oldDecision.id} → ${newDecision.id}): ${msg}`);
      }
    }

    // 5. Mark run completed.
    await dreamingRunRepo.markCompleted(runId, supersededCount);

    return {
      runId,
      scanned: decisions.length,
      supersededCount,
      errors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dreamingRunRepo.markFailed(runId, msg);
    throw err;
  }
}
