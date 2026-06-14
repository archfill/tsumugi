import process from "node:process";
import Anthropic from "@anthropic-ai/sdk";
import { ExternalError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { withRetry } from "../../lib/retry.js";
import type { LlmClient, LlmRequest, LlmResponse } from "./types.js";

class TransientLlmError extends ExternalError {}
class PermanentLlmError extends ExternalError {}

// Anthropic SDK は内部で retry 機構を持つが、tsumugi 全体で挙動を揃えるため
// ここでも transient/permanent 分類と withRetry を被せる。
function classifyAnthropicError(err: unknown): ExternalError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 429 || (status !== undefined && status >= 500)) {
      return new TransientLlmError(`Anthropic API ${status}: ${err.message}`);
    }
    // 4xx (auth, invalid request, content policy violation)
    return new PermanentLlmError(`Anthropic API ${status}: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new TransientLlmError(`Anthropic connection failed: ${err.message}`);
  }
  return new TransientLlmError(
    `Anthropic call failed: ${err instanceof Error ? err.message : String(err)}`,
  );
}

export function createAnthropicClient(opts: {
  apiKey: string;
  model: string;
  maxAttempts?: number;
}): LlmClient {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const maxAttempts =
    opts.maxAttempts ?? Number(process.env["LLM_MAX_RETRIES"] ?? 3);

  async function completeOnce(req: LlmRequest): Promise<LlmResponse> {
    try {
      const res = await client.messages.create({
        model: opts.model,
        max_tokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0.0,
        system: req.jsonResponse
          ? req.system + "\n\nReturn ONLY valid JSON, no other text."
          : req.system,
        messages: [{ role: "user", content: req.user }],
      });

      // stop_reason classification
      // - end_turn / stop_sequence: normal
      // - max_tokens: hit limit → permanent (caller should reduce req size)
      // - refusal: model declined → permanent
      const stopReason = res.stop_reason;
      if (stopReason === "max_tokens") {
        throw new PermanentLlmError(
          "Anthropic response stopped at max_tokens (permanent)",
        );
      }
      if (stopReason === "refusal") {
        throw new PermanentLlmError(
          "Anthropic model refused to respond (permanent)",
        );
      }

      // Extract the first text block from the response
      const textBlock = res.content.find((c) => c.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        // empty content with no clear permanent reason
        throw new TransientLlmError(
          `Anthropic response has no text block (stop_reason=${stopReason ?? "null"})`,
        );
      }

      return {
        text: textBlock.text,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
        },
      };
    } catch (err) {
      if (err instanceof ExternalError) throw err;
      throw classifyAnthropicError(err);
    }
  }

  async function complete(req: LlmRequest): Promise<LlmResponse> {
    return await withRetry(() => completeOnce(req), {
      maxAttempts,
      shouldRetry: (err) => err instanceof TransientLlmError,
      onRetry: (err, attempt, delayMs) => {
        logger.warn(
          {
            provider: "anthropic",
            model: opts.model,
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
      // Strip surrounding text: extract from first '{' to last '}'
      const text = res.text.trim();
      const first = text.indexOf("{");
      const last = text.lastIndexOf("}");
      const json = first >= 0 && last >= 0 ? text.slice(first, last + 1) : text;
      return JSON.parse(json) as T;
    } catch (err) {
      throw new ExternalError(
        `LLM JSON parse failed: ${res.text.slice(0, 200)}`,
        err,
      );
    }
  }

  return { complete, completeJson };
}
