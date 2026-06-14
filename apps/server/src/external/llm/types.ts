export type LlmTier = "low" | "mid";

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
