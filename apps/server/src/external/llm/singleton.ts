import { createHash } from "node:crypto";
import {
  loadConfig,
  type LlmModelConfig,
  type LlmTierConfig,
} from "../../lib/config.js";
import { TsumugiError, ExternalError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { llmCallDurationSeconds, llmCallsTotal } from "../../lib/metrics.js";
import { createAnthropicClient } from "./anthropic.js";
import { createOpenAiCompatClient } from "./openai-compat.js";
import type { LlmClient, LlmRequest, LlmResponse, LlmTier } from "./types.js";

const cache = new Map<LlmTier, LlmClient>();
const providerQueues = new Map<
  string,
  { tail: Promise<void>; depth: number }
>();

function providerKey(cfg: LlmModelConfig): string {
  const endpoint =
    cfg.provider === "anthropic" ? "api.anthropic.com" : cfg.baseUrl ?? "";
  const credential = createHash("sha256")
    .update(cfg.apiKey)
    .digest("hex")
    .slice(0, 12);
  return `${cfg.provider}:${endpoint}:${credential}`;
}

async function withProviderAdmission<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  let queue = providerQueues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), depth: 0 };
    providerQueues.set(key, queue);
  }

  const waitFor = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue.depth++;
  await waitFor;
  try {
    return await run();
  } finally {
    queue.depth--;
    release();
    if (queue.depth === 0 && providerQueues.get(key) === queue) {
      providerQueues.delete(key);
    }
  }
}

function serializeProvider(inner: LlmClient, cfg: LlmModelConfig): LlmClient {
  const key = providerKey(cfg);
  return {
    complete: (req) => withProviderAdmission(key, () => inner.complete(req)),
    completeJson: <T>(req: LlmRequest) =>
      withProviderAdmission(key, () => inner.completeJson<T>(req)),
  };
}

function buildBasicClient(tier: LlmTier, cfg: LlmModelConfig): LlmClient {
  if (!cfg.apiKey) {
    throw new TsumugiError(`LLM_${tier.toUpperCase()}_API_KEY is not set`);
  }
  if (!cfg.model) {
    throw new TsumugiError(`LLM_${tier.toUpperCase()}_MODEL is not set`);
  }

  let raw: LlmClient;
  switch (cfg.provider) {
    case "anthropic":
      raw = createAnthropicClient({ apiKey: cfg.apiKey, model: cfg.model });
      break;
    case "openai-compat": {
      if (!cfg.baseUrl) {
        throw new TsumugiError(
          `LLM_${tier.toUpperCase()}_BASE_URL is required for provider 'openai-compat'`,
        );
      }
      raw = createOpenAiCompatClient({
        apiKey: cfg.apiKey,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
      });
      break;
    }
  }
  return serializeProvider(instrumentClient(raw, tier, cfg), cfg);
}

/**
 * Wrap a basic LLM client with Prometheus metrics.
 * Records duration histogram + total counter labelled by tier/provider/model/status.
 * Sits between primary call and fallback so each tier's primary and fallback
 * get separate metric series via their own labels.
 */
function instrumentClient(
  inner: LlmClient,
  tier: LlmTier,
  cfg: LlmModelConfig,
): LlmClient {
  const baseLabels = {
    tier,
    provider: cfg.provider,
    model: cfg.model,
  };

  async function timed<T>(fn: () => Promise<T>): Promise<T> {
    const started = process.hrtime.bigint();
    let status: "success" | "error" = "success";
    try {
      return await fn();
    } catch (err) {
      status = "error";
      throw err;
    } finally {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      llmCallDurationSeconds.observe(baseLabels, seconds);
      llmCallsTotal.inc({ ...baseLabels, status });
    }
  }

  return {
    complete: (req) => timed(() => inner.complete(req)),
    completeJson: <T>(req: LlmRequest) =>
      timed(() => inner.completeJson<T>(req)),
  };
}

/**
 * Wrap a primary client with an optional fallback (Layer 3).
 *
 * Behaviour:
 *   - call primary first (which internally already retries transient errors at Layer 1)
 *   - if primary still throws after its retry budget, try fallback once
 *   - fallback is skipped when undefined; the error from primary propagates as-is
 *   - the fallback itself also has retry (its own Layer 1)
 */
function withFallback(
  tier: LlmTier,
  primary: LlmClient,
  fallback?: LlmClient,
  fallbackCfg?: LlmModelConfig,
): LlmClient {
  if (!fallback || !fallbackCfg) return primary;

  async function tryFallback<T>(
    op: string,
    primaryErr: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    logger.warn(
      {
        tier,
        op,
        fallbackProvider: fallbackCfg!.provider,
        fallbackModel: fallbackCfg!.model,
        primaryErr:
          primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      },
      "primary LLM failed after retries, trying fallback",
    );
    try {
      return await run();
    } catch (fbErr) {
      // 両方失敗した場合は両方の情報を残して throw。
      throw new ExternalError(
        `LLM tier=${tier} primary and fallback both failed. primary: ${
          primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        } | fallback: ${
          fbErr instanceof Error ? fbErr.message : String(fbErr)
        }`,
      );
    }
  }

  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      try {
        return await primary.complete(req);
      } catch (err) {
        return await tryFallback("complete", err, () => fallback.complete(req));
      }
    },
    async completeJson<T>(req: LlmRequest): Promise<T> {
      try {
        return await primary.completeJson<T>(req);
      } catch (err) {
        return await tryFallback("completeJson", err, () =>
          fallback.completeJson<T>(req),
        );
      }
    },
  };
}

function buildTierClient(tier: LlmTier, tierCfg: LlmTierConfig): LlmClient {
  const primary = buildBasicClient(tier, tierCfg.primary);
  if (!tierCfg.fallback) return primary;
  const fallback = buildBasicClient(tier, tierCfg.fallback);
  return withFallback(tier, primary, fallback, tierCfg.fallback);
}

export function getLlm(tier: LlmTier): LlmClient {
  const cached = cache.get(tier);
  if (cached) return cached;

  const config = loadConfig();
  const tierCfg = tier === "low" ? config.llm.low : config.llm.mid;
  const client = buildTierClient(tier, tierCfg);
  cache.set(tier, client);
  return client;
}

export function resetLlmCache(): void {
  cache.clear();
  providerQueues.clear();
}
