import Anthropic from "@anthropic-ai/sdk";
import { ExternalError } from "../../lib/errors.js";
import type { LlmClient, LlmRequest, LlmResponse } from "./types.js";

export function createAnthropicClient(opts: {
  apiKey: string;
  model: string;
}): LlmClient {
  const client = new Anthropic({ apiKey: opts.apiKey });

  async function complete(req: LlmRequest): Promise<LlmResponse> {
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

      // Extract the first text block from the response
      const textBlock = res.content.find((c) => c.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new ExternalError("LLM response has no text block");
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
      throw new ExternalError("Anthropic API call failed", err);
    }
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
