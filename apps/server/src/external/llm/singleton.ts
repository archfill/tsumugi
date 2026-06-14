import { loadConfig } from "../../lib/config.js";
import { TsumugiError } from "../../lib/errors.js";
import { createAnthropicClient } from "./anthropic.js";
import type { LlmClient, LlmTier } from "./types.js";

const cache = new Map<LlmTier, LlmClient>();

export function getLlm(tier: LlmTier): LlmClient {
  const cached = cache.get(tier);
  if (cached) return cached;

  const config = loadConfig();
  const tierConfig = tier === "low" ? config.llm.low : config.llm.mid;
  if (!tierConfig.apiKey) {
    throw new TsumugiError(`LLM_${tier.toUpperCase()}_API_KEY is not set`);
  }

  const client = createAnthropicClient(tierConfig);
  cache.set(tier, client);
  return client;
}

export function resetLlmCache(): void {
  cache.clear();
}
