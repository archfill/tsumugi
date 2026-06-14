/**
 * Observation summarize use case — Phase 2 Wave 2A
 *
 * Sends raw observations to the LOW-tier LLM to:
 *   1. Decide whether the observation is worth retaining (skip flag)
 *   2. Extract atomic facts (3-5 single-sentence facts)
 *   3. Generate a short narrative suitable for downstream embedding + AUDN judge
 *
 * This use case is purely transformative — it does NOT write to the DB.
 * DB persistence is the responsibility of a subsequent promote use case.
 */

import { getLlm } from "../../external/llm/index.js";
import { ExternalError, ValidationError } from "../../lib/errors.js";
import type { ObservationRow } from "../../data/repos/observation.js";

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `あなたは記憶層に取り込む観測の整形担当です。
以下の観測から、後で検索・再利用するための構造化情報を抽出してください。

判断基準:
- skip = true にすべきケース: 単なる挨拶、雑談、感情表現のみ、内容のない確認応答、誤入力
- skip = false なら facts に分解する: 1 fact = 1 文、独立して意味が通る粒度
- narrative は 1-2 文で「何が起きたか」を要約。検索 query にマッチしやすい語彙を使う

出力 JSON スキーマ:
{
  "skip": boolean,
  "narrative": string,         // skip=true なら空文字列
  "facts": string[],           // skip=true なら []
  "reasoning": string          // 簡潔に
}`;

function buildUserPrompt(observation: ObservationRow): string {
  return `観測:
<source>${observation.source}</source>
<type>${observation.type}</type>
<content>
${observation.content}
</content>`;
}

// ---------------------------------------------------------------------------
// LLM response schema (runtime validation)
// ---------------------------------------------------------------------------

interface LlmSummarizePayload {
  skip: boolean;
  narrative: string;
  facts: string[];
  reasoning: string;
}

function validatePayload(raw: unknown): LlmSummarizePayload {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError(
      `LLM summarize response is not an object: ${JSON.stringify(raw)}`,
    );
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj["skip"] !== "boolean") {
    throw new ValidationError(
      `LLM summarize response missing boolean 'skip': ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj["narrative"] !== "string") {
    throw new ValidationError(
      `LLM summarize response missing string 'narrative': ${JSON.stringify(raw)}`,
    );
  }
  if (
    !Array.isArray(obj["facts"]) ||
    !obj["facts"].every((f) => typeof f === "string")
  ) {
    throw new ValidationError(
      `LLM summarize response 'facts' must be string[]: ${JSON.stringify(raw)}`,
    );
  }
  if (typeof obj["reasoning"] !== "string") {
    throw new ValidationError(
      `LLM summarize response missing string 'reasoning': ${JSON.stringify(raw)}`,
    );
  }

  return {
    skip: obj["skip"] as boolean,
    narrative: obj["narrative"] as string,
    facts: obj["facts"] as string[],
    reasoning: obj["reasoning"] as string,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SummarizeResult {
  observationId: string;
  skip: boolean;
  narrative: string;
  facts: string[];
  reasoning: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function summarizeObservation(
  observation: ObservationRow,
): Promise<SummarizeResult> {
  const llm = getLlm("low");

  let payload: LlmSummarizePayload;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    const response = await llm.complete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(observation),
      jsonResponse: true,
      maxTokens: 1024,
      temperature: 0.0,
    });

    inputTokens = response.usage?.inputTokens;
    outputTokens = response.usage?.outputTokens;

    // completeJson is not used here so we can capture usage; parse manually
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch (parseErr) {
      throw new ExternalError(
        `LLM summarize response is not valid JSON: ${response.text}`,
        parseErr,
      );
    }

    payload = validatePayload(parsed);
  } catch (err) {
    if (err instanceof ExternalError || err instanceof ValidationError) {
      throw err;
    }
    throw new ExternalError(
      `LLM summarize call failed for observation ${observation.id}`,
      err,
    );
  }

  return {
    observationId: observation.id,
    skip: payload.skip,
    narrative: payload.narrative,
    facts: payload.facts,
    reasoning: payload.reasoning,
    inputTokens,
    outputTokens,
  };
}

/**
 * Summarize multiple observations in parallel.
 * Concurrency control is left to the caller (use p-limit or similar if needed).
 */
export async function summarizeMany(
  observations: ObservationRow[],
): Promise<SummarizeResult[]> {
  return Promise.all(observations.map((obs) => summarizeObservation(obs)));
}
