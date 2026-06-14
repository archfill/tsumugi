import type { FixtureCase } from "../types.js";

export interface TimeUpdateInput {
  narrative: string;
  createdAtIso: string;
  nowIso: string;
}

export interface TimeUpdateExpected {
  narrative: string;
  minCosine?: number;
}

export const fixtures: FixtureCase<TimeUpdateInput, TimeUpdateExpected>[] = [
  {
    id: "time-update-01-yesterday-release-jp",
    description: "昨日 release した記憶を 1 か月後視点にする",
    input: {
      narrative: "昨日、v0.4.0 をリリースした。",
      createdAtIso: "2026-05-15T09:00:00.000Z",
      nowIso: "2026-06-15T09:00:00.000Z",
    },
    expected: {
      narrative: "2026-05-14 頃に v0.4.0 をリリースした過去の記録。",
    },
  },
  {
    id: "time-update-02-three-days-ago-jp",
    description: "3 日前の障害対応を現在視点に更新",
    input: {
      narrative: "3 日前に embeddings の timeout を修正中。",
      createdAtIso: "2026-04-01T00:00:00.000Z",
      nowIso: "2026-05-01T00:00:00.000Z",
    },
    expected: {
      narrative: "2026-03-29 頃、embeddings の timeout 修正に取り組んでいた。",
    },
  },
  {
    id: "time-update-03-last-week-en",
    description: "last week wording ages into past framing",
    input: {
      narrative: "Last week we migrated the scheduler to node-cron 4.2.1.",
      createdAtIso: "2026-02-14T00:00:00.000Z",
      nowIso: "2026-04-14T00:00:00.000Z",
    },
    expected: {
      narrative:
        "Around early February 2026, the scheduler was migrated to node-cron 4.2.1.",
    },
  },
  {
    id: "time-update-04-absolute-date-unchanged",
    description: "絶対日付は保持する",
    input: {
      narrative: "2026-01-15 に PostgreSQL 18 を採用すると決定した。",
      createdAtIso: "2026-01-15T00:00:00.000Z",
      nowIso: "2026-06-15T00:00:00.000Z",
    },
    expected: {
      narrative: "2026-01-15 に PostgreSQL 18 を採用すると決定した過去の記録。",
    },
  },
  {
    id: "time-update-05-current-implementation-jp",
    description: "現在実装中の表現を過去形にする",
    input: {
      narrative: "現在、AUDN bench の fixture を実装中。",
      createdAtIso: "2026-03-10T00:00:00.000Z",
      nowIso: "2026-04-20T00:00:00.000Z",
    },
    expected: {
      narrative: "2026-03-10 頃、AUDN bench の fixture を実装していた。",
    },
  },
  {
    id: "time-update-06-stable-fact-jp",
    description: "永続的な技術選定は大きく変えない",
    input: {
      narrative: "DB は PostgreSQL 18、ORM は Drizzle を使う。",
      createdAtIso: "2026-01-20T00:00:00.000Z",
      nowIso: "2026-06-20T00:00:00.000Z",
    },
    expected: {
      narrative: "DB は PostgreSQL 18、ORM は Drizzle を使うという技術選定。",
    },
  },
  {
    id: "time-update-07-stable-fact-en",
    description: "Stable architectural fact remains stable",
    input: {
      narrative: "Hybrid search combines pg_bigm and pgvector with RRF.",
      createdAtIso: "2026-01-01T00:00:00.000Z",
      nowIso: "2026-07-01T00:00:00.000Z",
    },
    expected: {
      narrative:
        "Hybrid search combines pg_bigm and pgvector with RRF; this is an architectural fact.",
    },
  },
  {
    id: "time-update-08-stale-provider-jp",
    description: "使っている表現を当時使っていたにする",
    input: {
      narrative: "LOW tier では glm-4.5-air を使っている。",
      createdAtIso: "2026-02-01T00:00:00.000Z",
      nowIso: "2026-08-01T00:00:00.000Z",
    },
    expected: {
      narrative: "2026-02-01 当時、LOW tier では glm-4.5-air を使っていた。",
    },
  },
  {
    id: "time-update-09-completed-task-en",
    description: "Ongoing task should become past work",
    input: {
      narrative: "We are tuning provider fallback behavior for MID tier.",
      createdAtIso: "2026-03-01T00:00:00.000Z",
      nowIso: "2026-05-15T00:00:00.000Z",
    },
    expected: {
      narrative:
        "Around March 2026, provider fallback behavior for the MID tier was being tuned.",
    },
  },
  {
    id: "time-update-10-recent-no-major-change",
    description: "2 週間未満の記憶は意味を大きく変えない",
    input: {
      narrative: "昨日、search bench の seed cleanup を確認した。",
      createdAtIso: "2026-06-10T00:00:00.000Z",
      nowIso: "2026-06-12T00:00:00.000Z",
    },
    expected: {
      narrative: "2026-06-09 頃、search bench の seed cleanup を確認した。",
    },
  },
  // -------------------- Additional coverage --------------------
  {
    id: "time-update-11-weeks-ago-jp",
    description: "数週間前の決定を絶対日付化",
    input: {
      narrative: "2 週間前に LLM の MID tier を Z.ai GLM-4.6 に切り替えた。",
      createdAtIso: "2026-05-25T00:00:00.000Z",
      nowIso: "2026-06-15T00:00:00.000Z",
    },
    expected: {
      narrative:
        "2026-05-11 頃、LLM の MID tier を Z.ai GLM-4.6 に切り替えた過去の決定。",
    },
  },
  {
    id: "time-update-12-months-ago-en",
    description: "two months ago → absolute month",
    input: {
      narrative: "Two months ago we adopted pg_bigm + pgvector hybrid search.",
      createdAtIso: "2026-04-01T00:00:00.000Z",
      nowIso: "2026-04-01T00:00:00.000Z",
    },
    expected: {
      narrative:
        "Around February 2026, pg_bigm + pgvector hybrid search was adopted.",
    },
  },
  {
    id: "time-update-13-year-old-decision-jp",
    description: "1 年前の決定は遠い過去として絶対化",
    input: {
      narrative: "去年、claude-mem の hot-path 利用を止めた。",
      createdAtIso: "2025-06-15T00:00:00.000Z",
      nowIso: "2026-06-15T00:00:00.000Z",
    },
    expected: {
      narrative: "2025-06 頃、claude-mem の hot-path 利用を止めた。",
    },
  },
  {
    id: "time-update-14-this-morning-jp",
    description: "今朝の作業は当日付け",
    input: {
      narrative: "今朝、AUDN bench の DELETE 件数を 100 まで底上げした。",
      createdAtIso: "2026-06-15T01:00:00.000Z",
      nowIso: "2026-06-16T09:00:00.000Z",
    },
    expected: {
      narrative:
        "2026-06-15 頃、AUDN bench の DELETE 件数を 100 まで底上げした。",
    },
  },
  {
    id: "time-update-15-future-plan-jp",
    description: "明日の予定は記録時点の翌日に絶対化",
    input: {
      narrative: "明日 v0.5.0 をリリースする予定。",
      createdAtIso: "2026-03-09T00:00:00.000Z",
      nowIso: "2026-04-09T00:00:00.000Z",
    },
    expected: {
      narrative: "2026-03-10 頃に v0.5.0 をリリース予定だった過去の計画。",
    },
  },
  {
    id: "time-update-16-currently-en",
    description: "'currently' → absolute month",
    input: {
      narrative: "We are currently piloting BGE-M3 as the embedding model.",
      createdAtIso: "2026-01-15T00:00:00.000Z",
      nowIso: "2026-05-15T00:00:00.000Z",
    },
    expected: {
      narrative:
        "As of around 2026-01-15, BGE-M3 was being piloted as the embedding model.",
    },
  },
  {
    id: "time-update-17-recently-en",
    description: "'recently' → absolute date",
    input: {
      narrative: "Recently we tightened the AUDN system prompt.",
      createdAtIso: "2026-03-20T00:00:00.000Z",
      nowIso: "2026-05-20T00:00:00.000Z",
    },
    expected: {
      narrative: "Around 2026-03-20, the AUDN system prompt was tightened.",
    },
  },
  {
    id: "time-update-18-stable-config-jp",
    description: "設定値は事実なのでそのまま",
    input: {
      narrative: "PORT は 8000、CONCURRENCY は 4。",
      createdAtIso: "2026-02-01T00:00:00.000Z",
      nowIso: "2026-06-01T00:00:00.000Z",
    },
    expected: { narrative: "PORT は 8000、CONCURRENCY は 4 という設定。" },
  },
  {
    id: "time-update-19-stable-constant-en",
    description: "Configuration constants stay unchanged",
    input: {
      narrative: "Embedding dimension is 1024 and RRF k constant is 60.",
      createdAtIso: "2026-01-01T00:00:00.000Z",
      nowIso: "2026-07-01T00:00:00.000Z",
    },
    expected: {
      narrative: "Embedding dimension is 1024 and RRF k constant is 60.",
    },
  },
  {
    id: "time-update-20-ongoing-investigation-jp",
    description: "進行中の調査が完了形へ",
    input: {
      narrative: "現在、Layer 2 quarantine の閾値を実運用で観察中。",
      createdAtIso: "2026-04-10T00:00:00.000Z",
      nowIso: "2026-06-10T00:00:00.000Z",
    },
    expected: {
      narrative:
        "2026-04 頃から、Layer 2 quarantine の閾値を実運用で観察していた。",
    },
  },
  {
    id: "time-update-21-blocker-jp",
    description: "ブロッカーが過去化",
    input: {
      narrative: "drizzle migrate が静かに失敗していて困っている。",
      createdAtIso: "2026-02-20T00:00:00.000Z",
      nowIso: "2026-05-20T00:00:00.000Z",
    },
    expected: {
      narrative:
        "2026-02 頃、drizzle migrate が静かに失敗する事象に直面していた。",
    },
  },
  {
    id: "time-update-22-fixed-bug-jp",
    description: "修正完了の事実",
    input: {
      narrative: "今、Forgejo blob PUT 500 を mkdir + restart で復旧した。",
      createdAtIso: "2026-05-23T00:00:00.000Z",
      nowIso: "2026-06-15T00:00:00.000Z",
    },
    expected: {
      narrative:
        "2026-05-23 頃、Forgejo blob PUT 500 を mkdir + restart で復旧した過去の事案。",
    },
  },
  {
    id: "time-update-23-stable-en-fact-no-verb",
    description: "Verb-less architectural fact stays",
    input: {
      narrative:
        "The MCP transport is WebStandardStreamableHTTPServerTransport.",
      createdAtIso: "2026-02-15T00:00:00.000Z",
      nowIso: "2026-06-15T00:00:00.000Z",
    },
    expected: {
      narrative:
        "The MCP transport is WebStandardStreamableHTTPServerTransport.",
    },
  },
  {
    id: "time-update-24-mixed-jp",
    description: "絶対日付＋相対表現混在 — 絶対は保持、相対は絶対化",
    input: {
      narrative:
        "2026-01-15 に PostgreSQL 18 を採用し、最近 vector 拡張を有効化した。",
      createdAtIso: "2026-05-10T00:00:00.000Z",
      nowIso: "2026-06-15T00:00:00.000Z",
    },
    expected: {
      narrative:
        "2026-01-15 に PostgreSQL 18 を採用、2026-05 頃に vector 拡張を有効化した。",
    },
  },
  {
    id: "time-update-25-two-weeks-en",
    description: "two weeks ago → absolute",
    input: {
      narrative: "Two weeks ago I shipped the time-update bench.",
      createdAtIso: "2026-06-01T00:00:00.000Z",
      nowIso: "2026-06-15T00:00:00.000Z",
    },
    expected: {
      narrative: "Around 2026-05-18, the time-update bench was shipped.",
    },
  },
  {
    id: "time-update-26-about-month-en",
    description: "'about a month ago' → absolute month",
    input: {
      narrative: "About a month ago we paused the claude-mem migration plan.",
      createdAtIso: "2026-05-01T00:00:00.000Z",
      nowIso: "2026-06-01T00:00:00.000Z",
    },
    expected: {
      narrative: "Around April 2026, the claude-mem migration plan was paused.",
    },
  },
  {
    id: "time-update-27-just-decided-jp",
    description: "'今しがた / 今' などの 0 日相当も createdAt 日付化",
    input: {
      narrative: "今、Layer 3 fallback の挙動が確定した。",
      createdAtIso: "2026-04-22T00:00:00.000Z",
      nowIso: "2026-06-22T00:00:00.000Z",
    },
    expected: {
      narrative: "2026-04-22 頃、Layer 3 fallback の挙動が確定した。",
    },
  },
  {
    id: "time-update-28-stale-version-en",
    description: "Library version note ages into past use",
    input: {
      narrative: "We are pinning node-cron to 3.0 because of the schedule API.",
      createdAtIso: "2025-12-01T00:00:00.000Z",
      nowIso: "2026-06-01T00:00:00.000Z",
    },
    expected: {
      narrative:
        "Around December 2025, node-cron was pinned to 3.0 due to the schedule API at the time.",
    },
  },
  {
    id: "time-update-29-stable-jp-no-verb",
    description: "動詞のない設計事実は不変",
    input: {
      narrative:
        "ワーカーは promote-observations / synthesize / time-update / decision-contradiction / reflection の 5 種。",
      createdAtIso: "2026-02-10T00:00:00.000Z",
      nowIso: "2026-06-10T00:00:00.000Z",
    },
    expected: {
      narrative:
        "ワーカーは promote-observations / synthesize / time-update / decision-contradiction / reflection の 5 種という構成。",
    },
  },
  {
    id: "time-update-30-narrow-window-no-change",
    description: "14 日未満なら大きな書き換え不要",
    input: {
      narrative: "今日、private fixture を初投入した。",
      createdAtIso: "2026-06-13T00:00:00.000Z",
      nowIso: "2026-06-15T00:00:00.000Z",
    },
    expected: { narrative: "2026-06-13 頃、private fixture を初投入した。" },
  },
];
