import { beforeEach, describe, expect, it, vi } from "vitest";

const captureRepoMock = vi.hoisted(() => ({
  listUnpromoted: vi.fn(),
  markPromoted: vi.fn(),
  markSkipped: vi.fn(),
  deletePromoted: vi.fn(),
}));

const observationRepoMock = vi.hoisted(() => ({
  insert: vi.fn(),
  markPromoted: vi.fn(),
}));

const embedderMock = vi.hoisted(() => ({
  embed: vi.fn(),
}));

const summarizeObservationMock = vi.hoisted(() => vi.fn());
const audnJudgeMock = vi.hoisted(() => vi.fn());
const withPgAdvisoryLockMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/capture.js", () => ({
  captureRepo: captureRepoMock,
}));

vi.mock("../../src/data/repos/observation.js", () => ({
  observationRepo: observationRepoMock,
}));

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => embedderMock,
}));

vi.mock("../../src/core/observation/summarize.js", () => ({
  summarizeObservation: summarizeObservationMock,
}));

vi.mock("../../src/core/dreaming/audn.js", () => ({
  audnJudge: audnJudgeMock,
}));

vi.mock("../../src/data/advisory-lock.js", () => ({
  withPgAdvisoryLock: withPgAdvisoryLockMock,
}));

const { promoteCaptures } = await import("../../src/core/capture/promote.js");

function capture(id: string) {
  return {
    id,
    session_id: "ses_1",
    project_tag: "archfill/tsumugi",
    source: "codex",
    hook_event: "UserPromptSubmit",
    tool_name: null,
    raw_content: "次はcapture promotionを直す",
    captured_at: new Date("2026-07-06T00:00:00Z"),
    expires_at: new Date("2026-08-05T00:00:00Z"),
    promoted_to_obs_id: null,
    promoted_at: null,
    skip_reason: null,
  };
}

describe("promoteCaptures", () => {
  beforeEach(() => {
    captureRepoMock.listUnpromoted.mockReset();
    captureRepoMock.markPromoted.mockReset();
    captureRepoMock.markSkipped.mockReset();
    captureRepoMock.deletePromoted.mockReset();
    observationRepoMock.insert.mockReset();
    observationRepoMock.markPromoted.mockReset();
    embedderMock.embed.mockReset();
    summarizeObservationMock.mockReset();
    audnJudgeMock.mockReset();
    withPgAdvisoryLockMock.mockReset();

    withPgAdvisoryLockMock.mockImplementation(
      async (_lockName: string, onLocked: () => Promise<unknown>) =>
        await onLocked(),
    );
    captureRepoMock.deletePromoted.mockResolvedValue(0);
    embedderMock.embed.mockResolvedValue(new Float32Array([0.1, 0.2]));
    audnJudgeMock.mockResolvedValue({ action: "add", memoryId: "mem_1" });
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

    expect(withPgAdvisoryLockMock).toHaveBeenCalledWith(
      "tsumugi:promote-captures",
      expect.any(Function),
      expect.any(Function),
    );
    expect(captureRepoMock.listUnpromoted).not.toHaveBeenCalled();
    expect(observationRepoMock.insert).not.toHaveBeenCalled();
    expect(result).toEqual({
      total: 0,
      promoted: 0,
      skipped: 0,
      deletedPromoted: 0,
      runSkipped: true,
      stoppedReason: "active_run_in_progress",
      errors: [],
    });
  });

  it("promoted capture の全件削除は batch の最後に一度だけ行う", async () => {
    captureRepoMock.listUnpromoted.mockResolvedValueOnce([capture("cap_1")]);
    summarizeObservationMock.mockResolvedValueOnce({
      skip: false,
      narrative: "capture promotionを重複しないように修正する",
      facts: ["capture promotion uses advisory lock"],
      reasoning: "durable implementation detail",
    });
    captureRepoMock.deletePromoted.mockResolvedValueOnce(1);

    const result = await promoteCaptures(1);

    expect(observationRepoMock.insert).toHaveBeenCalledTimes(1);
    expect(captureRepoMock.markPromoted).toHaveBeenCalledTimes(1);
    expect(captureRepoMock.deletePromoted).toHaveBeenCalledTimes(1);
    expect(captureRepoMock.deletePromoted).toHaveBeenCalledAfter(
      captureRepoMock.markPromoted,
    );
    expect(result).toMatchObject({
      total: 1,
      promoted: 1,
      skipped: 0,
      deletedPromoted: 1,
      runSkipped: false,
      stoppedReason: "completed",
      errors: [],
    });
  });

  it("skip だけの batch でも promoted capture の掃除は最後に一度だけ行う", async () => {
    captureRepoMock.listUnpromoted.mockResolvedValueOnce([capture("cap_1")]);
    summarizeObservationMock.mockResolvedValueOnce({
      skip: true,
      narrative: "",
      facts: [],
      reasoning: "ack-only prompt",
    });

    const result = await promoteCaptures(1);

    expect(captureRepoMock.markSkipped).toHaveBeenCalledWith(
      "cap_1",
      "ack-only prompt",
    );
    expect(observationRepoMock.insert).not.toHaveBeenCalled();
    expect(captureRepoMock.deletePromoted).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      total: 1,
      promoted: 0,
      skipped: 1,
      runSkipped: false,
      stoppedReason: "completed",
    });
  });
});
