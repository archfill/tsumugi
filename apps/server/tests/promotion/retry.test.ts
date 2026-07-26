import { beforeEach, describe, expect, it, vi } from "vitest";

const captureRepoMock = vi.hoisted(() => ({
  listActiveForWindow: vi.fn(),
}));
const windowRepoMock = vi.hoisted(() => ({ findById: vi.fn() }));
const recoveryRepoMock = vi.hoisted(() => ({ retryWindow: vi.fn() }));

vi.mock("../../src/data/repos/capture.js", () => ({
  captureRepo: captureRepoMock,
}));
vi.mock("../../src/data/repos/capture-promotion-window.js", () => ({
  capturePromotionWindowRepo: windowRepoMock,
}));
vi.mock("../../src/data/repos/promotion-recovery.js", () => ({
  promotionRecoveryRepo: recoveryRepoMock,
}));

const { retryPromotionIssue } = await import(
  "../../src/core/promotion/retry.js"
);

function stopCapture(id = "cap_stop") {
  return {
    id,
    session_id: "ses_1",
    project_tag: "tsumugi",
    source: "codex",
    hook_event: "Stop",
    tool_name: null,
    turn_id: "turn_1",
    continuity_content: "  Assistant answer  ",
    content_hash: `hash_${id}`,
    raw_content: '{"last_assistant_message":"must not be used"}',
    captured_at: new Date("2026-07-13T00:00:01Z"),
    expires_at: new Date("2026-08-12T00:00:00Z"),
    promoted_to_obs_id: null,
    promoted_at: null,
    skip_reason: null,
    promotion_state: "windowed",
    promotion_window_id: "win_1",
  };
}

describe("retryPromotionIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recoveryRepoMock.retryWindow.mockResolvedValue(true);
  });

  it("deterministic Stop windowをsanitized continuityから再試行する", async () => {
    windowRepoMock.findById.mockResolvedValueOnce({
      id: "win_1",
      promotion_kind: "stop_checkpoint",
      status: "quarantined",
      input_content: null,
      capture_count: 1,
    });
    captureRepoMock.listActiveForWindow.mockResolvedValueOnce([
      stopCapture(),
    ]);

    await expect(
      retryPromotionIssue({ kind: "window", id: "win_1" }),
    ).resolves.toEqual({ ok: true, kind: "window", id: "win_1" });
    expect(recoveryRepoMock.retryWindow).toHaveBeenCalledWith(
      "win_1",
      "Assistant answer",
      ["cap_stop"],
    );
  });

  it.each(["fact", "observation"] as const)(
    "legacy %s retryを非mutationの互換no-opにする",
    async (kind) => {
      await expect(
        retryPromotionIssue({ kind, id: `${kind}_1` }),
      ).resolves.toEqual({
        ok: true,
        kind,
        id: `${kind}_1`,
        skipped: true,
        reason: "removed_server_llm",
      });
      expect(windowRepoMock.findById).not.toHaveBeenCalled();
      expect(recoveryRepoMock.retryWindow).not.toHaveBeenCalled();
    },
  );

  it("legacy LLM windowはretryしない", async () => {
    windowRepoMock.findById.mockResolvedValueOnce({
      id: "win_1",
      promotion_kind: "window",
      status: "quarantined",
      input_content: "legacy user and assistant payload",
      capture_count: 2,
    });

    await expect(
      retryPromotionIssue({ kind: "window", id: "win_1" }),
    ).rejects.toThrow("promotion window is not retryable");
    expect(captureRepoMock.listActiveForWindow).not.toHaveBeenCalled();
  });

  it("source Stopが欠落したwindowはretryしない", async () => {
    windowRepoMock.findById.mockResolvedValueOnce({
      id: "win_1",
      promotion_kind: "stop_checkpoint",
      status: "quarantined",
      input_content: null,
      capture_count: 1,
    });
    captureRepoMock.listActiveForWindow.mockResolvedValueOnce([]);

    await expect(
      retryPromotionIssue({ kind: "window", id: "win_1" }),
    ).rejects.toThrow("source captures are no longer available");
    expect(recoveryRepoMock.retryWindow).not.toHaveBeenCalled();
  });
});
