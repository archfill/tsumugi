import type { FixtureCase } from "../types.js";

export interface ContradictionInputDecision {
  isoDate: string;
  content: string;
}

export interface ContradictionInput {
  decisions: ContradictionInputDecision[];
}

export interface ExpectedPair {
  supersededIndex: number;
  newIndex: number;
}

export interface ContradictionExpected {
  pairs: ExpectedPair[];
}

export const fixtures: FixtureCase<
  ContradictionInput,
  ContradictionExpected
>[] = [
  // -------------------- Direct supersede --------------------
  {
    id: "contra-01-direct-en",
    description: "DB choice flipped",
    input: {
      decisions: [
        { isoDate: "2026-03-01", content: "Adopt MySQL as primary database." },
        {
          isoDate: "2026-04-15",
          content: "Switch primary database from MySQL to PostgreSQL 18.",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-02-direct-jp",
    description: "Auth method 切り替え",
    input: {
      decisions: [
        { isoDate: "2026-02-10", content: "認証は OAuth 2.0 を採用。" },
        { isoDate: "2026-05-01", content: "認証は SAML に切り替えた。" },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-03-retraction-jp",
    description: "完全撤回",
    input: {
      decisions: [
        {
          isoDate: "2026-01-15",
          content: "claude-mem を hot path の memory 層で採用。",
        },
        {
          isoDate: "2026-05-30",
          content: "claude-mem の利用を終了、yui 内製 memory に置換。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-04-version-upgrade-en",
    description: "Library version upgrade — supersedes prior pin",
    input: {
      decisions: [
        { isoDate: "2026-01-05", content: "Pin node-cron to 3.0." },
        {
          isoDate: "2026-06-10",
          content: "Upgrade node-cron to 4.2.1 to use the new schedule API.",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },

  // -------------------- No supersede --------------------
  {
    id: "contra-05-no-different-topics",
    description: "Two unrelated decisions",
    input: {
      decisions: [
        {
          isoDate: "2026-03-01",
          content: "Primary database is PostgreSQL 18.",
        },
        {
          isoDate: "2026-03-05",
          content: "Embedding model is BGE-M3 at 1024 dimensions.",
        },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-06-no-additive",
    description: "Additive information about the same topic, not a supersede",
    input: {
      decisions: [
        { isoDate: "2026-02-01", content: "Adopt Z.ai GLM Coding Plan." },
        {
          isoDate: "2026-02-10",
          content:
            "Use Z.ai GLM-4.5-air for LOW tier and GLM-4.6 for MID tier.",
        },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-07-no-related-but-distinct",
    description: "Related domain, distinct subjects (provider vs scheduler)",
    input: {
      decisions: [
        {
          isoDate: "2026-04-01",
          content: "Adopt Z.ai GLM Coding Plan for cold-path LLM calls.",
        },
        {
          isoDate: "2026-06-12",
          content: "Use node-cron 4.2.1 for dreaming scheduler.",
        },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-08-no-elaboration-jp",
    description: "詳細化は supersede ではない",
    input: {
      decisions: [
        {
          isoDate: "2026-03-01",
          content: "LLM resilience は 3 層構成にする。",
        },
        {
          isoDate: "2026-03-05",
          content:
            "Layer 1 は retry, Layer 2 は failure tracking, Layer 3 は provider fallback。",
        },
      ],
    },
    expected: { pairs: [] },
  },

  // -------------------- Multiple decisions, partial supersede --------------------
  {
    id: "contra-09-three-decisions-one-pair",
    description: "3 件のうち 1 ペアだけ supersede",
    input: {
      decisions: [
        {
          isoDate: "2026-01-01",
          content: "認証は OAuth 2.0 を採用。",
        },
        {
          isoDate: "2026-02-01",
          content: "DB は PostgreSQL 18 を採用。",
        },
        {
          isoDate: "2026-05-01",
          content: "認証は OAuth から SAML に切り替えた。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 2 }] },
  },
  {
    id: "contra-10-three-decisions-no-pair",
    description: "3 件すべて別トピック",
    input: {
      decisions: [
        { isoDate: "2026-01-01", content: "DB は PostgreSQL 18。" },
        { isoDate: "2026-02-01", content: "認証は OAuth 2.0。" },
        { isoDate: "2026-03-01", content: "Embedding は BGE-M3 (1024 dim)。" },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-11-chained-supersede",
    description: "連鎖 supersede — A → B → C 全部 DB",
    input: {
      decisions: [
        { isoDate: "2026-01-01", content: "DB は SQLite を採用。" },
        { isoDate: "2026-03-01", content: "DB を SQLite から MySQL に変更。" },
        {
          isoDate: "2026-05-01",
          content: "DB を MySQL から PostgreSQL 18 に変更。",
        },
      ],
    },
    expected: {
      // Both 0→1 and 1→2 are valid supersede pairs.
      pairs: [
        { supersededIndex: 0, newIndex: 1 },
        { supersededIndex: 1, newIndex: 2 },
      ],
    },
  },

  // -------------------- Subtle / boundary cases --------------------
  {
    id: "contra-12-subtle-threshold-change",
    description: "閾値の調整は supersede",
    input: {
      decisions: [
        {
          isoDate: "2026-02-01",
          content: "Promote 判定の importance 閾値は 5.0。",
        },
        {
          isoDate: "2026-05-01",
          content: "Promote 判定の importance 閾値を 6.5 に変更。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-13-no-policy-extension",
    description: "ポリシー追加は supersede ではない",
    input: {
      decisions: [
        {
          isoDate: "2026-03-01",
          content: "promote-observations は 30 分ごとに実行。",
        },
        {
          isoDate: "2026-04-01",
          content:
            "promote-observations の skip 判定で 'lifelog' タグを除外対象に追加。",
        },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-14-feature-removal",
    description: "機能削除は supersede",
    input: {
      decisions: [
        {
          isoDate: "2026-04-01",
          content: "admin に手動 compaction 機能を追加。",
        },
        {
          isoDate: "2026-06-01",
          content: "admin の手動 compaction 機能を全削除 (不要)。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-15-single-decision",
    description: "1 件のみ — pair 不可能",
    input: {
      decisions: [
        {
          isoDate: "2026-01-01",
          content: "DB は PostgreSQL 18 を採用。",
        },
      ],
    },
    expected: { pairs: [] },
  },
  // -------------------- Additional supersede patterns --------------------
  {
    id: "contra-16-config-update-jp",
    description: "設定値の更新",
    input: {
      decisions: [
        {
          isoDate: "2026-01-10",
          content: "Embedding dimension は 768 を採用。",
        },
        {
          isoDate: "2026-04-05",
          content: "Embedding dimension を 1024 に変更。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-17-no-additive-en",
    description: "Same topic but additive details — not a supersede",
    input: {
      decisions: [
        { isoDate: "2026-02-01", content: "Adopt Drizzle ORM for migrations." },
        {
          isoDate: "2026-02-15",
          content: "Drizzle migrate uses /drizzle as the output directory.",
        },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-18-tool-replacement-en",
    description: "Tool replacement is supersede",
    input: {
      decisions: [
        { isoDate: "2026-01-05", content: "Use jest as the test runner." },
        {
          isoDate: "2026-05-12",
          content: "Replace jest with vitest as the test runner.",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-19-policy-relax-jp",
    description: "ポリシー緩和は supersede",
    input: {
      decisions: [
        {
          isoDate: "2026-03-01",
          content: "Promote skip 判定は厳格化、ambiguous は default skip。",
        },
        {
          isoDate: "2026-06-01",
          content: "Promote skip 判定は ambiguous を keep 寄りに緩和。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-20-four-decisions-double-supersede",
    description: "4 件中 2 ペア独立 supersede",
    input: {
      decisions: [
        { isoDate: "2026-01-01", content: "DB は SQLite を採用。" },
        { isoDate: "2026-02-01", content: "認証は OAuth 2.0 を採用。" },
        { isoDate: "2026-04-01", content: "DB を PostgreSQL 18 に切り替え。" },
        { isoDate: "2026-05-01", content: "認証は SAML に切り替え。" },
      ],
    },
    expected: {
      pairs: [
        { supersededIndex: 0, newIndex: 2 },
        { supersededIndex: 1, newIndex: 3 },
      ],
    },
  },
  {
    id: "contra-21-no-rephrase-en",
    description: "Rephrasing the same decision is not supersede",
    input: {
      decisions: [
        {
          isoDate: "2026-02-01",
          content: "Primary database is PostgreSQL 18.",
        },
        {
          isoDate: "2026-02-10",
          content: "Use PostgreSQL 18 as the primary database.",
        },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-22-architectural-pivot-jp",
    description: "アーキテクチャ転換は supersede",
    input: {
      decisions: [
        {
          isoDate: "2026-01-15",
          content: "MCP transport は SSE 単独で動かす。",
        },
        {
          isoDate: "2026-04-20",
          content: "MCP transport を WebStandardStreamableHTTP に統一。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-23-no-different-aspects-jp",
    description: "同じ領域でも別観点は両方残す",
    input: {
      decisions: [
        {
          isoDate: "2026-02-01",
          content: "Hybrid search は pg_bigm + pgvector を採用。",
        },
        {
          isoDate: "2026-04-01",
          content: "Hybrid search の fusion は RRF (k=60) を採用。",
        },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-24-decision-cancellation-jp",
    description: "決定の取り消しは supersede 扱い",
    input: {
      decisions: [
        {
          isoDate: "2026-02-01",
          content: "admin 手動 compaction 機能を提供する。",
        },
        {
          isoDate: "2026-06-12",
          content: "admin の手動 compaction 機能を全削除 (不要)。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-25-five-decisions-one-pair",
    description: "5 件中 1 ペアだけ supersede",
    input: {
      decisions: [
        { isoDate: "2026-01-01", content: "DB は PostgreSQL 18。" },
        { isoDate: "2026-01-15", content: "Embedding は BGE-M3。" },
        { isoDate: "2026-02-01", content: "Auth は OAuth 2.0。" },
        { isoDate: "2026-03-01", content: "logger は console.log を使う。" },
        {
          isoDate: "2026-05-01",
          content: "logger を pino に切り替え、prod JSON / dev pretty。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 3, newIndex: 4 }] },
  },
  {
    id: "contra-26-pricing-decision-en",
    description: "Pricing model swap is supersede",
    input: {
      decisions: [
        {
          isoDate: "2026-01-10",
          content: "LLM cost: pay per token via Anthropic API.",
        },
        {
          isoDate: "2026-04-20",
          content:
            "LLM cost: fixed monthly via Z.ai GLM Coding Plan subscription.",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-27-no-scope-narrowing-en",
    description:
      "Narrowing the scope of an existing decision (additive) is not supersede",
    input: {
      decisions: [
        {
          isoDate: "2026-02-01",
          content: "Pino is the logger for the server.",
        },
        {
          isoDate: "2026-03-01",
          content: "Pino is configured with level=info in production.",
        },
      ],
    },
    expected: { pairs: [] },
  },
  {
    id: "contra-28-reversed-decision-jp",
    description: "明示的に逆転した決定",
    input: {
      decisions: [
        {
          isoDate: "2026-02-15",
          content: "BGE-M3 を遠隔 API (Anthropic) で利用する。",
        },
        {
          isoDate: "2026-04-15",
          content: "BGE-M3 をローカル onnxruntime-node で動かす方針に変更。",
        },
      ],
    },
    expected: { pairs: [{ supersededIndex: 0, newIndex: 1 }] },
  },
  {
    id: "contra-29-superseded-by-older-no",
    description: "古い決定で新しい決定が置き換わることは想定しない (順序保持)",
    input: {
      decisions: [
        { isoDate: "2026-05-01", content: "DB は PostgreSQL 18 を採用。" },
        { isoDate: "2026-02-01", content: "DB は MySQL を採用。" },
      ],
    },
    expected: { pairs: [{ supersededIndex: 1, newIndex: 0 }] },
  },
  {
    id: "contra-30-detector-edge-self-content-jp",
    description: "完全同内容は supersede にしない",
    input: {
      decisions: [
        { isoDate: "2026-02-01", content: "Auth は OAuth 2.0。" },
        { isoDate: "2026-04-01", content: "Auth は OAuth 2.0。" },
      ],
    },
    expected: { pairs: [] },
  },
];
