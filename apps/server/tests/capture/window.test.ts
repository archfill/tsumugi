import { describe, expect, it } from "vitest";
import type { CaptureRow } from "../../src/data/repos/capture.js";
import { buildCaptureWindows } from "../../src/core/capture/window.js";

const BASE_TIME = new Date("2026-07-13T00:00:00Z");

function capture(
  id: string,
  index: number,
  overrides: Partial<CaptureRow> = {},
): CaptureRow {
  return {
    id,
    session_id: "ses_1",
    project_tag: "archfill/tsumugi",
    source: "codex",
    hook_event: "Stop",
    tool_name: null,
    turn_id: `turn_${index}`,
    continuity_content: `checkpoint ${index}`,
    content_hash: `hash_${id}`,
    raw_content: "{}",
    captured_at: new Date(BASE_TIME.getTime() + index * 1_000),
    expires_at: new Date("2026-08-12T00:00:00Z"),
    promoted_to_obs_id: null,
    promoted_at: null,
    skip_reason: null,
    promotion_state: "ready",
    promotion_window_id: null,
    ...overrides,
  };
}

function completedTurn(turn: number, content = `turn ${turn}`): CaptureRow[] {
  return [
    capture(`cap_${turn}_user`, turn * 2, {
      turn_id: `turn_${turn}`,
      hook_event: "UserPromptSubmit",
      continuity_content: `${content} user`,
    }),
    capture(`cap_${turn}_stop`, turn * 2 + 1, {
      turn_id: `turn_${turn}`,
      hook_event: "Stop",
      continuity_content: `${content} assistant`,
    }),
  ];
}

describe("buildCaptureWindows", () => {
  it("completed turn を3 turnsずつ同じ window にまとめる", () => {
    const windows = buildCaptureWindows([
      ...completedTurn(1),
      ...completedTurn(2),
      ...completedTurn(3),
      ...completedTurn(4),
    ]);

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      captureIds: [
        "cap_1_user",
        "cap_1_stop",
        "cap_2_user",
        "cap_2_stop",
        "cap_3_user",
        "cap_3_stop",
      ],
      completedTurns: 3,
      fallback: false,
    });
    expect(windows[1]).toMatchObject({
      captureIds: ["cap_4_user", "cap_4_stop"],
      completedTurns: 1,
      fallback: false,
    });
  });

  it("turn_id がない client は Stop 境界で implicit turn を組み立てる", () => {
    const rows = [
      capture("cap_user_1", 1, {
        turn_id: null,
        hook_event: "UserPromptSubmit",
        continuity_content: "first prompt",
      }),
      capture("cap_stop_1", 2, {
        turn_id: null,
        hook_event: "Stop",
        continuity_content: "first response",
      }),
      capture("cap_user_2", 3, {
        turn_id: null,
        hook_event: "UserPromptSubmit",
        continuity_content: "second prompt",
      }),
      capture("cap_stop_2", 4, {
        turn_id: null,
        hook_event: "Stop",
        continuity_content: "second response",
      }),
    ];

    const windows = buildCaptureWindows(rows);

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      captureIds: ["cap_user_1", "cap_stop_1", "cap_user_2", "cap_stop_2"],
      completedTurns: 2,
      fallback: false,
    });
  });

  it("次の turn で char boundary を超える場合は window を分割する", () => {
    const windows = buildCaptureWindows(
      [
        ...completedTurn(1, "a".repeat(40)),
        ...completedTurn(2, "b".repeat(40)),
      ],
      { maxChars: 120 },
    );

    expect(windows).toHaveLength(2);
    expect(windows.map((window) => window.captureIds)).toEqual([
      ["cap_1_user", "cap_1_stop"],
      ["cap_2_user", "cap_2_stop"],
    ]);
    expect(windows.every((window) => window.content.length <= 120)).toBe(true);
    expect(windows.every((window) => window.rawChars <= 120)).toBe(true);
  });

  it("未完了 capture は stale threshold 到達後だけ fallback window にする", () => {
    const now = new Date("2026-07-13T02:00:00Z");
    const stale = capture("cap_stale", 1, {
      hook_event: "UserPromptSubmit",
      turn_id: "turn_stale",
      continuity_content: "unfinished old prompt",
      captured_at: new Date("2026-07-13T00:59:59Z"),
    });
    const recent = capture("cap_recent", 2, {
      hook_event: "UserPromptSubmit",
      turn_id: "turn_recent",
      continuity_content: "unfinished recent prompt",
      captured_at: new Date("2026-07-13T01:30:00Z"),
    });

    const windows = buildCaptureWindows([recent, stale], { now });

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      captureIds: ["cap_stale"],
      completedTurns: 0,
      fallback: true,
      cutoffAt: stale.captured_at,
    });
  });
});
