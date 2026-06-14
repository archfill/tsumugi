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

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは記憶層の差分判定担当 (AUDN: ADD/UPDATE/DELETE/NOOP)。
新規 fact と既存 memory 群を比較し、次の判定を 1 件返してください。

判定基準:
- ADD: new_fact が独立した新情報。既存 memory のどれとも主題が異なる
- UPDATE: 既存 memory の主題と一致するが内容が更新されている (target_index で対象を指定)
- DELETE: new_fact が既存 memory の撤回・否定 (target_index で対象を指定)
- NOOP: new_fact と等価な情報が既に存在し、追加情報なし (target_index 不要)

主題継続の判定例:
- "OAuth を採用" + "OAuth 2.0 ではなく SAML に変更" → UPDATE (主題=認証方式)
- "DB は MySQL" + "前述の MySQL 採用は撤回" → DELETE (主題=DB 選定)
- "memory 1024 dim" + "BGE-M3 採用" → ADD (主題が独立)
- "auth は OAuth" + "OAuth を使う" → NOOP (等価)

出力 JSON:
{
  "decision": "ADD" | "UPDATE" | "DELETE" | "NOOP",
  "target_index": number | null,   // UPDATE/DELETE のとき指定、ADD/NOOP では null
  "new_narrative": string | null,  // ADD/UPDATE のとき新しい narrative、DELETE/NOOP では null
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
    return await addMemory(newFact, sourceObservationId);
  }

  // 4. Call MID-tier LLM for judgement.
  const llm = getLlm("mid");

  const userPrompt = `新規 fact:
${newFact}

既存 memory:
${existingMemories.map((m, i) => `[${i}] ${m.narrative}`).join("\n")}

何件目を target にするか、あるいは新規追加か、判定してください。`;

  const raw = await llm.completeJson<unknown>({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    jsonResponse: true,
    temperature: 0.0,
  });

  if (!isLlmJudgement(raw)) {
    throw new ValidationError(
      `AUDN LLM returned unexpected JSON shape: ${JSON.stringify(raw)}`,
    );
  }

  const { decision, target_index, new_narrative, reasoning } = raw;

  // Validate decision value.
  if (!["ADD", "UPDATE", "DELETE", "NOOP"].includes(decision)) {
    throw new ValidationError(`AUDN: unknown decision value "${decision}"`);
  }

  const audnDecision = decision as AudnDecision;

  // 5. Resolve target memory.
  let targetMemory =
    target_index !== null ? existingMemories[target_index] : undefined;

  if (
    (audnDecision === "UPDATE" || audnDecision === "DELETE") &&
    !targetMemory
  ) {
    // target_index out of range → fallback to NOOP.
    console.warn(
      `[audn] target_index=${target_index} out of range (${existingMemories.length} memories) — fallback NOOP`,
    );
    return { decision: "NOOP", reasoning };
  }

  // 6. Apply decision.
  switch (audnDecision) {
    case "ADD":
      return await addMemory(new_narrative || newFact, sourceObservationId);

    case "UPDATE": {
      const narrative = new_narrative || newFact;
      const embedding = Array.from(await getEmbedder().embed(narrative));
      await memoryRepo.update(targetMemory!.id, { narrative, embedding });
      await linkRepo.insert({
        from_id: sourceObservationId,
        to_id: targetMemory!.id,
        from_layer: "observation",
        to_layer: "memory",
        relation: "derived_from",
      });
      return {
        decision: "UPDATE",
        targetMemoryId: targetMemory!.id,
        resultMemoryId: targetMemory!.id,
        reasoning,
      };
    }

    case "DELETE":
      await memoryRepo.archive(targetMemory!.id);
      await linkRepo.insert({
        from_id: sourceObservationId,
        to_id: targetMemory!.id,
        from_layer: "observation",
        to_layer: "memory",
        relation: "supersedes",
      });
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
