import { saveObservation } from "../../../core/observation/save.js";

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
  const result = await saveObservation(rawInput);
  return { id: result.id, layer: "observation" as const };
}
