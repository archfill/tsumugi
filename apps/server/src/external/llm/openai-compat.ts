/**
 * OpenAI 互換 chat completions API クライアント。
 *
 * 対応する provider 例 (base URL 例):
 *   - Z.ai            : https://api.z.ai/api/paas/v4
 *   - OpenAI 本家     : https://api.openai.com/v1
 *   - DeepSeek        : https://api.deepseek.com
 *   - OpenRouter      : https://openrouter.ai/api/v1
 *   - Ollama (ローカル): http://localhost:11434/v1
 *
 * 堅牢性 (Layer 1):
 *   - exponential backoff retry (transient のみ): 5xx / 429 / network / empty content
 *   - finish_reason で permanent error (content_filter / length) を識別して即 throw
 *   - per-attempt timeout で hang を防ぐ
 */

import process from "node:process";
import type { LlmClient, LlmRequest, LlmResponse, LlmTier } from "./types.js";
import {
  ExternalError,
  ExternalResponseError,
  ProviderUnavailableError,
  isRetryableExternalError,
} from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { llmRetriesTotal } from "../../lib/metrics.js";
import { withRetry, withTimeout } from "../../lib/retry.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface OpenAiCompatOptions {
  /** Bearer token */
  apiKey: string;
  /** model id (例: 'glm-4.5-air') */
  model: string;
  /** base URL (末尾 /v1 等まで含む) */
  baseUrl: string;
  /** max retry attempts (default 3, env LLM_MAX_RETRIES で上書き可) */
  maxAttempts?: number;
  /** per-attempt timeout ms (default 30000, env LLM_TIMEOUT_MS で上書き可) */
  timeoutMs?: number;
  /** Metrics label supplied by the tier singleton. */
  tier?: LlmTier;
}

// permanent failure reasons returned in finish_reason
const PERMANENT_FINISH_REASONS = new Set([
  "content_filter",
  "length", // max_tokens reached without producing content
]);

class PermanentLlmError extends ExternalError {}

export function createOpenAiCompatClient(opts: OpenAiCompatOptions): LlmClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const maxAttempts =
    opts.maxAttempts ?? Number(process.env["LLM_MAX_RETRIES"] ?? 3);
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env["LLM_TIMEOUT_MS"] ?? 30000);

  async function completeOnce(req: LlmRequest): Promise<LlmResponse> {
    const systemPrompt = req.jsonResponse
      ? req.system + "\n\nReturn ONLY valid JSON, no other text."
      : req.system;

    const body = {
      model: opts.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: req.user },
      ],
      temperature: req.temperature ?? 0.0,
      max_tokens: req.maxTokens ?? 2048,
      ...(req.jsonResponse
        ? { response_format: { type: "json_object" as const } }
        : {}),
    };

    const res = await withTimeout(
      (signal) =>
        fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        }),
      timeoutMs,
      `OpenAI-compat fetch timed out after ${timeoutMs}ms (${baseUrl})`,
    ).catch((err) => {
      // network failure / timeout -> transient
      const message = err instanceof Error ? err.message : String(err);
      throw new ProviderUnavailableError(
        `OpenAI-compat fetch failed (${baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
        message.includes("timed out") ? "timeout" : "network",
        err,
      );
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const msg = `OpenAI-compat API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`;
      // 4xx (auth, invalid request) = permanent; 5xx / 429 = transient
      if (res.status === 429 || res.status >= 500) {
        throw new ProviderUnavailableError(
          msg,
          res.status === 429 ? "rate_limit" : "server_error",
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new ProviderUnavailableError(msg, "auth");
      }
      throw new PermanentLlmError(msg);
    }

    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      // body parse failure = transient (proxy/CDN garbling, partial response)
      throw new ExternalResponseError(
        "OpenAI-compat response JSON parse failed",
        err,
      );
    }

    const choice = json.choices?.[0];
    const finishReason = choice?.finish_reason;
    const text = choice?.message?.content ?? "";

    if (!text) {
      // classify by finish_reason
      if (finishReason && PERMANENT_FINISH_REASONS.has(finishReason)) {
        throw new PermanentLlmError(
          `OpenAI-compat empty content (permanent, finish_reason=${finishReason})`,
        );
      }
      // empty content with no clear reason -> transient (provider hiccup)
      throw new ExternalResponseError(
        `OpenAI-compat empty content (transient, finish_reason=${finishReason ?? "null"})`,
      );
    }

    return {
      text,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    return await withRetry(() => completeOnce(req), {
      maxAttempts,
      shouldRetry: isRetryableExternalError,
      onRetry: (err, attempt, delayMs) => {
        const reason =
          err instanceof ProviderUnavailableError ? err.reason : "response";
        llmRetriesTotal.inc({ tier: opts.tier ?? "low", reason });
        logger.warn(
          {
            provider: "openai-compat",
            model: opts.model,
            baseUrl,
            attempt,
            maxAttempts,
            delayMs,
            err: err instanceof Error ? err.message : String(err),
          },
          "llm retry",
        );
      },
    });
  }

  async function completeJson<T>(req: LlmRequest): Promise<T> {
    const res = await complete({ ...req, jsonResponse: true });
    try {
      const text = res.text.trim();
      const first = text.indexOf("{");
      const last = text.lastIndexOf("}");
      const json = first >= 0 && last >= 0 ? text.slice(first, last + 1) : text;
      return JSON.parse(json) as T;
    } catch (err) {
      throw new ExternalError(
        `OpenAI-compat JSON parse failed: ${res.text.slice(0, 200)}`,
        err,
      );
    }
  }

  return { complete, completeJson };
}
