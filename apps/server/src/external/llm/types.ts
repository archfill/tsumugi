export type LlmTier = "low" | "mid";

/**
 * LLM provider 種別。tsumugi は特定の provider に依存しない設計で、
 * OpenAI 互換 API を持つほぼ全ての provider (Z.ai / DeepSeek / OpenRouter /
 * Ollama / OpenAI 本家) を openai-compat 1 つでカバーできる。
 */
export type LlmProvider = "anthropic" | "openai-compat";

export type LlmOpenAiDialect = "generic" | "zai";
export type LlmThinkingMode = "enabled" | "disabled";
export type LlmReasoningEffort = "high" | "max";

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number; // default 2048
  temperature?: number; // default 0.0
  jsonResponse?: boolean; // default false; true will append JSON enforcement to system prompt
}

export interface LlmResponse {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
  completeJson<T>(req: LlmRequest): Promise<T>;
}
