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
      project_tag: z.string().optional(),
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
});
export type SearchHit = z.infer<typeof SearchHit>;
