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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TimeUpdateResult {
  runId: string;
  scanned: number;
  updated: number;
  errors: string[];
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
that a future reader knows it describes the past.

## Rewrite guidelines
- Insert past-tense framing ("previously", "at the time", "X months ago", ...)
- Do not invent facts that were not in the original
- Convert information that is likely stale into past tense
  ("was using X", "adopted X at the time")
- Keep it short (1-2 sentences)

## Output language
Rewrite in the same natural language as the original narrative. Preserve code
symbols / identifiers / English product names verbatim.

## Output JSON
{
  "narrative": "time-aware rewritten narrative",
  "reasoning": "short rationale"
}`;

function buildUserPrompt(
  narrative: string,
  elapsedD: number,
  createdAt: Date,
): string {
  return `Original narrative: ${narrative}
Elapsed days: ${Math.floor(elapsedD)}
Created at: ${createdAt.toISOString().slice(0, 10)}

Rewrite it.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsedDays(createdAt: Date): number {
  const ms = Date.now() - createdAt.getTime();
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
    // 2. Load active memories.
    const memories = await memoryRepo.listActive(maxMemories);
    const scanned = memories.length;

    // Update input_count now that we know it.
    await dreamingRunRepo.update(runId, { input_count: scanned });

    const llm = getLlm("low");
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
        // 3. Rewrite narrative via LLM.
        const raw = await llm.completeJson<unknown>({
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(memory.narrative, elapsed, createdAt),
          jsonResponse: true,
          temperature: 0.3,
          maxTokens: 512,
        });

        if (!isLlmRewriteResponse(raw)) {
          throw new ExternalError(
            `time-update LLM returned unexpected shape: ${JSON.stringify(raw)}`,
          );
        }

        const newNarrative = raw.narrative.trim();

        // 4. Re-embed with updated narrative.
        const embedding = Array.from(await embedder.embed(newNarrative));

        // 5. Persist.
        await memoryRepo.update(memory.id, {
          narrative: newNarrative,
          embedding,
          importance,
          kind,
        });

        updated++;
      } catch (err) {
        const msg =
          err instanceof Error
            ? `memory ${memory.id}: ${err.message}`
            : `memory ${memory.id}: unknown error`;
        errors.push(msg);
        console.warn(`[time-update] ${msg}`);
      }
    }

    // 6. Mark run completed.
    await dreamingRunRepo.markCompleted(runId, updated);

    return { runId, scanned, updated, errors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dreamingRunRepo.markFailed(runId, msg);
    throw err;
  }
}
