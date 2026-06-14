import { dreamingRunRepo } from "../../../data/repos/dreaming-run.js";

export const GET_DREAMING_STATUS_TOOL = {
  name: "get_dreaming_status",
  description: "tsumugi の直近 dreaming 実行履歴を取得する。",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "number",
        description: "取得件数 (default 20, max 100)",
        default: 20,
      },
    },
    additionalProperties: false,
  },
} as const;

export async function handleGetDreamingStatus(rawInput: unknown) {
  const input = (rawInput ?? {}) as { limit?: number };
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const runs = await dreamingRunRepo.listRecent(limit);
  return { runs };
}
