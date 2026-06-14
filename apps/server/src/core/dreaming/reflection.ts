/**
 * Reflection Use Case — Phase 2 Wave 3D.
 *
 * Summarises all observations within a single session using a LOW-tier LLM
 * (Claude Haiku 4.5) and extracts reusable lessons / patterns / open issues.
 * Each reflection is stored as a memory (kind='reflection'), and provenance
 * links are created from every source observation to the resulting memory.
 *
 * Usage:
 *   const result = await reflectOnSession({ sessionId: 'session_abc' });
 */

import { getLlm } from "../../external/llm/index.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { observationRepo } from "../../data/repos/observation.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { linkRepo } from "../../data/repos/link.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import { newId } from "../../lib/id.js";
import { ExternalError, ValidationError } from "../../lib/errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReflectionResult {
  runId: string;
  sessionId: string;
  observationsScanned: number;
  reflectionsCreated: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは Session Reflector。一つのセッション内の観測群から、
次回以降のセッションで再利用できる教訓・反省・成功パターンを抽出してください。

抽出方針:
- 失敗とその原因 → "lesson" タイプ
- うまくいったパターン → "pattern" タイプ
- 未解決の課題 → "open_issue" タイプ
- 1 件 1-2 文、独立して理解できる粒度

出力 JSON:
{
  "reflections": [
    { "type": "lesson" | "pattern" | "open_issue", "content": string, "importance": number }
  ],
  "summary": string,
  "reasoning": string
}

reflections は 0-5 件。情報量がなければ空配列。`;

// ---------------------------------------------------------------------------
// LLM response types and validation
// ---------------------------------------------------------------------------

interface ReflectionItem {
  type: "lesson" | "pattern" | "open_issue";
  content: string;
  importance: number;
}

interface LlmReflectionResponse {
  reflections: ReflectionItem[];
  summary: string;
  reasoning: string;
}

function validateResponse(raw: unknown): LlmReflectionResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError(
      `Reflection LLM response is not an object: ${JSON.stringify(raw)}`,
    );
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj["reflections"])) {
    throw new ValidationError(
      `Reflection LLM response missing 'reflections' array: ${JSON.stringify(raw)}`,
    );
  }

  const reflections: ReflectionItem[] = [];
  for (const item of obj["reflections"] as unknown[]) {
    if (typeof item !== "object" || item === null) {
      throw new ValidationError(
        `Reflection item is not an object: ${JSON.stringify(item)}`,
      );
    }
    const r = item as Record<string, unknown>;
    if (
      (r["type"] !== "lesson" &&
        r["type"] !== "pattern" &&
        r["type"] !== "open_issue") ||
      typeof r["content"] !== "string" ||
      typeof r["importance"] !== "number"
    ) {
      throw new ValidationError(
        `Reflection item has invalid shape: ${JSON.stringify(item)}`,
      );
    }
    reflections.push({
      type: r["type"] as "lesson" | "pattern" | "open_issue",
      content: r["content"] as string,
      importance: r["importance"] as number,
    });
  }

  if (typeof obj["summary"] !== "string") {
    throw new ValidationError(
      `Reflection LLM response missing string 'summary': ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj["reasoning"] !== "string") {
    throw new ValidationError(
      `Reflection LLM response missing string 'reasoning': ${JSON.stringify(raw)}`,
    );
  }

  return {
    reflections,
    summary: obj["summary"] as string,
    reasoning: obj["reasoning"] as string,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Reflect on a single session: summarise observations and extract lessons.
 *
 * 1. Load all observations for the session (up to maxObservations).
 * 2. If none, skip without creating any records.
 * 3. Call LOW-tier LLM to extract lessons / patterns / open issues.
 * 4. Insert each reflection as a memory (kind='reflection').
 * 5. Create provenance links from every source observation to each memory.
 * 6. Record a dreaming_run (job_kind='reflection').
 */
export async function reflectOnSession(input: {
  sessionId: string;
  maxObservations?: number;
}): Promise<ReflectionResult> {
  const { sessionId, maxObservations = 200 } = input;

  const runId = newId("drun");
  const errors: string[] = [];
  let reflectionsCreated = 0;

  // Record run start.
  await dreamingRunRepo.insert({
    id: runId,
    job_kind: "reflection",
    status: "pending",
    input_count: 0,
    output_count: 0,
    metadata: { sessionId },
  });

  try {
    await dreamingRunRepo.markRunning(runId);

    // 1. Load observations for the session.
    const observations = await observationRepo.listForSession(
      sessionId,
      maxObservations,
    );

    // Update input_count.
    await dreamingRunRepo.update(runId, {
      input_count: observations.length,
    });

    // 2. Skip if no observations.
    if (observations.length === 0) {
      await dreamingRunRepo.markCompleted(runId, 0);
      return {
        runId,
        sessionId,
        observationsScanned: 0,
        reflectionsCreated: 0,
        errors: [],
      };
    }

    // 3. Build prompt and call LLM.
    const userPrompt =
      `セッション ${sessionId} の観測群:\n\n` +
      observations
        .map((o, i) => `[${i}] (${o.type}) ${o.content}`)
        .join("\n\n") +
      "\n\n教訓と pattern を抽出してください。";

    const llm = getLlm("low");
    const embedder = getEmbedder();

    let llmResponse: LlmReflectionResponse;
    try {
      const raw = await llm.completeJson<unknown>({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        jsonResponse: true,
        maxTokens: 2048,
        temperature: 0.0,
      });
      llmResponse = validateResponse(raw);
    } catch (err) {
      if (err instanceof ValidationError || err instanceof ExternalError) {
        throw err;
      }
      throw new ExternalError(
        `Reflection LLM call failed for session ${sessionId}`,
        err,
      );
    }

    // 4. Insert each reflection as a memory + create provenance links.
    for (const r of llmResponse.reflections) {
      try {
        const memId = newId("mem");
        const narrative = `[${r.type}] ${r.content}`;
        const embedding = Array.from(await embedder.embed(narrative));

        await memoryRepo.insert({
          id: memId,
          narrative,
          importance: r.importance ?? 5.0,
          kind: "reflection",
          embedding,
        });
        reflectionsCreated++;

        // 5. Provenance links: each source observation → this reflection memory.
        for (const obs of observations) {
          await linkRepo.insert({
            from_id: obs.id,
            to_id: memId,
            from_layer: "observation",
            to_layer: "memory",
            relation: "derived_from",
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`reflection(${r.type}): ${msg}`);
      }
    }

    // 6. Mark run completed.
    await dreamingRunRepo.markCompleted(runId, reflectionsCreated);

    return {
      runId,
      sessionId,
      observationsScanned: observations.length,
      reflectionsCreated,
      errors,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await dreamingRunRepo.markFailed(runId, msg);
    throw err;
  }
}
