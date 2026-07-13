import { z } from "zod";

export const ClientSource = z.enum(["claude-code", "codex", "yui", "other"]);
export type ClientSource = z.infer<typeof ClientSource>;

export const ObservationType = z.enum([
  "discovery",
  "progress",
  "blocker",
  "decision",
  "reflection",
  "other",
]);
export type ObservationType = z.infer<typeof ObservationType>;

export const ObservationInput = z.object({
  content: z.string().min(1),
  type: ObservationType.default("other"),
  source: ClientSource,
  session_id: z.string().optional(),
  project_tag: z.string().optional(),
  facts: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ObservationInput = z.infer<typeof ObservationInput>;

export const CaptureInput = z.object({
  session_id: z.string().min(1),
  project_tag: z.string().optional(),
  source: ClientSource,
  hook_event: z.string().min(1),
  tool_name: z.string().optional(),
  turn_id: z.string().min(1).optional(),
  continuity_content: z.string().min(1).max(20_000).optional(),
  raw_content: z.string().min(1),
});
export type CaptureInput = z.infer<typeof CaptureInput>;

export const CaptureContinuityInput = z.object({
  project_tag: z.string().min(1),
  exclude_session_id: z.string().min(1).optional(),
  max_sessions: z.number().int().positive().max(5).default(3),
  max_turns_per_session: z.number().int().positive().max(5).default(3),
});
export type CaptureContinuityInput = z.infer<typeof CaptureContinuityInput>;

export const SearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10),
  filter: z
    .object({
      type: ObservationType.optional(),
      source: ClientSource.optional(),
      session_id: z.string().optional(),
      // project_tag:
      //   - string  → そのプロジェクトに絞り込む
      //   - null    → project_tag 自動補完のみ opt-out (他 filter は維持)
      //   - 省略    → サーバー側 default (session 由来の project_tag があれば自動補完、ADR-013 G)
      project_tag: z.string().nullable().optional(),
    })
    .optional(),
});
export type SearchInput = z.infer<typeof SearchInput>;

export const SearchHit = z.object({
  id: z.string(),
  layer: z.enum(["observation", "memory"]),
  excerpt: z.string(),
  score: z.number(),
  tags: z.array(z.string()).default([]),
  provenance: z
    .array(
      z.object({
        layer: z.enum(["observation", "memory"]),
        id: z.string(),
        relation: z.enum(["derived_from", "supersedes", "related_to"]),
        created_at: z.string(),
      }),
    )
    .default([]),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const MarkMemoryOutdatedInput = z.object({
  memory_id: z.string().min(1),
  reason: z.string().min(10),
});
export type MarkMemoryOutdatedInput = z.infer<typeof MarkMemoryOutdatedInput>;

// ---------------------------------------------------------------------------
// Admin operations console (read-only)
// ---------------------------------------------------------------------------

export const AdminLayer = z.enum(["capture", "observation", "memory"]);
export type AdminLayer = z.infer<typeof AdminLayer>;

export const AdminTraceStage = z.enum(["window", "observation"]);
export type AdminTraceStage = z.infer<typeof AdminTraceStage>;

export const AdminFilterQuery = z.object({
  project: z.string().min(1).optional(),
  source: ClientSource.optional(),
  state: z.string().min(1).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  q: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
});
export type AdminFilterQuery = z.infer<typeof AdminFilterQuery>;

export const AdminFilterOptions = z.object({
  projects: z.array(z.string()),
  sources: z.array(ClientSource),
  states: z.record(z.string(), z.array(z.string())),
});
export type AdminFilterOptions = z.infer<typeof AdminFilterOptions>;

export const AdminLayerSummary = z.object({
  layer: AdminLayer,
  total: z.number().int().nonnegative(),
  created_24h: z.number().int().nonnegative(),
  states: z.record(z.string(), z.number().int().nonnegative()),
  oldest_actionable_at: z.string().nullable(),
});
export type AdminLayerSummary = z.infer<typeof AdminLayerSummary>;

export const AdminQueueSummary = z.object({
  stage: z.enum(["window", "fact"]),
  total: z.number().int().nonnegative(),
  states: z.record(z.string(), z.number().int().nonnegative()),
  oldest_actionable_at: z.string().nullable(),
});
export type AdminQueueSummary = z.infer<typeof AdminQueueSummary>;

export const AdminSchedulerJob = z.object({
  job: z.string(),
  cronExpr: z.string(),
});
export type AdminSchedulerJob = z.infer<typeof AdminSchedulerJob>;

export const AdminOverview = z.object({
  generated_at: z.string(),
  layers: z.array(AdminLayerSummary),
  queues: z.array(AdminQueueSummary),
  attention_count: z.number().int().nonnegative(),
  scheduler: z.object({
    enabled: z.boolean(),
    jobs: z.array(AdminSchedulerJob),
  }),
});
export type AdminOverview = z.infer<typeof AdminOverview>;

export const AdminPipelineTrace = z.object({
  id: z.string(),
  stage: AdminTraceStage,
  path: z.enum(["capture", "direct"]),
  project_tag: z.string().nullable(),
  source: ClientSource,
  session_id: z.string().nullable(),
  state: z.string(),
  sort_at: z.string(),
  capture_count: z.number().int().nonnegative(),
  completed_turns: z.number().int().nonnegative(),
  observation_id: z.string().nullable(),
  observation_state: z.string().nullable(),
  fact_count: z.number().int().nonnegative(),
  completed_fact_count: z.number().int().nonnegative(),
  memory_count: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  last_error: z.string().nullable(),
});
export type AdminPipelineTrace = z.infer<typeof AdminPipelineTrace>;

export const AdminPipelineTracePage = z.object({
  traces: z.array(AdminPipelineTrace),
  next_cursor: z.string().nullable(),
});
export type AdminPipelineTracePage = z.infer<
  typeof AdminPipelineTracePage
>;

export const AdminTraceNode = z.object({
  id: z.string(),
  kind: z.enum(["capture", "window", "observation", "fact", "memory"]),
  state: z.string(),
  occurred_at: z.string(),
  summary: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AdminTraceNode = z.infer<typeof AdminTraceNode>;

export const AdminTraceEdge = z.object({
  from_id: z.string(),
  to_id: z.string(),
  relation: z.string(),
});
export type AdminTraceEdge = z.infer<typeof AdminTraceEdge>;

export const AdminPipelineTraceDetail = z.object({
  id: z.string(),
  path: z.enum(["capture", "direct"]),
  nodes: z.array(AdminTraceNode),
  edges: z.array(AdminTraceEdge),
});
export type AdminPipelineTraceDetail = z.infer<
  typeof AdminPipelineTraceDetail
>;

export const AdminOperationIssue = z.object({
  id: z.string(),
  kind: z.enum([
    "window",
    "fact",
    "observation",
    "memory",
    "dreaming_run",
  ]),
  state: z.string(),
  project_tag: z.string().nullable(),
  source: z.string().nullable(),
  occurred_at: z.string(),
  attempt_count: z.number().int().nonnegative(),
  summary: z.string().nullable(),
  last_error: z.string().nullable(),
});
export type AdminOperationIssue = z.infer<typeof AdminOperationIssue>;

export const AdminOperationIssuePage = z.object({
  issues: z.array(AdminOperationIssue),
  next_cursor: z.string().nullable(),
});
export type AdminOperationIssuePage = z.infer<
  typeof AdminOperationIssuePage
>;
