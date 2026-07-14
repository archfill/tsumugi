/**
 * AUDN Judge — ADD / UPDATE / DELETE / NOOP decision for memory management.
 *
 * Given a new fact and similar existing memories retrieved by hybrid search,
 * uses a MID-tier LLM (Sonnet 4.6) to decide what to do with the memory layer.
 *
 * Usage:
 *   const result = await audnJudge({ newFact: '...', sourceObservationId: 'obs_...' });
 */

import { getLlm } from "../../external/llm/index.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { hybridSearch } from "../search/hybrid.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { linkRepo } from "../../data/repos/link.js";
import { newId } from "../../lib/id.js";
import { ValidationError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AudnDecision = "ADD" | "UPDATE" | "DELETE" | "NOOP";

export interface AudnResult {
  decision: AudnDecision;
  /** Present when decision is UPDATE or DELETE. */
  targetMemoryId?: string;
  /** Present when decision is ADD or UPDATE (the memory that was created/updated). */
  resultMemoryId?: string;
  reasoning: string;
}

export interface AudnJudgeInput {
  newFact: string;
  sourceObservationId: string;
  /** Number of similar memories to retrieve (default 5). */
  topK?: number;
}

export interface AudnPlan {
  decision: AudnDecision;
  targetMemoryId?: string;
  narrative?: string;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the AUDN (ADD/UPDATE/DELETE/NOOP) judge for the memory layer.
Compare a new fact against existing similar memories and return exactly one
judgement.

## Decision criteria
- ADD: new_fact is independent new information. Its subject differs from every
  existing memory.
- UPDATE: subject matches an existing memory but its content has changed
  (specify target with target_index).
- DELETE: new_fact retracts / negates an existing memory (specify target with
  target_index).
- NOOP: an equivalent fact already exists; no new information.

## Subject-continuity examples
- "Adopt OAuth" + "Switch from OAuth 2.0 to SAML"  → UPDATE (subject = auth method)
- "DB is MySQL" + "MySQL adoption is withdrawn"     → DELETE (subject = DB choice)
- "Embedding dim = 1024" + "Adopt BGE-M3"           → ADD    (subjects independent)
- "Auth uses OAuth" + "OAuth is the auth method"    → NOOP   (equivalent)

## Output language
Write new_narrative and reasoning in the same natural language as the inputs.
Preserve code symbols / identifiers / English product names verbatim.

## new_narrative density (ADD / UPDATE)
new_narrative must remain **self-contained**: preserve when / where / why
context (date, project, subsystem, metric, identifier) that the input fact
carried. Compression is fine; context erosion is not. A memory that reads
"X was changed" without the surrounding context cannot be reused by a future
session.
- bad:  "The noise filtering was specifically targeting the old hook system."
- good: "On 2026-06-16, after the yui→tsumugi migration, the classifyNoise()
        filter in extract.ts was hardened across PR #17 and #21 to drop
        old-hook-derived noise (2,637 observations removed)."

## Output JSON
{
  "decision": "ADD" | "UPDATE" | "DELETE" | "NOOP",
  "target_index": number | null,   // index of target memory for UPDATE/DELETE; null for ADD/NOOP
  "new_narrative": string | null,  // new narrative for ADD/UPDATE; null for DELETE/NOOP
  "reasoning": string
}`;

// ---------------------------------------------------------------------------
// Internal LLM response shape
// ---------------------------------------------------------------------------

interface LlmJudgement {
  decision: string;
  target_index: number | null;
  /**
   * ADD/UPDATE のときに生成された新 narrative。
   * DELETE/NOOP のときは LLM が null を返すのが自然なので許容する。
   */
  new_narrative: string | null;
  reasoning: string;
}

const AUDN_MAX_TOKENS = 8192;

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function describeLlmJudgementShape(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `top_level=${valueType(value)}`;
  }
  const obj = value as Record<string, unknown>;
  return ["decision", "target_index", "new_narrative", "reasoning"]
    .map((key) =>
      Object.hasOwn(obj, key) ? `${key}=${valueType(obj[key])}` : `${key}=missing`,
    )
    .join(",");
}

function isLlmJudgement(v: unknown): v is LlmJudgement {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj["decision"] === "string" &&
    (obj["target_index"] === null || typeof obj["target_index"] === "number") &&
    (obj["new_narrative"] === null ||
      typeof obj["new_narrative"] === "string") &&
    typeof obj["reasoning"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Pure judgement (no DB side effects)
// ---------------------------------------------------------------------------

export interface JudgeOnlyInput {
  newFact: string;
  existingMemoryNarratives: string[];
}

export interface JudgeOnlyResult {
  decision: AudnDecision;
  targetIndex: number | null;
  newNarrative: string | null;
  reasoning: string;
}

/**
 * Pure LLM judgement: take a new fact + list of existing memory narratives,
 * return the AUDN decision without touching the database or search.
 *
 * Used by `audnJudge` (with search-retrieved memories) and by evaluation
 * benches (with fixture-provided memories).
 *
 * Fast-path: empty memory list → ADD without LLM call.
 */
export async function judgeOnly(
  input: JudgeOnlyInput,
): Promise<JudgeOnlyResult> {
  const { newFact, existingMemoryNarratives } = input;

  if (existingMemoryNarratives.length === 0) {
    return {
      decision: "ADD",
      targetIndex: null,
      newNarrative: newFact,
      reasoning: "No existing memories — straight ADD.",
    };
  }

  const llm = getLlm("mid");

  const userPrompt = `New fact:
${newFact}

Existing memories:
${existingMemoryNarratives.map((n, i) => `[${i}] ${n}`).join("\n")}

Decide which (if any) memory is the target, or whether to add a new one.`;

  const raw = await llm.completeJson<unknown>({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    jsonResponse: true,
    maxTokens: AUDN_MAX_TOKENS,
    temperature: 0.0,
  });

  if (!isLlmJudgement(raw)) {
    throw new ValidationError(
      `AUDN LLM returned unexpected JSON shape (${describeLlmJudgementShape(raw)})`,
    );
  }

  const { decision, target_index, new_narrative, reasoning } = raw;

  if (!["ADD", "UPDATE", "DELETE", "NOOP"].includes(decision)) {
    throw new ValidationError(`AUDN: unknown decision value "${decision}"`);
  }

  return {
    decision: decision as AudnDecision,
    targetIndex: target_index,
    newNarrative: new_narrative,
    reasoning,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Judge whether a new fact should ADD, UPDATE, DELETE, or NOOP against
 * the existing memory layer.
 *
 * @param input.newFact              The new fact to evaluate.
 * @param input.sourceObservationId  Observation ID this fact was derived from.
 * @param input.topK                 How many similar memories to retrieve (default 5).
 */
export async function audnJudge(input: AudnJudgeInput): Promise<AudnResult> {
  const { newFact, sourceObservationId, topK = 5 } = input;

  const plan = await planAudn({ newFact, topK });

  switch (plan.decision) {
    case "ADD":
      return await addMemory(plan.narrative || newFact, sourceObservationId);

    case "UPDATE": {
      const narrative = plan.narrative || newFact;
      const embedding = Array.from(await getEmbedder().embed(narrative));
      await memoryRepo.update(plan.targetMemoryId!, { narrative, embedding });
      await linkRepo.insert({
        from_id: sourceObservationId,
        to_id: plan.targetMemoryId!,
        from_layer: "observation",
        to_layer: "memory",
        relation: "derived_from",
      });
      return {
        decision: "UPDATE",
        targetMemoryId: plan.targetMemoryId,
        resultMemoryId: plan.targetMemoryId,
        reasoning: plan.reasoning,
      };
    }

    case "DELETE":
      await memoryRepo.archive(plan.targetMemoryId!);
      await linkRepo.insert({
        from_id: sourceObservationId,
        to_id: plan.targetMemoryId!,
        from_layer: "observation",
        to_layer: "memory",
        relation: "supersedes",
      });
      return {
        decision: "DELETE",
        targetMemoryId: plan.targetMemoryId,
        reasoning: plan.reasoning,
      };

    case "NOOP":
      return { decision: "NOOP", reasoning: plan.reasoning };
  }
}

export async function planAudn(input: {
  newFact: string;
  topK?: number;
}): Promise<AudnPlan> {
  const { newFact, topK = 5 } = input;

  // 1. Retrieve similar existing memories.
  const hits = await hybridSearch(
    { query: newFact, limit: topK },
    { layers: ["memory"] },
  );

  // 2. Load full memory rows for the hits (need narrative + id).
  const existingMemories = (
    await Promise.all(hits.map((h) => memoryRepo.findById(h.id)))
  ).filter(
    (m): m is NonNullable<typeof m> => m !== null && m.archived_at === null,
  );

  // 3. Fast-path: no existing memories → always ADD without calling LLM.
  if (existingMemories.length === 0) {
    return {
      decision: "ADD",
      narrative: newFact,
      reasoning: "No similar memory found — create new memory.",
    };
  }

  // 4. Call pure judgement (same LLM call path that bench exercises).
  const judgement = await judgeOnly({
    newFact,
    existingMemoryNarratives: existingMemories.map((m) => m.narrative),
  });

  const audnDecision = judgement.decision;
  const target_index = judgement.targetIndex;
  const new_narrative = judgement.newNarrative;
  const reasoning = judgement.reasoning;

  // 5. Resolve target memory.
  let targetMemory =
    target_index !== null ? existingMemories[target_index] : undefined;

  if (
    (audnDecision === "UPDATE" || audnDecision === "DELETE") &&
    !targetMemory
  ) {
    // target_index out of range → fallback to NOOP.
    logger.warn(
      {
        targetIndex: target_index,
        memoryCount: existingMemories.length,
      },
      "AUDN target_index out of range, fallback to NOOP",
    );
    return { decision: "NOOP", reasoning };
  }

  // 6. Return a side-effect-free plan. The durable fact worker applies it in
  // one DB transaction together with provenance and fact completion.
  switch (audnDecision) {
    case "ADD":
      return {
        decision: "ADD",
        narrative: new_narrative || newFact,
        reasoning,
      };

    case "UPDATE":
      return {
        decision: "UPDATE",
        targetMemoryId: targetMemory!.id,
        narrative: new_narrative || newFact,
        reasoning,
      };

    case "DELETE":
      return {
        decision: "DELETE",
        targetMemoryId: targetMemory!.id,
        reasoning,
      };

    case "NOOP":
      return { decision: "NOOP", reasoning };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function addMemory(
  narrative: string,
  sourceObservationId: string,
): Promise<AudnResult> {
  const memId = newId("mem");
  const embedding = Array.from(await getEmbedder().embed(narrative));

  await memoryRepo.insert({
    id: memId,
    narrative,
    importance: 5.0,
    kind: "general",
    embedding,
  });

  await linkRepo.insert({
    from_id: sourceObservationId,
    to_id: memId,
    from_layer: "observation",
    to_layer: "memory",
    relation: "derived_from",
  });

  return {
    decision: "ADD",
    resultMemoryId: memId,
    reasoning: "No similar memory found — created new memory.",
  };
}
