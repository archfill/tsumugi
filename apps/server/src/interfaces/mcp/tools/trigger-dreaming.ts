import {
  runDreaming,
  type DreamingJob,
} from "../../../core/dreaming/runner.js";

export const TRIGGER_DREAMING_TOOL = {
  name: "trigger_dreaming",
  description:
    "tsumugi の dreaming worker を手動起動する。job 指定で個別 / 全部 を切替。",
  inputSchema: {
    type: "object" as const,
    properties: {
      job: {
        type: "string",
        enum: [
          "promote-captures",
          "sweep-captures",
          "promote-observations",
          "synthesize",
          "time-update",
          "decision-contradiction",
          "reflection",
          "full",
        ],
        description:
          "どの dreaming タスクを動かすか。reflection は sessionId 必須、full はそれ以外を順次実行。",
      },
      sessionId: {
        type: "string",
        description: "reflection の対象 session ID",
      },
      maxObservations: {
        type: "number",
        description: "promote-observations の上限 (default 50)",
      },
      maxMemories: {
        type: "number",
        description: "synthesize / time-update 共通の上限 (default 500)",
      },
      maxUpdates: {
        type: "number",
        description: "time-update の更新数上限 (default 50)",
      },
      timeUpdateMaxRunMs: {
        type: "number",
        description: "time-update の実行時間上限 ms (default 30分)",
      },
      timeUpdateMaxFailures: {
        type: "number",
        description: "time-update の失敗数上限 (default 10)",
      },
      timeUpdateMaxConsecutiveFailures: {
        type: "number",
        description: "time-update の連続失敗数上限 (default 5)",
      },
      timeUpdateStaleRunMs: {
        type: "number",
        description: "running run を stale とみなす経過時間 ms (default 2時間)",
      },
    },
    required: ["job"],
    additionalProperties: false,
  },
} as const;

export async function handleTriggerDreaming(rawInput: unknown) {
  const input = rawInput as {
    job: DreamingJob;
    sessionId?: string;
    maxObservations?: number;
    maxMemories?: number;
    maxUpdates?: number;
    timeUpdateMaxRunMs?: number;
    timeUpdateMaxFailures?: number;
    timeUpdateMaxConsecutiveFailures?: number;
    timeUpdateStaleRunMs?: number;
  };
  if (!input?.job) {
    throw new Error("job is required");
  }
  return await runDreaming(input);
}
