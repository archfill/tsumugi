import type { FixtureCase } from "../types.js";

export interface AudnInput {
  newFact: string;
  existingMemoryNarratives: string[];
}

export interface AudnExpected {
  decision: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  /**
   * Expected target memory index for UPDATE/DELETE. `null` for ADD/NOOP.
   * Use `"any"` when the LLM may legitimately pick any of multiple targets.
   */
  targetIndex: number | null | "any";
}

export const fixtures: FixtureCase<AudnInput, AudnExpected>[] = [
  // -------------------- ADD: subject independent --------------------
  {
    id: "audn-add-01-en-independent-subject",
    description: "Embedding dim adoption alongside unrelated auth memory",
    input: {
      newFact: "Embedding dimension is fixed at 1024.",
      existingMemoryNarratives: ["Authentication uses OAuth 2.0."],
    },
    expected: { decision: "ADD", targetIndex: null },
  },
  {
    id: "audn-add-02-en-multiple-unrelated",
    description: "node-cron addition with several unrelated existing memories",
    input: {
      newFact:
        "Adopted node-cron 4.2.1 to schedule dreaming jobs in the http server.",
      existingMemoryNarratives: [
        "Primary database is PostgreSQL 18.",
        "Authentication uses OAuth 2.0.",
        "Embedding model is BGE-M3 at 1024 dimensions.",
      ],
    },
    expected: { decision: "ADD", targetIndex: null },
  },
  {
    id: "audn-add-03-jp-independent",
    description: "Deploy infrastructure addition vs DB choice",
    input: {
      newFact: "デプロイ環境は Proxmox VE 上の Docker VM。",
      existingMemoryNarratives: ["pgvector を hybrid 検索に採用。"],
    },
    expected: { decision: "ADD", targetIndex: null },
  },
  {
    id: "audn-add-04-en-empty-existing",
    description: "Fast path: no existing memories → always ADD",
    input: {
      newFact: "Adopted Z.ai GLM Coding Plan for cold-path LLM calls.",
      existingMemoryNarratives: [],
    },
    expected: { decision: "ADD", targetIndex: null },
  },
  {
    id: "audn-add-05-jp-same-domain-different-aspect",
    description:
      "Same domain (LLM stack) but different aspect (provider vs tier policy)",
    input: {
      newFact: "LOW tier では glm-4.5-air、MID tier では glm-4.6 を使う。",
      existingMemoryNarratives: ["Z.ai を OpenAI 互換 provider として採用。"],
    },
    expected: { decision: "ADD", targetIndex: null },
  },
  {
    id: "audn-add-06-en-novel-tooling",
    description: "New tooling decision unrelated to existing memories",
    input: {
      newFact:
        "Added pino 10.3.1 as the structured logger for all server modules.",
      existingMemoryNarratives: [
        "Hybrid search combines pg_bigm and pgvector with RRF fusion.",
        "Test database runs on port 5433 locally.",
      ],
    },
    expected: { decision: "ADD", targetIndex: null },
  },

  // -------------------- UPDATE: subject matches, content changed --------------------
  {
    id: "audn-update-01-en-dim-change",
    description: "Embedding dimension changed",
    input: {
      newFact: "Embedding dimension changed to 768.",
      existingMemoryNarratives: ["Embedding dimension is fixed at 1024."],
    },
    expected: { decision: "UPDATE", targetIndex: 0 },
  },
  {
    id: "audn-update-02-en-auth-method-switch",
    description: "Auth method switched, multiple memories present",
    input: {
      newFact: "Switched authentication from OAuth 2.0 to SAML.",
      existingMemoryNarratives: [
        "Authentication uses OAuth 2.0.",
        "Primary database is PostgreSQL 18.",
      ],
    },
    expected: { decision: "UPDATE", targetIndex: 0 },
  },
  {
    id: "audn-update-03-jp-db-switch",
    description: "DB switched from MySQL to PostgreSQL",
    input: {
      newFact: "DB を MySQL から PostgreSQL 18 に切り替えた。",
      existingMemoryNarratives: ["DB は MySQL を採用。"],
    },
    expected: { decision: "UPDATE", targetIndex: 0 },
  },
  {
    id: "audn-update-04-jp-llm-model-upgrade",
    description: "LLM model upgraded within same provider",
    input: {
      newFact: "MID tier の LLM を Z.ai GLM-4.6 にアップグレード。",
      existingMemoryNarratives: ["MID tier では Z.ai GLM-4.5-air を使用。"],
    },
    expected: { decision: "UPDATE", targetIndex: 0 },
  },
  {
    id: "audn-update-05-en-pick-correct-among-many",
    description: "UPDATE target must be picked from multiple memories",
    input: {
      newFact: "Upgraded node-cron to 4.2.1 (was 3.x).",
      existingMemoryNarratives: [
        "Embedding model is BGE-M3.",
        "Scheduler uses node-cron 3.0.",
        "Database is PostgreSQL 18.",
      ],
    },
    expected: { decision: "UPDATE", targetIndex: 1 },
  },
  {
    id: "audn-update-06-jp-policy-refinement",
    description: "Policy refinement: importance threshold changed",
    input: {
      newFact: "Promote 判定の importance 閾値を 5.0 → 6.5 に引き上げ。",
      existingMemoryNarratives: ["Promote 判定の importance 閾値は 5.0。"],
    },
    expected: { decision: "UPDATE", targetIndex: 0 },
  },

  // -------------------- DELETE: retraction / negation --------------------
  {
    id: "audn-delete-01-en-withdrawal",
    description: "MySQL adoption withdrawn",
    input: {
      newFact: "Withdrew MySQL adoption — no longer in scope.",
      existingMemoryNarratives: ["Primary database is MySQL."],
    },
    expected: { decision: "DELETE", targetIndex: 0 },
  },
  {
    id: "audn-delete-02-en-reversal",
    description: "OAuth decision reversed",
    input: {
      newFact: "Decision to adopt OAuth 2.0 has been reversed.",
      existingMemoryNarratives: ["Authentication uses OAuth 2.0."],
    },
    expected: { decision: "DELETE", targetIndex: 0 },
  },
  {
    id: "audn-delete-03-jp-discontinuation",
    description: "claude-mem 利用終了 (本番事例ベース)",
    input: {
      newFact: "claude-mem の利用を終了し、yui 内製 memory に置き換えた。",
      existingMemoryNarratives: ["claude-mem を hot path の memory 層で使用。"],
    },
    expected: { decision: "DELETE", targetIndex: 0 },
  },
  {
    id: "audn-delete-04-en-feature-dropped",
    description: "Feature dropped",
    input: {
      newFact: "Dropped pgvector — switched to a pure pg_bigm pipeline.",
      existingMemoryNarratives: [
        "Hybrid search combines pg_bigm and pgvector via RRF.",
      ],
    },
    expected: { decision: "DELETE", targetIndex: 0 },
  },
  {
    id: "audn-delete-05-jp-among-many",
    description: "Multiple memories present, DELETE the matching one",
    input: {
      newFact: "Z.ai GLM Coding Plan の契約を解約した。",
      existingMemoryNarratives: [
        "Embedding model は BGE-M3。",
        "Z.ai GLM Coding Plan を cold path で採用。",
        "DB は PostgreSQL 18。",
      ],
    },
    expected: { decision: "DELETE", targetIndex: 1 },
  },

  // -------------------- NOOP: equivalent --------------------
  {
    id: "audn-noop-01-en-paraphrase",
    description: "Paraphrase of existing memory",
    input: {
      newFact: "OAuth is used as the authentication method.",
      existingMemoryNarratives: ["Authentication uses OAuth 2.0."],
    },
    expected: { decision: "NOOP", targetIndex: null },
  },
  {
    id: "audn-noop-02-en-equivalent-phrasing",
    description: "Different phrasing, same content",
    input: {
      newFact: "Database = PostgreSQL.",
      existingMemoryNarratives: ["Primary database is PostgreSQL."],
    },
    expected: { decision: "NOOP", targetIndex: null },
  },
  {
    id: "audn-noop-03-jp-paraphrase",
    description: "Japanese paraphrase",
    input: {
      newFact: "BGE-M3 を embedding に採用。",
      existingMemoryNarratives: ["Embedding model は BGE-M3 (1024 dim)。"],
    },
    expected: { decision: "NOOP", targetIndex: null },
  },
  {
    id: "audn-noop-04-jp-redundant",
    description: "Redundant fact already implied",
    input: {
      newFact: "Z.ai GLM Coding Plan で API 料金は定額。",
      existingMemoryNarratives: [
        "Z.ai GLM Coding Plan を採用 (subscription で API 料金は定額化)。",
      ],
    },
    expected: { decision: "NOOP", targetIndex: null },
  },

  // -------------------- Ambiguous: excluded from per-class F1 --------------------
  {
    id: "audn-amb-01-jp-vague-provider",
    description: "曖昧: '新しい LLM provider' が Z.ai 後継か別領域か判断困難",
    input: {
      newFact: "新しい LLM provider を試している。",
      existingMemoryNarratives: ["Z.ai GLM Coding Plan を cold path で採用。"],
    },
    expected: { decision: "ADD", targetIndex: null },
    tags: ["ambiguous"],
  },
  {
    id: "audn-amb-02-en-temporal-evolution",
    description:
      "Temporal evolution: model swap that mentions the old model explicitly",
    input: {
      newFact:
        "Adopted BGE-M3 as embedding model (previously all-MiniLM-L6-v2).",
      existingMemoryNarratives: ["Embedding model is all-MiniLM-L6-v2."],
    },
    expected: { decision: "UPDATE", targetIndex: 0 },
    tags: ["ambiguous"],
  },
];
