import { beforeEach, describe, expect, it, vi } from "vitest";

const captureRepoMock = vi.hoisted(() => ({
  listReady: vi.fn(),
  listForWindow: vi.fn(),
  deletePromoted: vi.fn(),
}));

const capturePromotionWindowRepoMock = vi.hoisted(() => ({
  create: vi.fn(),
  listEligible: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  skip: vi.fn(),
  defer: vi.fn(),
}));

const embedderMock = vi.hoisted(() => ({
  embed: vi.fn(),
}));

const summarizeObservationMock = vi.hoisted(() => vi.fn());
const withPgAdvisoryLockMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/capture.js", () => ({
  captureRepo: captureRepoMock,
}));

vi.mock("../../src/data/repos/capture-promotion-window.js", () => ({
  capturePromotionWindowRepo: capturePromotionWindowRepoMock,
}));

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => embedderMock,
}));

vi.mock("../../src/core/observation/summarize.js", () => ({
  summarizeObservation: summarizeObservationMock,
}));

vi.mock("../../src/data/advisory-lock.js", () => ({
  withPgAdvisoryLock: withPgAdvisoryLockMock,
}));

const { promoteCaptures } = await import("../../src/core/capture/promote.js");

function capture(
  id: string,
  hookEvent: "UserPromptSubmit" | "Stop" = "Stop",
) {
  return {
    id,
    session_id: "ses_1",
    project_tag: "archfill/tsumugi",
    source: "codex",
    hook_event: hookEvent,
    tool_name: null,
    turn_id: "turn_1",
    continuity_content:
      hookEvent === "Stop"
        ? "Capture promotion now uses durable windows."
        : "Implement durable capture promotion.",
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
    promotion_state: "ready",
    promotion_window_id: null,
  };
}

function promotionWindow(overrides: Record<string, unknown> = {}) {
  return {
    id: "win_1",
    source: "codex",
    session_id: "ses_1",
    project_tag: "archfill/tsumugi",
    status: "pending",
    cutoff_at: new Date("2026-07-13T00:00:01Z"),
    capture_count: 2,
    raw_chars: 100,
    completed_turns: 1,
    fallback: false,
    input_content: "[User]\nImplement durable capture promotion.",
    attempt_count: 0,
    next_attempt_at: new Date("2026-07-13T00:00:02Z"),
    lease_expires_at: null,
    last_error: null,
    observation_id: null,
    created_at: new Date("2026-07-13T00:00:02Z"),
    updated_at: new Date("2026-07-13T00:00:02Z"),
    completed_at: null,
    ...overrides,
  };
}

function claimedWindow(window = promotionWindow()) {
  return promotionWindow({
    ...window,
    status: "processing",
    attempt_count: Number(window.attempt_count) + 1,
    lease_expires_at: new Date("2026-07-13T00:10:00Z"),
  });
}

describe("promoteCaptures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withPgAdvisoryLockMock.mockImplementation(
      async (_lockName: string, onLocked: () => Promise<unknown>) =>
        await onLocked(),
    );
    captureRepoMock.listReady.mockResolvedValue([]);
    captureRepoMock.listForWindow.mockResolvedValue([]);
    captureRepoMock.deletePromoted.mockResolvedValue(0);
    capturePromotionWindowRepoMock.create.mockResolvedValue(undefined);
    capturePromotionWindowRepoMock.listEligible.mockResolvedValue([]);
    capturePromotionWindowRepoMock.claim.mockResolvedValue(null);
    capturePromotionWindowRepoMock.complete.mockResolvedValue(undefined);
    capturePromotionWindowRepoMock.skip.mockResolvedValue(undefined);
    capturePromotionWindowRepoMock.defer.mockResolvedValue({
      quarantined: false,
      updated: true,
    });
    embedderMock.embed.mockResolvedValue(new Float32Array([0.1, 0.2]));
  });

  it("advisory lock が取れない場合は capture を処理しない", async () => {
    withPgAdvisoryLockMock.mockImplementationOnce(
      async (
        _lockName: string,
        _onLocked: () => Promise<unknown>,
        onBusy: () => Promise<unknown>,
      ) => await onBusy(),
    );

    const result = await promoteCaptures();

    expect(captureRepoMock.listReady).not.toHaveBeenCalled();
    expect(result).toEqual({
      capturesSelected: 0,
      windowsCreated: 0,
      windowsSelected: 0,
      promoted: 0,
      skipped: 0,
      deferred: 0,
      quarantined: 0,
      deletedPromoted: 0,
      runSkipped: true,
      stoppedReason: "active_run_in_progress",
      errors: [],
    });
  });

  it("completed turn を window 化して observation として完了する", async () => {
    const captures = [
      capture("cap_user", "UserPromptSubmit"),
      capture("cap_stop", "Stop"),
    ];
    let createdWindow = promotionWindow();
    captureRepoMock.listReady.mockResolvedValueOnce(captures);
    capturePromotionWindowRepoMock.create.mockImplementationOnce(
      async (row: Record<string, unknown>) => {
        createdWindow = promotionWindow(row);
      },
    );
    capturePromotionWindowRepoMock.listEligible.mockImplementationOnce(
      async () => [createdWindow],
    );
    let claimed = claimedWindow();
    capturePromotionWindowRepoMock.claim.mockImplementationOnce(async () => {
      claimed = claimedWindow(createdWindow);
      return claimed;
    });
    captureRepoMock.listForWindow.mockResolvedValueOnce(captures);
    summarizeObservationMock.mockResolvedValueOnce({
      skip: false,
      narrative: "Capture promotion uses durable windows.",
      facts: ["Capture promotion retries per window."],
      reasoning: "Durable implementation detail.",
    });
    captureRepoMock.deletePromoted.mockResolvedValueOnce(2);

    const result = await promoteCaptures(2);

    expect(capturePromotionWindowRepoMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "codex",
        session_id: "ses_1",
        capture_count: 2,
        completed_turns: 1,
        fallback: false,
      }),
      ["cap_user", "cap_stop"],
    );
    expect(capturePromotionWindowRepoMock.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        window: claimed,
        captureIds: ["cap_user", "cap_stop"],
        observation: expect.objectContaining({
          content: "Capture promotion uses durable windows.",
          source_layer: "capture",
          promotion_state: "processing",
        }),
        facts: [
          expect.objectContaining({
            observation_id: expect.stringMatching(/^obs_/),
            fact: "Capture promotion retries per window.",
            ordinal: 0,
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      capturesSelected: 2,
      windowsCreated: 1,
      windowsSelected: 1,
      promoted: 1,
      skipped: 0,
      deferred: 0,
      deletedPromoted: 2,
      stoppedReason: "completed",
      errors: [],
    });
  });

  it("summary が skip の window を capture ごと skip する", async () => {
    const window = promotionWindow();
    const claimed = claimedWindow(window);
    const captures = [capture("cap_user"), capture("cap_stop")];
    capturePromotionWindowRepoMock.listEligible.mockResolvedValueOnce([window]);
    capturePromotionWindowRepoMock.claim.mockResolvedValueOnce(claimed);
    captureRepoMock.listForWindow.mockResolvedValueOnce(captures);
    summarizeObservationMock.mockResolvedValueOnce({
      skip: true,
      narrative: "",
      facts: [],
      reasoning: "Acknowledgement only.",
    });

    const result = await promoteCaptures();

    expect(capturePromotionWindowRepoMock.skip).toHaveBeenCalledWith(
      claimed,
      ["cap_user", "cap_stop"],
      "Acknowledgement only.",
    );
    expect(capturePromotionWindowRepoMock.complete).not.toHaveBeenCalled();
    expect(embedderMock.embed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      windowsSelected: 1,
      promoted: 0,
      skipped: 1,
      deferred: 0,
      stoppedReason: "completed",
    });
  });

  it("window 処理失敗を削除せず defer する", async () => {
    const window = promotionWindow();
    const claimed = claimedWindow(window);
    capturePromotionWindowRepoMock.listEligible.mockResolvedValueOnce([window]);
    capturePromotionWindowRepoMock.claim.mockResolvedValueOnce(claimed);
    captureRepoMock.listForWindow.mockResolvedValueOnce([capture("cap_stop")]);
    summarizeObservationMock.mockRejectedValueOnce(new Error("LLM unavailable"));

    const result = await promoteCaptures();

    expect(capturePromotionWindowRepoMock.defer).toHaveBeenCalledWith(
      claimed,
      "LLM unavailable",
    );
    expect(capturePromotionWindowRepoMock.complete).not.toHaveBeenCalled();
    expect(capturePromotionWindowRepoMock.skip).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      windowsSelected: 1,
      promoted: 0,
      skipped: 0,
      deferred: 1,
      quarantined: 0,
      errors: ["window(win_1): LLM unavailable"],
    });
  });
});
