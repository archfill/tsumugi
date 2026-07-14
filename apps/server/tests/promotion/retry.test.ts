import { beforeEach, describe, expect, it, vi } from "vitest";

const captureRepoMock = vi.hoisted(() => ({ listForWindow: vi.fn() }));
const windowRepoMock = vi.hoisted(() => ({ findById: vi.fn() }));
const recoveryRepoMock = vi.hoisted(() => ({
  retryWindow: vi.fn(),
  retryFact: vi.fn(),
  retryObservation: vi.fn(),
}));

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

function capture(id: string, hookEvent: "UserPromptSubmit" | "Stop") {
  return {
    id,
    session_id: "ses_1",
    project_tag: "tsumugi",
    source: "codex",
    hook_event: hookEvent,
    tool_name: null,
    turn_id: "turn_1",
    continuity_content: hookEvent === "Stop" ? "Assistant answer" : "User request",
    content_hash: `hash_${id}`,
    raw_content: "{}",
    captured_at: new Date(
      hookEvent === "Stop"
        ? "2026-07-13T00:00:01Z"
        : "2026-07-13T00:00:00Z",
    ),
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
    recoveryRepoMock.retryFact.mockResolvedValue(true);
    recoveryRepoMock.retryObservation.mockResolvedValue(true);
  });

  it("quarantined windowの入力を保持中captureから再構成する", async () => {
    windowRepoMock.findById.mockResolvedValueOnce({
      id: "win_1",
      status: "quarantined",
      input_content: null,
      capture_count: 2,
    });
    captureRepoMock.listForWindow.mockResolvedValueOnce([
      capture("cap_user", "UserPromptSubmit"),
      capture("cap_stop", "Stop"),
    ]);

    await retryPromotionIssue({ kind: "window", id: "win_1" });

    expect(recoveryRepoMock.retryWindow).toHaveBeenCalledWith(
      "win_1",
      expect.stringContaining("Assistant answer"),
      ["cap_user", "cap_stop"],
    );
  });

  it("deferred factをrepositoryのretryへ渡す", async () => {
    await expect(
      retryPromotionIssue({ kind: "fact", id: "fact_1" }),
    ).resolves.toEqual({ ok: true, kind: "fact", id: "fact_1" });
    expect(recoveryRepoMock.retryFact).toHaveBeenCalledWith("fact_1");
  });

  it("payloadを復元できないwindowはretryしない", async () => {
    windowRepoMock.findById.mockResolvedValueOnce({
      id: "win_1",
      status: "quarantined",
      input_content: null,
      capture_count: 2,
    });
    captureRepoMock.listForWindow.mockResolvedValueOnce([]);

    await expect(
      retryPromotionIssue({ kind: "window", id: "win_1" }),
    ).rejects.toThrow("source captures are no longer available");
    expect(recoveryRepoMock.retryWindow).not.toHaveBeenCalled();
  });

  it("一部のsource captureが欠落したwindowはretryしない", async () => {
    windowRepoMock.findById.mockResolvedValueOnce({
      id: "win_1",
      status: "quarantined",
      input_content: null,
      capture_count: 2,
    });
    captureRepoMock.listForWindow.mockResolvedValueOnce([
      capture("cap_stop", "Stop"),
    ]);

    await expect(
      retryPromotionIssue({ kind: "window", id: "win_1" }),
    ).rejects.toThrow("source captures are no longer available");
    expect(recoveryRepoMock.retryWindow).not.toHaveBeenCalled();
  });
});
