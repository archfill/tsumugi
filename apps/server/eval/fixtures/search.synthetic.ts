/**
 * Search bench fixture: seed memories + queries with expected memory hits.
 *
 * IDs are prefixed `mem_evalseed_` so the bench can wipe them between runs
 * without touching real data.
 */

import type { FixtureCase } from "../types.js";

export interface SearchInput {
  query: string;
  limit: number;
}

export interface SearchExpected {
  /**
   * Memory IDs that should appear in the top-k result.
   * Recall@k counts a hit if ANY of these IDs appears in the top-k.
   */
  expectedIds: string[];
  /** When true, expect zero (or very-low-score) hits — irrelevant query. */
  expectNoHits?: boolean;
}

export interface SeedMemory {
  id: string;
  narrative: string;
  importance?: number;
  kind?: string;
}

export const seedMemories: SeedMemory[] = [
  {
    id: "mem_evalseed_01",
    narrative:
      "Z.ai GLM Coding Plan を cold path の LLM provider として採用。subscription で API 料金が定額化される。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_02",
    narrative:
      "Embedding model は BGE-M3 (1024 dim)、@xenova/transformers 経由で onnxruntime-node ローカル実行。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_03",
    narrative:
      "Hybrid search は pg_bigm の bigram キーワード検索と pgvector の cosine 類似度を RRF (Reciprocal Rank Fusion) で統合する。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_04",
    narrative:
      "Primary database は PostgreSQL 18 with pg_bigm + pgvector extensions、port 5432 (prod) / 5433 (local docker)。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_05",
    narrative:
      "node-cron 4.2.1 で dreaming jobs を定期実行する scheduler を実装。http モードでのみ起動、stdio は短命プロセスなので非対応。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_06",
    narrative:
      "Drizzle ORM 0.45 + drizzle-kit 0.31 でマイグレーション管理。journal の `when` 値が単調増加でないと migrate が静かに失敗する罠あり。",
    kind: "insight",
  },
  {
    id: "mem_evalseed_07",
    narrative:
      "LLM resilience は 3 層構成: Layer 1 は exponential backoff retry, Layer 2 は per-memory failure tracking + quarantine, Layer 3 は provider fallback。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_08",
    narrative:
      "Forgejo blob PUT が 500 を返す事象の根本原因は package-upload ディレクトリ欠落。mkdir + restart で復旧。",
    kind: "insight",
  },
  {
    id: "mem_evalseed_09",
    narrative:
      "AUDN judge (ADD/UPDATE/DELETE/NOOP) は MID tier (Z.ai GLM-4.6) で動作、temperature=0.0 で JSON 応答を強制。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_10",
    narrative:
      "pino 10.3.1 を構造化 logger として採用。dev は pino-pretty 13.1.3 で色付き、prod は JSON line で stdout。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_11",
    narrative:
      "memory layer は narrative + importance + kind + embedding を保持。archived_at NULL = active、非 NULL = soft delete。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_12",
    narrative:
      "dreaming pipeline は promote-observations / synthesize / time-update / decision-contradiction / reflection の 5 ジョブで構成。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_13",
    narrative:
      "MCP transport は WebStandardStreamableHTTPServerTransport を使用。session id は randomUUID 生成、map で transport を保持。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_14",
    narrative:
      "コミット規則は Conventional Commits。commit-msg hook で commitlint が強制、husky が `.husky/_/` を初期化。",
    kind: "decision",
  },
  {
    id: "mem_evalseed_15",
    narrative:
      "tsumugi はシングルユーザー前提。multi-user 認可は yui 側のスコープ、tsumugi では省略する設計判断。",
    kind: "decision",
  },
];

export const fixtures: FixtureCase<SearchInput, SearchExpected>[] = [
  {
    id: "search-q01-llm-provider",
    description: "Direct keyword 'Z.ai'",
    input: { query: "Z.ai", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_01", "mem_evalseed_09"] },
  },
  {
    id: "search-q02-embedding-jp",
    description: "Japanese keyword 'embedding モデル'",
    input: { query: "embedding モデル", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_02"] },
  },
  {
    id: "search-q03-bge-m3",
    description: "Model name 'BGE-M3'",
    input: { query: "BGE-M3", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_02"] },
  },
  {
    id: "search-q04-hybrid-search-jp",
    description: "Hybrid search in Japanese",
    input: { query: "ハイブリッド検索", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_03"] },
  },
  {
    id: "search-q05-pg-bigm",
    description: "Extension name 'pg_bigm'",
    input: { query: "pg_bigm", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_03", "mem_evalseed_04"] },
  },
  {
    id: "search-q06-scheduler-jp",
    description: "Concept 'scheduler 実装'",
    input: { query: "scheduler 実装", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_05"] },
  },
  {
    id: "search-q07-cron",
    description: "Library name 'cron'",
    input: { query: "cron", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_05"] },
  },
  {
    id: "search-q08-drizzle",
    description: "Library 'drizzle'",
    input: { query: "drizzle", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_06"] },
  },
  {
    id: "search-q09-llm-resilience-en",
    description: "'LLM resilience' multi-token",
    input: { query: "LLM resilience", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_07"] },
  },
  {
    id: "search-q10-retry-concept",
    description: "Concept 'retry'",
    input: { query: "retry", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_07"] },
  },
  {
    id: "search-q11-fallback-provider",
    description: "'fallback provider'",
    input: { query: "fallback provider", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_07"] },
  },
  {
    id: "search-q12-forgejo-500",
    description: "Incident 'Forgejo blob 500'",
    input: { query: "Forgejo blob 500", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_08"] },
  },
  {
    id: "search-q13-package-upload",
    description: "Direct keyword 'package-upload'",
    input: { query: "package-upload", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_08"] },
  },
  {
    id: "search-q14-audn",
    description: "'AUDN'",
    input: { query: "AUDN", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_09"] },
  },
  {
    id: "search-q15-pino",
    description: "Library 'pino'",
    input: { query: "pino", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_10"] },
  },
  {
    id: "search-q16-logger-concept",
    description: "Concept 'logger 構造化'",
    input: { query: "構造化 logger", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_10"] },
  },
  {
    id: "search-q17-soft-delete",
    description: "Concept 'soft delete'",
    input: { query: "soft delete", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_11"] },
  },
  {
    id: "search-q18-dreaming",
    description: "'dreaming pipeline'",
    input: { query: "dreaming pipeline", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_12"] },
  },
  {
    id: "search-q19-mcp-transport",
    description: "'MCP transport'",
    input: { query: "MCP transport", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_13"] },
  },
  {
    id: "search-q20-session-id",
    description: "'session id'",
    input: { query: "session id", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_13"] },
  },
  {
    id: "search-q21-commitlint",
    description: "'commitlint'",
    input: { query: "commitlint", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_14"] },
  },
  {
    id: "search-q22-multi-user",
    description: "'multi-user 認可'",
    input: { query: "multi-user 認可", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_15"] },
  },
  {
    id: "search-q23-paraphrase",
    description: "Paraphrase 'GLM Coding Plan の料金'",
    input: { query: "GLM Coding Plan の料金", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_01"] },
  },
  {
    id: "search-q24-en-arch",
    description: "English query 'hybrid search architecture'",
    input: { query: "hybrid search architecture", limit: 5 },
    expected: { expectedIds: ["mem_evalseed_03"] },
  },
  {
    id: "search-q25-irrelevant",
    description: "Irrelevant query — expect no relevant hits",
    input: { query: "天気予報 明日", limit: 5 },
    expected: { expectedIds: [], expectNoHits: true },
  },
];
