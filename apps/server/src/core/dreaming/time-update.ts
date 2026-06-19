/**
 * Time-Aware Memory Update — Phase 2 Wave 3B.
 *
 * Rewrites aged memory narratives from a "current perspective" using a
 * LOW-tier LLM (Haiku 4.5), and applies importance decay based on elapsed time.
 *
 * Usage:
 *   const result = await timeAwareMemoryUpdate({ maxUpdates: 50 });
 */

import { getLlm } from "../../external/llm/index.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import { newId } from "../../lib/id.js";
import { ExternalError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TimeUpdateResult {
  runId: string;
  scanned: number;
  updated: number;
  archivedOutdated: number;
  errors: string[];
}

export interface TimeUpdateInput {
  narrative: string;
  createdAtIso: string;
  nowIso?: string;
}

export interface TimeUpdateOnlyResult {
  narrative: string;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Internal LLM response shape
// ---------------------------------------------------------------------------

interface LlmRewriteResponse {
  narrative: string;
  reasoning: string;
}

function isLlmRewriteResponse(v: unknown): v is LlmRewriteResponse {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["narrative"] === "string" && typeof obj["reasoning"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the Time-Aware Memory Updater.
The memory has aged. Rewrite the narrative from the present-day perspective so
a future reader knows it describes the past. The rewrite MUST be stable across
re-runs (no relative drift): every time expression must be anchored to an
absolute date, never to "now".

## Hard rules
- Convert every relative time expression in the original — "yesterday",
  "3 days ago", "現在", "今", "recently", "ongoing", etc. — into an ABSOLUTE
  date computed from Created at + Current date.
- NEVER emit drifting relative phrases: "X months ago", "X days ago",
  "recently", "約 N 週間前", "数ヶ月前", "lately". These will be re-rewritten
  on the next scheduler tick and oscillate forever.
- Allowed absolute formats (pick the one most natural for the language):
    "2026-03-29 頃", "2026 年 3 月", "Around 2026-03", "in March 2026",
    "as of 2026-01-15".
- Insert past-tense framing anchored to those absolute dates
  ("was tuning X in 2026-03", "adopted X around 2026-01-15").
- Do not invent facts that are not in the original.
- Information likely stale → past tense.
- Keep it short (1–2 sentences).

## Exception: stable facts
If the original narrative describes a stable, time-independent fact —
architectural invariants, configuration constants, always-true statements
(e.g. "Hybrid search combines pg_bigm and pgvector via RRF", "Embedding
dimension is 1024", "The MCP transport is WebStandardStreamableHTTPServerTransport")
— return it essentially UNCHANGED. Do not prepend a date anchor. Such facts
do not age; they describe how the system IS, not what happened.
A useful heuristic: if the original has no verb of action ("adopted",
"switched", "tuned", "fixed", "investigated", "completed", "started"), it
is probably a stable fact.

## Output language
Rewrite in the same natural language as the original narrative. Preserve code
symbols / identifiers / English product names verbatim.

## Output JSON
{
  "narrative": "time-aware rewritten narrative with absolute dates only",
  "reasoning": "short rationale"
}`;

function buildUserPrompt(
  narrative: string,
  elapsedD: number,
  createdAt: Date,
  now: Date,
): string {
  return `Original narrative: ${narrative}
Elapsed days: ${Math.floor(elapsedD)}
Created at: ${createdAt.toISOString().slice(0, 10)}
Current date: ${now.toISOString().slice(0, 10)}

Compute absolute dates from "Created at" plus any relative expressions in the
original. Rewrite using ONLY absolute dates — no relative phrases.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsedDays(createdAt: Date, now = new Date()): number {
  const ms = now.getTime() - createdAt.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

interface AgingResult {
  importance: number;
  kind: string;
  needsRewrite: boolean;
}

function applyAging(
  elapsedD: number,
  oldImportance: number,
  oldKind: string,
): AgingResult {
  if (elapsedD < 14) {
    return { importance: oldImportance, kind: oldKind, needsRewrite: false };
  }
  let factor = 0.9;
  let kind = oldKind;
  if (elapsedD >= 180) {
    factor = 0.5;
    kind = oldKind.includes("historical") ? oldKind : `${oldKind},historical`;
  } else if (elapsedD >= 60) {
    factor = 0.7;
  }
  return {
    importance: Math.max(0.1, oldImportance * factor),
    kind,
    needsRewrite: true,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Pure LLM rewrite step for time-aware memory updates. This does not read or
 * write DB state; callers provide the narrative and timestamps explicitly.
 */
export async function timeUpdateOnly(
  input: TimeUpdateInput,
): Promise<TimeUpdateOnlyResult> {
  const createdAt = new Date(input.createdAtIso);
  const now = input.nowIso ? new Date(input.nowIso) : new Date();
  const elapsed = elapsedDays(createdAt, now);
  const llm = getLlm("low");

  const raw = await llm.completeJson<unknown>({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input.narrative, elapsed, createdAt, now),
    jsonResponse: true,
    temperature: 0.3,
    maxTokens: 512,
  });

  if (!isLlmRewriteResponse(raw)) {
    throw new ExternalError(
      `time-update LLM returned unexpected shape: ${JSON.stringify(raw)}`,
    );
  }

  return {
    narrative: raw.narrative.trim(),
    reasoning: raw.reasoning.trim(),
  };
}

/**
 * Scan active memories, rewrite aged narratives with a LOW-tier LLM,
 * and decay importance scores based on elapsed time.
 *
 * @param opts.maxMemories  Max memories to scan per run (default 500).
 * @param opts.maxUpdates   Max memories to actually rewrite per run (default 50).
 */
export async function timeAwareMemoryUpdate(opts?: {
  maxMemories?: number;
  maxUpdates?: number;
}): Promise<TimeUpdateResult> {
  const maxMemories = opts?.maxMemories ?? 500;
  const maxUpdates = opts?.maxUpdates ?? 50;

  const runId = newId("drun");
  const errors: string[] = [];
  let updated = 0;
  let archivedOutdated = 0;

  // 1. Record run start.
  await dreamingRunRepo.insert({
    id: runId,
    job_kind: "time-update",
    status: "pending",
    input_count: 0,
    output_count: 0,
  });
  await dreamingRunRepo.markRunning(runId);

  try {
    // 2. Archive memories explicitly marked outdated by an agent. This keeps
    // direct tool calls reversible until the next dreaming maintenance pass.
    archivedOutdated = await memoryRepo.archiveOutdated(maxMemories);

    // 3. Load LLM-eligible memories (skip archived / quarantined / cooldown).
    const memories = await memoryRepo.listLlmEligible(maxMemories);
    const scanned = memories.length;

    // Update input_count now that we know it.
    await dreamingRunRepo.update(runId, { input_count: scanned });

    const embedder = getEmbedder();

    for (const memory of memories) {
      if (updated >= maxUpdates) break;

      const createdAt = memory.created_at;
      const elapsed = elapsedDays(createdAt);
      const { importance, kind, needsRewrite } = applyAging(
        elapsed,
        memory.importance,
        memory.kind,
      );

      if (!needsRewrite) continue;

      try {
        // 4. Rewrite narrative via LLM.
        const { narrative: newNarrative } = await timeUpdateOnly({
          narrative: memory.narrative,
          createdAtIso: createdAt.toISOString(),
        });

        // 5. Re-embed with updated narrative.
        const embedding = Array.from(await embedder.embed(newNarrative));

        // 6. Persist + reset LLM failure counter.
        await memoryRepo.update(memory.id, {
          narrative: newNarrative,
          embedding,
          importance,
          kind,
        });
        await memoryRepo.resetLlmFailures(memory.id);

        updated++;
      } catch (err) {
        // Layer 2 failure tracking: record per-memory failure + maybe quarantine.
        const { quarantined } = await memoryRepo.recordLlmFailure(memory.id);
        const msg =
          err instanceof Error
            ? `memory ${memory.id}: ${err.message}`
            : `memory ${memory.id}: unknown error`;
        errors.push(msg);
        logger.warn(
          {
            memoryId: memory.id,
            quarantined,
            err: err instanceof Error ? err.message : String(err),
          },
          "time-update failed for memory",
        );
      }
    }

    // 7. Mark run completed.
    await dreamingRunRepo.markCompleted(runId, updated + archivedOutdated);

    return { runId, scanned, updated, archivedOutdated, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dreamingRunRepo.markFailed(runId, msg);
    throw err;
  }
}
