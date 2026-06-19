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
