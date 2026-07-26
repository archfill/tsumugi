import { beforeEach, describe, expect, it, vi } from "vitest";

const captureRepoMock = vi.hoisted(() => ({
  listReadyStops: vi.fn(),
  skipEmptyStop: vi.fn(),
  listForWindow: vi.fn(),
  listActiveForWindow: vi.fn(),
  deletePromoted: vi.fn(),
}));
const windowRepoMock = vi.hoisted(() => ({
  createDeterministicStop: vi.fn(),
  listEligibleDeterministicStops: vi.fn(),
  claim: vi.fn(),
  completeDeterministicStop: vi.fn(),
  skip: vi.fn(),
  defer: vi.fn(),
}));
const embedderMock = vi.hoisted(() => ({ embed: vi.fn() }));
const withPgAdvisoryLockMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/capture.js", () => ({
  captureRepo: captureRepoMock,
}));
vi.mock("../../src/data/repos/capture-promotion-window.js", () => ({
  capturePromotionWindowRepo: windowRepoMock,
}));
vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => embedderMock,
}));
vi.mock("../../src/data/advisory-lock.js", () => ({
  withPgAdvisoryLock: withPgAdvisoryLockMock,
}));

const { promoteCaptures } = await import("../../src/core/capture/promote.js");

function stop(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    session_id: "ses_1",
    project_tag: "tsumugi",
    source: "codex",
    hook_event: "Stop",
    tool_name: null,
    turn_id: "turn_1",
    continuity_content: "  deterministic checkpoint  ",
    content_hash: "sha256:content",
    raw_content: '{"last_assistant_message":"must never be used"}',
    captured_at: new Date("2026-07-26T00:00:00Z"),
    expires_at: new Date("2026-08-25T00:00:00Z"),
    promoted_to_obs_id: null,
    promoted_at: null,
    skip_reason: null,
    promotion_state: "ready",
    promotion_window_id: null,
    ...overrides,
  };
}

function window(overrides: Record<string, unknown> = {}) {
  return {
    id: "win_1",
    source: "codex",
    session_id: "ses_1",
    project_tag: "tsumugi",
    promotion_kind: "stop_checkpoint",
    promotion_key: "stop:v1:codex:ses_1:turn_1",
    status: "pending",
    cutoff_at: new Date("2026-07-26T00:00:00Z"),
    capture_count: 1,
    raw_chars: 24,
    completed_turns: 1,
    fallback: false,
    input_content: "deterministic checkpoint",
    attempt_count: 0,
    failure_count: 0,
    next_attempt_at: new Date("2026-07-26T00:00:00Z"),
    lease_expires_at: null,
    last_error: null,
    observation_id: null,
    created_at: new Date("2026-07-26T00:00:00Z"),
    updated_at: new Date("2026-07-26T00:00:00Z"),
    completed_at: null,
    ...overrides,
  };
}

describe("promoteCaptures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withPgAdvisoryLockMock.mockImplementation(
      async (_name: string, onLocked: () => Promise<unknown>) => await onLocked(),
    );
    captureRepoMock.listReadyStops.mockResolvedValue([]);
    captureRepoMock.skipEmptyStop.mockResolvedValue(true);
    captureRepoMock.listForWindow.mockResolvedValue([]);
    captureRepoMock.listActiveForWindow.mockResolvedValue([]);
    captureRepoMock.deletePromoted.mockResolvedValue(0);
    windowRepoMock.createDeterministicStop.mockResolvedValue({
      windowId: "win_1",
      created: true,
    });
    windowRepoMock.listEligibleDeterministicStops.mockResolvedValue([]);
    windowRepoMock.claim.mockResolvedValue(null);
    windowRepoMock.completeDeterministicStop.mockResolvedValue(undefined);
    windowRepoMock.skip.mockResolvedValue(undefined);
    windowRepoMock.defer.mockResolvedValue({ quarantined: false, updated: true });
    embedderMock.embed.mockResolvedValue(new Float32Array([0.1, 0.2]));
  });

  it("Stop を continuity_content のみで1 observationへ決定的に昇格する", async () => {
    const capture = stop("cap_1");
    const eligible = window();
    const claimed = window({ status: "processing", attempt_count: 1 });
    captureRepoMock.listReadyStops.mockResolvedValueOnce([capture]);
    windowRepoMock.listEligibleDeterministicStops
      .mockResolvedValueOnce([eligible])
      .mockResolvedValueOnce([]);
    windowRepoMock.claim.mockResolvedValueOnce(claimed);
    captureRepoMock.listActiveForWindow.mockResolvedValueOnce([capture]);

    const result = await promoteCaptures();

    expect(windowRepoMock.createDeterministicStop).toHaveBeenCalledWith(
      expect.objectContaining({
        promotionKey: "stop:v1:codex:ses_1:turn_1",
        capture: expect.objectContaining({ continuity_content: "deterministic checkpoint" }),
      }),
    );
    expect(embedderMock.embed).toHaveBeenCalledWith("deterministic checkpoint");
    expect(windowRepoMock.completeDeterministicStop).toHaveBeenCalledWith(
      expect.objectContaining({
        window: claimed,
        captureIds: ["cap_1"],
        observation: expect.objectContaining({
          content: "deterministic checkpoint",
          type: "other",
          facts: null,
          source_layer: "capture",
          created_at: capture.captured_at,
          metadata: {
            capture_id: "cap_1",
            turn_id: "turn_1",
            content_hash: "sha256:content",
            hook_event: "Stop",
            promotion_version: "stop:v1",
          },
        }),
      }),
    );
    expect(result).toMatchObject({ promoted: 1, windowsCreated: 1 });
  });

  it("turn_idなしは content_hash を promotion key に使う", async () => {
    captureRepoMock.listReadyStops.mockResolvedValueOnce([
      stop("cap_1", { turn_id: null, content_hash: "sha256:retry" }),
    ]);

    await promoteCaptures();

    expect(windowRepoMock.createDeterministicStop).toHaveBeenCalledWith(
      expect.objectContaining({ promotionKey: "stop:v1:codex:ses_1:sha256:retry" }),
    );
  });

  it("空白・欠損 continuity_content だけをskipし、raw_contentへfallbackしない", async () => {
    captureRepoMock.listReadyStops.mockResolvedValueOnce([
      stop("cap_empty", { continuity_content: "  ", raw_content: "raw fallback" }),
      stop("cap_missing", { continuity_content: null, raw_content: "raw fallback" }),
    ]);

    const result = await promoteCaptures();

    expect(captureRepoMock.skipEmptyStop).toHaveBeenCalledWith("cap_empty");
    expect(captureRepoMock.skipEmptyStop).toHaveBeenCalledWith("cap_missing");
    expect(windowRepoMock.createDeterministicStop).not.toHaveBeenCalled();
    expect(embedderMock.embed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 2 });
  });

  it("同じ promotion key のretry captureは新しいwindowを数えない", async () => {
    captureRepoMock.listReadyStops.mockResolvedValueOnce([stop("cap_retry")]);
    windowRepoMock.createDeterministicStop.mockResolvedValueOnce({
      windowId: "win_existing",
      created: false,
    });

    const result = await promoteCaptures();

    expect(result).toMatchObject({ windowsCreated: 0, promoted: 0 });
  });

  it("quarantineは1回だけ数え、windowed以外の過去captureを処理しない", async () => {
    const capture = stop("cap_1");
    const claimed = window({ status: "processing", attempt_count: 1 });
    captureRepoMock.listReadyStops.mockResolvedValueOnce([capture]);
    windowRepoMock.listEligibleDeterministicStops
      .mockResolvedValueOnce([window()])
      .mockResolvedValueOnce([]);
    windowRepoMock.claim.mockResolvedValueOnce(claimed);
    captureRepoMock.listActiveForWindow.mockResolvedValueOnce([capture]);
    embedderMock.embed.mockRejectedValueOnce(new Error("local embedding failed"));
    windowRepoMock.defer.mockResolvedValueOnce({ quarantined: true, updated: true });

    const result = await promoteCaptures();

    expect(captureRepoMock.listForWindow).not.toHaveBeenCalled();
    expect(result).toMatchObject({ quarantined: 1, deferred: 0 });
  });

  it("advisory lockが取れない場合は処理しない", async () => {
    withPgAdvisoryLockMock.mockImplementationOnce(
      async (_name: string, _onLocked: () => Promise<unknown>, onBusy: () => Promise<unknown>) =>
        await onBusy(),
    );

    const result = await promoteCaptures();

    expect(captureRepoMock.listReadyStops).not.toHaveBeenCalled();
    expect(result.runSkipped).toBe(true);
  });
});
