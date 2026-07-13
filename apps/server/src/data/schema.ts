/**
 * Drizzle ORM schema definitions.
 *
 * Layer 1: captures     — deterministic raw hook capture, TTL-bound
 * Layer 2: observations — curated accumulation layer
 * Layer 3: memories     — synthesised, regenerable summaries
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
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Layer 1: captures
// ---------------------------------------------------------------------------
export const captures = pgTable(
  "captures",
  {
    id: text("id").primaryKey(),
    session_id: text("session_id").notNull(),
    project_tag: text("project_tag"),
    /** ClientSource: claude-code | codex | yui | other */
    source: text("source").notNull(),
    /** Hook event name: UserPromptSubmit | Stop | PostToolUse | ... */
    hook_event: text("hook_event").notNull(),
    /** Tool name for PostToolUse events. */
    tool_name: text("tool_name"),
    /** Client conversation turn identifier when the hook exposes one. */
    turn_id: text("turn_id"),
    /** Sanitized text safe for bounded SessionStart continuity injection. */
    continuity_content: text("continuity_content"),
    /** Fingerprint of the sanitized raw payload for diagnostics and matching. */
    content_hash: text("content_hash").notNull(),
    raw_content: text("raw_content").notNull(),
    captured_at: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
    promoted_to_obs_id: text("promoted_to_obs_id").references(
      () => observations.id,
    ),
    promoted_at: timestamp("promoted_at", { withTimezone: true }),
    skip_reason: text("skip_reason"),
    /** ready | windowed | promoted | skipped | legacy_partial */
    promotion_state: text("promotion_state").notNull().default("ready"),
    promotion_window_id: text("promotion_window_id").references(
      () => capturePromotionWindows.id,
    ),
  },
  (table) => [
    index("idx_captures_session_captured").on(
      table.session_id,
      table.captured_at.desc(),
    ),
    index("idx_captures_expires").on(table.expires_at),
    index("idx_captures_unpromoted")
      .on(table.captured_at)
      .where(
        sql`${table.promoted_to_obs_id} IS NULL AND ${table.skip_reason} IS NULL AND ${table.promotion_state} = 'ready'`,
      ),
    index("idx_captures_continuity").on(
      table.project_tag,
      table.captured_at.desc(),
    ),
    uniqueIndex("uq_captures_turn_checkpoint")
      .on(table.source, table.session_id, table.hook_event, table.turn_id)
      .where(
        sql`${table.turn_id} IS NOT NULL AND ${table.hook_event} IN ('UserPromptSubmit', 'Stop')`,
      ),
    uniqueIndex("uq_captures_turn_content_event")
      .on(
        table.source,
        table.session_id,
        table.hook_event,
        table.turn_id,
        table.content_hash,
      )
      .where(sql`${table.turn_id} IS NOT NULL`),
  ],
);

export type Capture = typeof captures.$inferSelect;
export type NewCapture = typeof captures.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 2: observations
// ---------------------------------------------------------------------------
export const observations = pgTable(
  "observations",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    /** ObservationType: discovery | progress | blocker | decision | reflection | other */
    type: text("type").notNull(),
    /** ClientSource: claude-code | codex | yui | other */
    source: text("source").notNull(),
    /** agent = direct save_observation; capture = promoted from Layer 1 */
    source_layer: text("source_layer").notNull().default("agent"),
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
    /** ready | processing | completed | skipped | quarantined | legacy_partial */
    promotion_state: text("promotion_state").notNull().default("ready"),
    promotion_failure_count: integer("promotion_failure_count")
      .notNull()
      .default(0),
    promotion_next_attempt_at: timestamp("promotion_next_attempt_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    promotion_last_failure_at: timestamp("promotion_last_failure_at", {
      withTimezone: true,
    }),
    promotion_last_error: text("promotion_last_error"),
    /**
     * pg_bigm 検索用の生成列。content と facts を結合し、コードシンボル等が
     * facts[] にしかない場合でも bigram マッチでヒットさせる。
     */
    search_text: text("search_text")
      .notNull()
      .generatedAlwaysAs(
        sql`("content" || ' ' || coalesce("facts"::text, ''))`,
      ),
  },
  (table) => [
    index("idx_observations_promotion_eligible").on(
      table.promotion_state,
      table.promotion_next_attempt_at,
      table.created_at,
    ),
  ],
);

export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;

// ---------------------------------------------------------------------------
// Durable promotion orchestration
// ---------------------------------------------------------------------------
export const capturePromotionWindows = pgTable(
  "capture_promotion_windows",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    session_id: text("session_id").notNull(),
    project_tag: text("project_tag"),
    /** pending | processing | committing | completed | skipped | deferred | quarantined | expired */
    status: text("status").notNull().default("pending"),
    cutoff_at: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    capture_count: integer("capture_count").notNull(),
    raw_chars: integer("raw_chars").notNull(),
    completed_turns: integer("completed_turns").notNull().default(0),
    fallback: boolean("fallback").notNull().default(false),
    /** Cleared after terminal state or the Layer 1 retention horizon. */
    input_content: text("input_content"),
    attempt_count: integer("attempt_count").notNull().default(0),
    /** Item-scoped failures only; provider outages do not advance quarantine. */
    failure_count: integer("failure_count").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    last_error: text("last_error"),
    observation_id: text("observation_id").references(() => observations.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_capture_windows_eligible").on(
      table.status,
      table.next_attempt_at,
      table.created_at,
    ),
  ],
);

export type CapturePromotionWindow =
  typeof capturePromotionWindows.$inferSelect;
export type NewCapturePromotionWindow =
  typeof capturePromotionWindows.$inferInsert;

export const captureObservationLinks = pgTable(
  "capture_observation_links",
  {
    // Capture rows are TTL-bound; keep the identifier after raw data expires.
    capture_id: text("capture_id").notNull(),
    observation_id: text("observation_id")
      .notNull()
      .references(() => observations.id),
    window_id: text("window_id")
      .notNull()
      .references(() => capturePromotionWindows.id),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.capture_id, table.observation_id] }),
    index("idx_capture_observation_window").on(table.window_id),
  ],
);

export const observationPromotionFacts = pgTable(
  "observation_promotion_facts",
  {
    id: text("id").primaryKey(),
    observation_id: text("observation_id")
      .notNull()
      .references(() => observations.id),
    fact_hash: text("fact_hash").notNull(),
    fact: text("fact").notNull(),
    ordinal: integer("ordinal").notNull(),
    /** pending | processing | committing | completed | deferred | quarantined */
    status: text("status").notNull().default("pending"),
    attempt_count: integer("attempt_count").notNull().default(0),
    /** Item-scoped failures only; provider outages do not advance quarantine. */
    failure_count: integer("failure_count").notNull().default(0),
    next_attempt_at: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lease_expires_at: timestamp("lease_expires_at", { withTimezone: true }),
    last_error: text("last_error"),
    decision: text("decision"),
    target_memory_id: text("target_memory_id"),
    result_memory_id: text("result_memory_id"),
    reasoning: text("reasoning"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_observation_fact_hash").on(
      table.observation_id,
      table.fact_hash,
    ),
    index("idx_observation_facts_eligible").on(
      table.status,
      table.next_attempt_at,
      table.created_at,
    ),
  ],
);

export type ObservationPromotionFact =
  typeof observationPromotionFacts.$inferSelect;
export type NewObservationPromotionFact =
  typeof observationPromotionFacts.$inferInsert;

// ---------------------------------------------------------------------------
// Layer 3: memories
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
  /** promote-* | synthesize | time-update | decision-contradiction | reflection */
  job_kind: text("job_kind").notNull(),
  /** pending | running | completed | partial | failed */
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
