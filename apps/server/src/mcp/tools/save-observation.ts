import { ObservationInput } from "@tsumugi/shared";
import { db } from "../../db/client.js";
import { observations } from "../../db/schema.js";
import { newId } from "../../db/id.js";
import { getEmbedder } from "../../embedding/singleton.js";

export const SAVE_OBSERVATION_TOOL = {
  name: "save_observation",
  description:
    "tsumugi に observation (Layer 1) を保存する。内容は raw のまま残り、後段の dreaming で synthesis される。",
  inputSchema: {
    type: "object" as const,
    properties: {
      content: {
        type: "string",
        minLength: 1,
        description: "観測内容 (必須)",
      },
      type: {
        type: "string",
        enum: [
          "discovery",
          "progress",
          "blocker",
          "decision",
          "reflection",
          "other",
        ],
        description: "観測の種別 (default: other)",
      },
      source: {
        type: "string",
        enum: ["claude-code", "codex", "yui", "other"],
        description: "呼び出し元クライアント (必須)",
      },
      session_id: {
        type: "string",
        description: "セッション識別子 (任意)",
      },
      project_tag: {
        type: "string",
        description: "プロジェクトタグ (任意)",
      },
      facts: {
        type: "array",
        items: { type: "string" },
        description: "抽出済みファクトのリスト (任意)",
      },
      metadata: {
        type: "object",
        description: "追加メタデータ (任意)",
      },
    },
    required: ["content", "source"],
    additionalProperties: false,
  },
} as const;

export interface SaveObservationResult {
  id: string;
  layer: "observation";
}

export async function handleSaveObservation(
  rawInput: unknown,
): Promise<SaveObservationResult> {
  const input = ObservationInput.parse(rawInput);
  const embedder = getEmbedder();
  const emb = await embedder.embed(input.content);

  const id = newId("obs");
  await db.insert(observations).values({
    id,
    content: input.content,
    type: input.type,
    source: input.source,
    session_id: input.session_id ?? null,
    project_tag: input.project_tag ?? null,
    facts: input.facts ?? null,
    metadata: input.metadata ?? null,
    // Float32Array → number[] for Drizzle vector column
    embedding: Array.from(emb),
  });

  return { id, layer: "observation" as const };
}
