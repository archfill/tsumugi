import { SearchInput } from "@tsumugi/shared";
import type { SearchHit } from "@tsumugi/shared";
import { hybridSearch } from "../../../core/search/hybrid.js";

export const SEARCH_MEMORY_TOOL = {
  name: "search_memory",
  description:
    "tsumugi の記憶を hybrid 検索 (pg_bigm + BGE-M3 embedding) で取り出す。Layer 1 (observation) と Layer 2 (memory) 両方を横断。",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        minLength: 1,
        description: "検索クエリ (必須)",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 50,
        description: "返却件数上限 (default: 10)",
      },
      filter: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "discovery",
              "progress",
              "blocker",
              "decision",
              "reflection",
              "other",
            ],
            description: "観測種別フィルタ (observations のみ有効)",
          },
          source: {
            type: "string",
            enum: ["claude-code", "codex", "yui", "other"],
            description: "ソースフィルタ (observations のみ有効)",
          },
          session_id: {
            type: "string",
            description: "セッション ID フィルタ (observations のみ有効)",
          },
          project_tag: {
            type: "string",
            description: "プロジェクトタグフィルタ (observations のみ有効)",
          },
        },
        additionalProperties: false,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

export interface SearchMemoryResult {
  hits: SearchHit[];
}

export async function handleSearchMemory(
  rawInput: unknown,
): Promise<SearchMemoryResult> {
  const input = SearchInput.parse(rawInput);
  const hits = await hybridSearch(input);
  return { hits };
}
