import { TriggerDreamingInput } from "@tsumugi/shared/schema";
import { runDreaming } from "../../../core/dreaming/runner.js";

export const TRIGGER_DREAMING_TOOL = {
  name: "trigger_dreaming",
  description:
    "決定論的maintenanceを手動起動する。旧server-LLM job名は互換no-op。",
  inputSchema: {
    type: "object" as const,
    properties: {
      job: {
        type: "string",
        enum: [
          "promote-captures",
          "sweep-captures",
          "archive-outdated",
          "promote-observations",
          "synthesize",
          "time-update",
          "decision-contradiction",
          "reflection",
          "full",
        ],
        description:
          "どの dreaming タスクを動かすか。promote-captures / sweep-captures / archive-outdated が実行対象。promote-observations / synthesize / time-update / decision-contradiction / reflection / full は廃止済みとして no-op で返す。reflection は互換入力として sessionId 必須。",
      },
      sessionId: {
        type: "string",
        description: "廃止済みreflection互換入力。実行には使用しない。",
      },
      maxCaptures: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "promote-captures の上限 (default 200)",
      },
      maxObservations: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "廃止済みpromote-observations互換入力。実行には使用しない。",
      },
      maxMemories: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "archive-outdated上限。旧synthesize/time-updateでは使用しない。",
      },
      maxUpdates: {
        type: "integer",
        minimum: 0,
        maximum: 500,
        description: "廃止済みtime-update互換入力。実行には使用しない。",
      },
      timeUpdateMaxRunMs: {
        type: "integer",
        minimum: 1,
        maximum: 86400000,
        description: "廃止済みtime-update互換入力。実行には使用しない。",
      },
      timeUpdateMaxFailures: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "廃止済みtime-update互換入力。実行には使用しない。",
      },
      timeUpdateMaxConsecutiveFailures: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "廃止済みtime-update互換入力。実行には使用しない。",
      },
      timeUpdateStaleRunMs: {
        type: "integer",
        minimum: 1,
        maximum: 604800000,
        description: "廃止済みtime-update互換入力。実行には使用しない。",
      },
    },
    required: ["job"],
    additionalProperties: false,
  },
} as const;

export async function handleTriggerDreaming(rawInput: unknown) {
  const input = TriggerDreamingInput.parse(rawInput);
  return await runDreaming(input);
}
