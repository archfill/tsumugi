import type { FixtureCase } from "../types.js";

export type ObservationSource = "claude-code" | "codex" | "yui" | "other";
export type ObservationType =
  | "discovery"
  | "progress"
  | "blocker"
  | "decision"
  | "reflection"
  | "other";

export interface PromoteInput {
  source: ObservationSource;
  type: ObservationType;
  content: string;
}

export interface PromoteExpected {
  skip: boolean;
}

export const fixtures: FixtureCase<PromoteInput, PromoteExpected>[] = [
  // -------------------- SKIP: trivial / personal / ambient --------------------
  {
    id: "promote-skip-01-lunch",
    description: "Personal food log",
    input: {
      source: "other",
      type: "other",
      content: "今日はカレーライスにした。",
    },
    expected: { skip: true },
  },
  {
    id: "promote-skip-02-greeting-en",
    description: "Greeting",
    input: {
      source: "other",
      type: "other",
      content: "Hi, thanks for the help!",
    },
    expected: { skip: true },
  },
  {
    id: "promote-skip-03-ack-jp",
    description: "Acknowledgement",
    input: { source: "other", type: "other", content: "なるほど。" },
    expected: { skip: true },
  },
  {
    id: "promote-skip-04-weather",
    description: "Ambient info, not work-relevant",
    input: { source: "other", type: "other", content: "明日は雨らしい。" },
    expected: { skip: true },
  },
  {
    id: "promote-skip-05-test-string",
    description: "Test string / typo",
    input: { source: "other", type: "other", content: "asdf test123" },
    expected: { skip: true },
  },
  {
    id: "promote-skip-06-emotion-only",
    description: "Emotion only",
    input: { source: "other", type: "other", content: "つかれた。" },
    expected: { skip: true },
  },
  {
    id: "promote-skip-07-lifelog",
    description: "Lifelog / personal taste",
    input: {
      source: "other",
      type: "other",
      content: "このコーヒーおいしい。",
    },
    expected: { skip: true },
  },
  {
    id: "promote-skip-08-thanks-en",
    description: "Thanks only",
    input: { source: "other", type: "other", content: "Got it, thanks!" },
    expected: { skip: true },
  },
  {
    id: "promote-skip-09-fragmentary",
    description: "Fragment / no content",
    input: { source: "other", type: "other", content: "うーん。" },
    expected: { skip: true },
  },
  {
    id: "promote-skip-10-meta-action",
    description: "Meta workflow action (no semantic content)",
    input: { source: "other", type: "other", content: "ファイルを開いた。" },
    expected: { skip: true },
  },

  // -------------------- KEEP: design / decision / bug / investigation --------------------
  {
    id: "promote-keep-01-llm-decision",
    description: "Library/provider adoption decision",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "Adopted Z.ai GLM Coding Plan for cold-path LLM calls — fixed-cost subscription resolves API billing.",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-02-bugfix-rootcause",
    description: "Bug root-cause finding",
    input: {
      source: "claude-code",
      type: "discovery",
      content:
        "tsx は .env を自動 load しない。bench スクリプトでは `--env-file=../../.env` を明示指定する必要がある。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-03-api-refactor",
    description: "API/refactor decision",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "audnJudge を judgeOnly 経由に書き換え、bench と本番が同じ LLM call path を通るようにした。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-04-library-version",
    description: "Library version pin",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "node-cron 4.2.1 を採用 (3.x からの upgrade)。新 cron.schedule API を利用。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-05-investigation",
    description: "Investigation finding",
    input: {
      source: "claude-code",
      type: "discovery",
      content:
        "drizzle migrate が静かに失敗していた原因は journal `when` 値が単調増加でなかったため。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-06-blocker",
    description: "Blocker / incident",
    input: {
      source: "yui",
      type: "blocker",
      content:
        "Forgejo blob PUT が 500 を返す。package-upload ディレクトリ欠落が疑い、mkdir + restart で復旧。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-07-user-preference",
    description: "Durable user preference / process rule",
    input: {
      source: "other",
      type: "decision",
      content:
        "コミットまでは行うが push / PR はしない方針。ローカル作業で完結させる。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-08-architecture",
    description: "Architecture decision",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "LLM resilience を 3 層構成 (Layer 1: retry, Layer 2: failure tracking, Layer 3: provider fallback) で実装。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-09-config",
    description: "Configuration / convention",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "fixture-private/ は .gitignore で除外。yui 由来データはローカル評価のみ。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-10-test-result-with-signal",
    description: "Test result that contains a finding (not just 'passed')",
    input: {
      source: "claude-code",
      type: "progress",
      content:
        "AUDN bench で 21 件中 19 件 pass (90%)。DELETE→UPDATE の誤判定が 2 件、prompt の 'subject continuity' 解釈差。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-11-infrastructure",
    description: "Infrastructure decision",
    input: {
      source: "yui",
      type: "decision",
      content: "pve-docker は yui 専用ではなく多サービス同居の共有ホスト。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-12-reflection",
    description: "Reflection / pattern recognition",
    input: {
      source: "claude-code",
      type: "reflection",
      content:
        "tool call parse 失敗の真因は Opus 4.8 の tool_use バグ。MCP 最小化は無効だった (4.7 で症状消失で実証)。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-13-process-rule",
    description: "Operational process rule",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "破壊的操作 (git push --force, rm -rf, drop table) は確認を取る。読取・テスト・ローカル編集は確認不要。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-14-design-tradeoff",
    description: "Design tradeoff",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "fixture を YAML ではなく typed .ts で書く方針。型安全と依存最小を優先、人間可読性は犠牲。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-15-en-discovery",
    description: "English discovery from CLI tooling",
    input: {
      source: "codex",
      type: "discovery",
      content:
        "pg_bigm trigram index was 4x faster than LIKE on the search_text column for 100k+ rows.",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-16-en-decision",
    description: "English library adoption",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "Adopted pino 10.3.1 as structured logger; dev uses pino-pretty, prod emits JSON.",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-17-claude-code-decision",
    description: "Decision typed observation from claude-code source",
    input: {
      source: "claude-code",
      type: "decision",
      content:
        "fixtures-private/ は .gitignore に追加して yui 内部データはコミット禁止とする。",
    },
    expected: { skip: false },
  },
  {
    id: "promote-keep-18-user-role",
    description: "User role declaration",
    input: {
      source: "other",
      type: "other",
      content:
        "私は archfill。AI agent オーケストレーションプラットフォーム yui を開発している。",
    },
    expected: { skip: false },
  },

  // -------------------- Ambiguous --------------------
  {
    id: "promote-amb-01-test-passed",
    description: "Just 'tests passed' — informational but transient",
    input: {
      source: "claude-code",
      type: "progress",
      content: "テスト通った。",
    },
    expected: { skip: true },
    tags: ["ambiguous"],
  },
  {
    id: "promote-amb-02-impression",
    description: "Impression on a tool with no concrete commitment",
    input: {
      source: "other",
      type: "other",
      content: "drizzle-orm は便利。",
    },
    expected: { skip: true },
    tags: ["ambiguous"],
  },
];
