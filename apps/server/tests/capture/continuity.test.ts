import { beforeEach, describe, expect, it, vi } from "vitest";

const captureRepoMock = vi.hoisted(() => ({
  listContinuityCandidates: vi.fn(),
}));

vi.mock("../../src/data/repos/capture.js", () => ({
  captureRepo: captureRepoMock,
}));

const { getCaptureContinuity } = await import(
  "../../src/core/capture/continuity.js"
);

function continuityCapture(
  id: string,
  sessionId: string,
  content: string | null,
  capturedAt: string,
) {
  return {
    id,
    session_id: sessionId,
    project_tag: "archfill/tsumugi",
    source: "codex",
    hook_event: "Stop",
    tool_name: null,
    turn_id: id,
    continuity_content: content,
    content_hash: `hash_${id}`,
    raw_content: content
      ? "{}"
      : JSON.stringify({ last_assistant_message: `raw ${id}` }),
    captured_at: new Date(capturedAt),
    expires_at: new Date("2026-08-12T00:00:00Z"),
    promoted_to_obs_id: null,
    promoted_at: null,
    skip_reason: null,
    promotion_state: "ready",
    promotion_window_id: null,
  };
}

describe("getCaptureContinuity", () => {
  beforeEach(() => {
    captureRepoMock.listContinuityCandidates.mockReset();
  });

  it("max sessions と session ごとの max turns を超えて返さない", async () => {
    captureRepoMock.listContinuityCandidates.mockResolvedValue([
      continuityCapture("s1_3", "ses_1", "s1 checkpoint 3", "2026-07-13T03:00:00Z"),
      continuityCapture("s1_2", "ses_1", null, "2026-07-13T02:00:00Z"),
      continuityCapture("s1_1", "ses_1", "s1 checkpoint 1", "2026-07-13T01:00:00Z"),
      continuityCapture("s2_2", "ses_2", "s2 checkpoint 2", "2026-07-12T03:00:00Z"),
      continuityCapture("s2_1", "ses_2", "s2 checkpoint 1", "2026-07-12T02:00:00Z"),
      continuityCapture("s3_1", "ses_3", "s3 checkpoint 1", "2026-07-11T03:00:00Z"),
    ]);

    const result = await getCaptureContinuity({
      project_tag: "archfill/tsumugi",
      exclude_session_id: "ses_current",
      max_sessions: 2,
      max_turns_per_session: 2,
    });

    expect(captureRepoMock.listContinuityCandidates).toHaveBeenCalledWith({
      projectTag: "archfill/tsumugi",
      excludeSessionId: "ses_current",
      limit: 16,
    });
    expect(result.sessions).toEqual([
      {
        source: "codex",
        sessionId: "ses_1",
        latestAt: "2026-07-13T03:00:00.000Z",
        checkpoints: ["s1 checkpoint 3", "raw s1_2"],
      },
      {
        source: "codex",
        sessionId: "ses_2",
        latestAt: "2026-07-12T03:00:00.000Z",
        checkpoints: ["s2 checkpoint 2", "s2 checkpoint 1"],
      },
    ]);
  });

  it("schema 上限を超える continuity request を repository 前に拒否する", async () => {
    await expect(
      getCaptureContinuity({
        project_tag: "archfill/tsumugi",
        max_sessions: 6,
        max_turns_per_session: 6,
      }),
    ).rejects.toThrow();

    expect(captureRepoMock.listContinuityCandidates).not.toHaveBeenCalled();
  });
});
