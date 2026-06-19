import { markMemoryOutdated } from "../../../core/memory/mark-outdated.js";

export const MARK_MEMORY_OUTDATED_TOOL = {
  name: "mark_memory_outdated",
  description:
    "memory を outdated としてマークし、次の dreaming で archive 候補にする。即 archive はしない。",
  inputSchema: {
    type: "object" as const,
    properties: {
      memory_id: {
        type: "string",
        minLength: 1,
        description: "outdated としてマークする memory id",
      },
      reason: {
        type: "string",
        minLength: 10,
        description: "outdated と判断した理由 (10 文字以上)",
      },
    },
    required: ["memory_id", "reason"],
    additionalProperties: false,
  },
} as const;

export async function handleMarkMemoryOutdated(rawInput: unknown) {
  return await markMemoryOutdated(rawInput);
}
