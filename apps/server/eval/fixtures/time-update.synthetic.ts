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
];
