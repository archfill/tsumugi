/**
 * Drizzle ORM schema definitions.
 *
 * Layer 1: observations — raw, immutable accumulation layer
 * Layer 2: memories    — synthesised, regenerable summaries
 * decisions            — explicit decisions with lifecycle tracking
 * links                — provenance edges between any layer entities
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  real,
  jsonb,
  timestamp,
  primaryKey,
  integer,
} from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Layer 1: observations
// ---------------------------------------------------------------------------
export const observations = pgTable("observations", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  /** ObservationType: discovery | progress | blocker | decision | reflection | other */
  type: text("type").notNull(),
  /** ClientSource: claude-code | codex | yui | other */
  source: text("source").notNull(),
  session_id: text("session_id"),
  project_tag: text("project_tag"),
  /** string[] */
  facts: jsonb("facts").$type<string[]>(),
  /** Record<string, unknown> */
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  /** BGE-M3 embedding dim = 1024 */
  embedding: vector("embedding", { dimensions: 1024 }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** NULL = not yet promoted to Layer 2 by the dreaming worker */
  promoted_at: timestamp("promoted_at", { withTimezone: true }),
  /**
   * pg_bigm 検索用の生成列。content と facts を結合し、コードシンボル等が
   * facts[] にしかない場合でも bigram マッチでヒットさせる。
   */
  search_text: text("search_text")
    .notNull()
    .generatedAlwaysAs(sql`("content" || ' ' || coalesce("facts"::text, ''))`),
});

export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 2: memories
// ---------------------------------------------------------------------------
export const memories = pgTable("memories", {
  id: text("id").primaryKey(),
  narrative: text("narrative").notNull(),
  importance: real("importance").notNull().default(5.0),
  /** general | decision | preference | insight | … (open string) */
  kind: text("kind").notNull().default("general"),
  /** BGE-M3 embedding dim = 1024 */
  embedding: vector("embedding", { dimensions: 1024 }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** NULL = active; non-NULL = archived (soft delete / forget) */
  archived_at: timestamp("archived_at", { withTimezone: true }),
  /** NULL = current; non-NULL = agent marked as outdated for dreaming review. */
  outdated_at: timestamp("outdated_at", { withTimezone: true }),
  outdated_reason: text("outdated_reason"),
  /**
   * LLM failure tracking (Layer 2 resilience).
   * - llm_failure_count: 連続失敗回数。成功で 0 に reset。
   * - last_llm_failure_at: 最後に LLM 操作 (time-update 等) が失敗した時刻。
   * - llm_quarantined_at: 累積失敗が閾値超え → quarantine、以降 LLM 処理対象外。
   */
  llm_failure_count: integer("llm_failure_count").notNull().default(0),
  last_llm_failure_at: timestamp("last_llm_failure_at", { withTimezone: true }),
  llm_quarantined_at: timestamp("llm_quarantined_at", { withTimezone: true }),
});

export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

// ---------------------------------------------------------------------------
// decisions
// ---------------------------------------------------------------------------
export const decisions = pgTable("decisions", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  /** in_progress | completed | superseded | archived */
  status: text("status").notNull().default("in_progress"),
  /** self-reference: which decision this one supersedes */
  supersedes_id: text("supersedes_id"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Decision = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;

// ---------------------------------------------------------------------------
// links (provenance edges)
// ---------------------------------------------------------------------------
export const links = pgTable(
  "links",
  {
    from_id: text("from_id").notNull(),
    to_id: text("to_id").notNull(),
    /** observation | memory | decision */
    from_layer: text("from_layer").notNull(),
    /** observation | memory | decision */
    to_layer: text("to_layer").notNull(),
    /** derived_from | supersedes | related_to */
    relation: text("relation").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.from_id, table.to_id, table.relation] }),
  ],
);

export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;

// ---------------------------------------------------------------------------
// dreaming_runs (dreaming worker execution history)
// ---------------------------------------------------------------------------
export const dreamingRuns = pgTable("dreaming_runs", {
  id: text("id").primaryKey(),
  /** summarize | audn | synthesize | time-update | decision-contradiction | reflection | runner */
  job_kind: text("job_kind").notNull(),
  /** pending | running | completed | failed */
  status: text("status").notNull().default("pending"),
  started_at: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finished_at: timestamp("finished_at", { withTimezone: true }),
  input_count: integer("input_count").notNull().default(0),
  output_count: integer("output_count").notNull().default(0),
  error_message: text("error_message"),
  /** arbitrary additional info */
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
});

export type DreamingRun = typeof dreamingRuns.$inferSelect;
export type NewDreamingRun = typeof dreamingRuns.$inferInsert;
