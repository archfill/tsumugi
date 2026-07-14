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

export interface AudnPlanBatchInput {
  factId: string;
  newFact: string;
  topK?: number;
}

export interface AudnPlanBatchResult {
  factId: string;
  plan: AudnPlan;
}

type ExistingMemory = NonNullable<
  Awaited<ReturnType<typeof memoryRepo.findById>>
>;

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

const BATCH_SYSTEM_PROMPT = `You are the AUDN (ADD/UPDATE/DELETE/NOOP) judge for the memory layer.
Evaluate each fact independently against only its own indexed candidate memories.
Do not let facts or candidates from one item influence another item.

## Decision criteria
- ADD: the fact is independent new information. Its subject differs from every
  candidate memory for that item.
- UPDATE: the subject matches a candidate memory but its content has changed.
- DELETE: the fact retracts or negates a candidate memory.
- NOOP: an equivalent fact already exists; there is no new information.

## Subject-continuity examples
- "Adopt OAuth" + "Switch from OAuth 2.0 to SAML"  -> UPDATE (subject = auth method)
- "DB is MySQL" + "MySQL adoption is withdrawn"     -> DELETE (subject = DB choice)
- "Embedding dim = 1024" + "Adopt BGE-M3"           -> ADD    (subjects independent)
- "Auth uses OAuth" + "OAuth is the auth method"    -> NOOP   (equivalent)

## Output language
Write new_narrative and reasoning in the same natural language as each fact.
Preserve code symbols / identifiers / English product names verbatim.

## new_narrative density (ADD / UPDATE)
new_narrative must remain self-contained: preserve when / where / why context
(date, project, subsystem, metric, identifier) that the input fact carried.
Compression is fine; context erosion is not.

For UPDATE and DELETE, target_index must be the index of a candidate belonging
to that same fact.

Return exactly one judgement for every supplied fact_id and no others.

## Output JSON
{
  "judgements": [
    {
      "fact_id": string,
      "decision": "ADD" | "UPDATE" | "DELETE" | "NOOP",
      "target_index": number | null,
      "new_narrative": string | null,
      "reasoning": string
    }
  ]
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

interface LlmBatchJudgement extends LlmJudgement {
  fact_id: string;
}

interface LlmBatchResponse {
  judgements: LlmBatchJudgement[];
}

const AUDN_MAX_TOKENS = 8192;
const AUDN_BATCH_TIMEOUT_MS = 60_000;

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

function describeLlmBatchShape(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `top_level=${valueType(value)}`;
  }
  const judgements = (value as Record<string, unknown>)["judgements"];
  if (!Array.isArray(judgements)) {
    return `judgements=${valueType(judgements)}`;
  }
  const itemShapes = judgements.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return valueType(item);
    }
    const obj = item as Record<string, unknown>;
    return [
      "fact_id",
      "decision",
      "target_index",
      "new_narrative",
      "reasoning",
    ]
      .map((key) =>
        Object.hasOwn(obj, key)
          ? `${key}=${valueType(obj[key])}`
          : `${key}=missing`,
      )
      .join(",");
  });
  return `judgements=array(length=${judgements.length},items=[${itemShapes.join("|")}])`;
}

function parseLlmBatchResponse(value: unknown): LlmBatchResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const judgements = (value as Record<string, unknown>)["judgements"];
  if (!Array.isArray(judgements)) return null;

  const normalized: LlmBatchJudgement[] = [];
  for (const item of judgements) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return null;
    }
    const obj = item as Record<string, unknown>;
    const judgement = {
      fact_id: obj["fact_id"],
      decision: obj["decision"],
      target_index: obj["target_index"] ?? null,
      new_narrative: obj["new_narrative"] ?? null,
      reasoning: obj["reasoning"],
    };
    if (
      typeof judgement.fact_id !== "string" ||
      !isLlmJudgement(judgement)
    ) {
      return null;
    }
    normalized.push(judgement as LlmBatchJudgement);
  }
  return { judgements: normalized };
}

function isAudnDecision(value: string): value is AudnDecision {
  return ["ADD", "UPDATE", "DELETE", "NOOP"].includes(value);
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

export interface JudgeOnlyBatchItem extends JudgeOnlyInput {
  factId: string;
}

export interface JudgeOnlyBatchResult extends JudgeOnlyResult {
  factId: string;
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

  if (!isAudnDecision(decision)) {
    throw new ValidationError(`AUDN: unknown decision value "${decision}"`);
  }

  return {
    decision: decision as AudnDecision,
    targetIndex: target_index,
    newNarrative: new_narrative,
    reasoning,
  };
}

/**
 * Evaluate multiple independent facts in one LLM request. Facts without any
 * candidate memories keep the existing deterministic ADD fast path.
 *
 * This function is side-effect free. Durable claiming and transactional apply
 * remain the responsibility of the promotion worker.
 */
export async function judgeOnlyBatch(
  items: JudgeOnlyBatchItem[],
): Promise<JudgeOnlyBatchResult[]> {
  if (items.length === 0) return [];

  const inputsById = new Map<string, JudgeOnlyBatchItem>();
  for (const item of items) {
    if (!item.factId.trim()) {
      throw new ValidationError("AUDN batch fact_id must not be empty");
    }
    if (inputsById.has(item.factId)) {
      throw new ValidationError(
        `AUDN batch input contains duplicate fact_id "${item.factId}"`,
      );
    }
    inputsById.set(item.factId, item);
  }

  const resultsById = new Map<string, JudgeOnlyBatchResult>();
  const pending = items.filter((item) => {
    if (item.existingMemoryNarratives.length > 0) return true;
    resultsById.set(item.factId, {
      factId: item.factId,
      decision: "ADD",
      targetIndex: null,
      newNarrative: item.newFact,
      reasoning: "No existing memories - straight ADD.",
    });
    return false;
  });

  if (pending.length === 0) {
    return items.map((item) => resultsById.get(item.factId)!);
  }

  const llm = getLlm("mid");
  const pendingBatchItems = pending.map((item, index) => ({
    batchId: `f${index}`,
    item,
  }));
  const pendingByBatchId = new Map(
    pendingBatchItems.map((entry) => [entry.batchId, entry.item]),
  );
  const batchInput = pendingBatchItems.map(({ batchId, item }) => ({
    fact_id: batchId,
    new_fact: item.newFact,
    candidate_memories: item.existingMemoryNarratives.map(
      (narrative, index) => ({ index, narrative }),
    ),
  }));
  const raw = await llm.completeJson<unknown>({
    system: BATCH_SYSTEM_PROMPT,
    user: `Evaluate these facts independently:\n${JSON.stringify(batchInput, null, 2)}`,
    jsonResponse: true,
    maxTokens: AUDN_MAX_TOKENS,
    temperature: 0.0,
    timeoutMs: AUDN_BATCH_TIMEOUT_MS,
  });

  const parsed = parseLlmBatchResponse(raw);
  if (!parsed) {
    throw new ValidationError(
      `AUDN batch LLM returned unexpected JSON shape (${describeLlmBatchShape(raw)})`,
    );
  }

  const seenBatchIds = new Set<string>();
  for (const judgement of parsed.judgements) {
    const input = pendingByBatchId.get(judgement.fact_id);
    if (!input) {
      throw new ValidationError(
        `AUDN batch LLM returned unknown fact_id "${judgement.fact_id}"`,
      );
    }
    if (seenBatchIds.has(judgement.fact_id)) {
      throw new ValidationError(
        `AUDN batch LLM returned duplicate fact_id "${judgement.fact_id}"`,
      );
    }
    seenBatchIds.add(judgement.fact_id);
    if (!isAudnDecision(judgement.decision)) {
      throw new ValidationError(
        `AUDN batch: unknown decision value "${judgement.decision}" for fact_id "${input.factId}"`,
      );
    }

    if (
      (judgement.decision === "UPDATE" || judgement.decision === "DELETE") &&
      (!Number.isInteger(judgement.target_index) ||
        judgement.target_index === null ||
        judgement.target_index < 0 ||
        judgement.target_index >= input.existingMemoryNarratives.length)
    ) {
      throw new ValidationError(
        `AUDN batch target_index out of range for fact_id "${input.factId}"`,
      );
    }

    resultsById.set(input.factId, {
      factId: input.factId,
      decision: judgement.decision,
      targetIndex: judgement.target_index,
      newNarrative: judgement.new_narrative,
      reasoning: judgement.reasoning,
    });
  }

  for (const { batchId, item } of pendingBatchItems) {
    if (!seenBatchIds.has(batchId)) {
      throw new ValidationError(
        `AUDN batch LLM omitted fact_id "${item.factId}"`,
      );
    }
  }

  return items.map((item) => resultsById.get(item.factId)!);
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
  const existingMemories = await loadExistingMemories(newFact, topK);

  // Fast-path: no existing memories → always ADD without calling LLM.
  if (existingMemories.length === 0) {
    return {
      decision: "ADD",
      narrative: newFact,
      reasoning: "No similar memory found — create new memory.",
    };
  }

  const judgement = await judgeOnly({
    newFact,
    existingMemoryNarratives: existingMemories.map((memory) => memory.narrative),
  });
  return buildAudnPlan(newFact, existingMemories, judgement);
}

/**
 * Plan several independent durable facts with one MID-tier LLM request.
 * Search remains fact-scoped; only the pure AUDN judgement is batched.
 */
export async function planAudnBatch(
  inputs: AudnPlanBatchInput[],
): Promise<AudnPlanBatchResult[]> {
  if (inputs.length === 0) return [];

  const prepared: Array<{
    input: AudnPlanBatchInput;
    existingMemories: ExistingMemory[];
  }> = [];
  for (const input of inputs) {
    prepared.push({
      input,
      existingMemories: await loadExistingMemories(
        input.newFact,
        input.topK ?? 5,
      ),
    });
  }

  const judgements = await judgeOnlyBatch(
    prepared.map(({ input, existingMemories }) => ({
      factId: input.factId,
      newFact: input.newFact,
      existingMemoryNarratives: existingMemories.map(
        (memory) => memory.narrative,
      ),
    })),
  );
  const judgementById = new Map(
    judgements.map((judgement) => [judgement.factId, judgement]),
  );
  return prepared.map(({ input, existingMemories }) => {
    const judgement = judgementById.get(input.factId);
    if (!judgement) {
      throw new ValidationError(
        `AUDN batch plan missing fact_id "${input.factId}"`,
      );
    }
    return {
      factId: input.factId,
      plan: buildAudnPlan(input.newFact, existingMemories, judgement),
    };
  });
}

async function loadExistingMemories(
  newFact: string,
  topK: number,
): Promise<ExistingMemory[]> {
  const hits = await hybridSearch(
    { query: newFact, limit: topK },
    { layers: ["memory"] },
  );
  return (
    await Promise.all(hits.map((h) => memoryRepo.findById(h.id)))
  ).filter(
    (m): m is NonNullable<typeof m> => m !== null && m.archived_at === null,
  );
}

function buildAudnPlan(
  newFact: string,
  existingMemories: ExistingMemory[],
  judgement: JudgeOnlyResult,
): AudnPlan {
  const audnDecision = judgement.decision;
  const target_index = judgement.targetIndex;
  const new_narrative = judgement.newNarrative;
  const reasoning = judgement.reasoning;

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

  // Return a side-effect-free plan. The durable fact worker applies it in
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
