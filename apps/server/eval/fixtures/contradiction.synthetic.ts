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
];
