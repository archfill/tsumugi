import { loadConfig, type LlmModelConfig } from "../../lib/config.js";
import { TsumugiError } from "../../lib/errors.js";
import { createAnthropicClient } from "./anthropic.js";
import { createOpenAiCompatClient } from "./openai-compat.js";
import type { LlmClient, LlmTier } from "./types.js";

const cache = new Map<LlmTier, LlmClient>();

function buildClient(tier: LlmTier, cfg: LlmModelConfig): LlmClient {
  if (!cfg.apiKey) {
    throw new TsumugiError(`LLM_${tier.toUpperCase()}_API_KEY is not set`);
  }
  if (!cfg.model) {
    throw new TsumugiError(`LLM_${tier.toUpperCase()}_MODEL is not set`);
  }

  switch (cfg.provider) {
    case "anthropic":
      return createAnthropicClient({ apiKey: cfg.apiKey, model: cfg.model });
    case "openai-compat": {
      if (!cfg.baseUrl) {
        throw new TsumugiError(
          `LLM_${tier.toUpperCase()}_BASE_URL is required for provider 'openai-compat'`,
        );
      }
      return createOpenAiCompatClient({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      });
    }
  }
}

export function getLlm(tier: LlmTier): LlmClient {
  const cached = cache.get(tier);
  if (cached) return cached;

  const config = loadConfig();
  const tierConfig = tier === "low" ? config.llm.low : config.llm.mid;
  const client = buildClient(tier, tierConfig);
  cache.set(tier, client);
  return client;
}

export function resetLlmCache(): void {
  cache.clear();
}
