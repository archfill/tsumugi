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
 * SDK は使わず fetch 直叩き。理由:
 *   - tsumugi の依存数を最小化
 *   - provider ごとの SDK 細部 (ヘッダ追加・retry 等) に縛られない
 *   - tier 切替が config 追加 1 行で済む
 */

import type { LlmClient, LlmRequest, LlmResponse } from "./types.js";
import { ExternalError } from "../../lib/errors.js";

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
}

export function createOpenAiCompatClient(opts: OpenAiCompatOptions): LlmClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");

  async function complete(req: LlmRequest): Promise<LlmResponse> {
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

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ExternalError(`OpenAI-compat fetch failed (${baseUrl})`, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ExternalError(
        `OpenAI-compat API ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
      );
    }

    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      throw new ExternalError("OpenAI-compat response JSON parse failed", err);
    }

    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text) {
      throw new ExternalError("OpenAI-compat response had no content");
    }

    return {
      text,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
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
