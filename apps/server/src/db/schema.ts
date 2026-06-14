/**
 * Drizzle ORM schema definitions.
 *
 * Layer 1: observations — raw, immutable accumulation layer
 * Layer 2: memories    — synthesised, regenerable summaries
 * decisions            — explicit decisions with lifecycle tracking
 * links                — provenance edges between any layer entities
 */

import {
  pgTable,
  text,
  real,
  jsonb,
  timestamp,
  primaryKey,
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
