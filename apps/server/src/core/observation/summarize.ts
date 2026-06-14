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

const SYSTEM_PROMPT = `You shape raw observations before they enter the memory layer.

This memory exists so that an AI agent can resume work across future sessions.
It is working memory for engineering / operational context, not a personal
journal or lifelog.

## When to skip (skip = true)
Skip observations that the agent will not need as future work context. Examples:
- "I had curry for lunch today"               (personal food log)
- "Tomorrow looks rainy"                       (ambient info, not work-relevant)
- "Hi" / "Got it" / "Thanks"                   (greetings, acknowledgements)
- "Nice" / "Frustrating" / "Tired"             (emotional reaction only)
- "asdf" / "test123"                           (typos, test strings)

Exception: when source is claude-code / codex / yui the content is likely work
context, so lean toward keeping. When type is decision / blocker / discovery /
reflection, do not skip in principle.

## When to keep (skip = false)
- Design decisions, bug fixes, API changes, investigations, library choices,
  operational decisions
- Progress updates ("finished X", "implementation approach was Y")
- The user's **durable** preferences / constraints / role (not one-off taste)

## Output for skip = false
- facts: each fact is a single self-contained sentence (3–5 facts as a guide)
- narrative: 1–2 sentence summary. Preserve searchable keywords (function names,
  code symbols, identifiers) verbatim

## Output language
Reply in the same natural language as the observation content. Code symbols,
identifiers, English library / product names stay verbatim in any language.

## Output JSON schema
{
  "skip": boolean,
  "narrative": string,    // empty string when skip=true
  "facts": string[],      // [] when skip=true
  "reasoning": string     // one sentence explaining the judgement
}`;

function buildUserPrompt(observation: ObservationRow): string {
  return `Observation:
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
