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
これは AI エージェントが将来のセッションで作業を継続するための「作業記憶」であり、個人の日記やライフログではありません。

## skip = true (保存しない) にすべきケース
個人の生活・嗜好・気分・天気・食事・娯楽など、後で AI エージェントが
作業の文脈として参照しないものは積極的に skip してください。
具体例:
- "今日のランチはカレーライスにした"           (個人の食事・ライフログ)
- "天気予報では明日は雨らしい"                 (環境情報、作業に直結しない)
- "おはようございます" / "了解しました"        (挨拶・確認応答)
- "なるほど"   "うれしい"  "疲れた"            (感情・反応のみ)
- "あいうえお" (誤入力やテスト文字列)

ただし source が claude-code / codex / yui の場合は「作業文脈」の可能性が高いので
保守的に判定する (保存寄り)。type が decision / blocker / discovery / reflection は
原則 skip しない。

## skip = false (保存する) にすべきケース
- 設計判断、bug 修正、API 変更、調査結果、ライブラリ選定、運用上の決定
- 「N 時に何々を完了した」「実装方針はこうした」など作業の進行
- ユーザーの **永続的な** 嗜好・制約・ロール (一回限りの選好ではなく)

## skip = false の出力
- facts: 1 fact = 1 文、独立して意味が通る粒度 (3-5 件目安)
- narrative: 1-2 文の要約。検索クエリにマッチしやすいキーワード (関数名・コードシンボル等) を残す

## 出力 JSON スキーマ
{
  "skip": boolean,
  "narrative": string,         // skip=true なら空文字列
  "facts": string[],           // skip=true なら []
  "reasoning": string          // なぜそう判定したかを 1 文で
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
