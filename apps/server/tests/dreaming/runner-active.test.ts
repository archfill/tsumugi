import { beforeEach, describe, expect, it, vi } from "vitest";

const promoteCapturesMock = vi.hoisted(() => vi.fn());
const archiveOutdatedMock = vi.hoisted(() => vi.fn());
const recoverMock = vi.hoisted(() => vi.fn());
const runRepoMock = vi.hoisted(() => ({
  insert: vi.fn(),
  markRunning: vi.fn(),
  markCompleted: vi.fn(),
  markPartial: vi.fn(),
  markFailed: vi.fn(),
}));
const durationObserveMock = vi.hoisted(() => vi.fn());
const runsIncMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/core/capture/promote.js", () => ({
  promoteCaptures: promoteCapturesMock,
}));
vi.mock("../../src/core/dreaming/archive-outdated.js", () => ({
  archiveOutdatedMemories: archiveOutdatedMock,
}));
vi.mock("../../src/core/dreaming/recover.js", () => ({
  recoverStaleDreamingRuns: recoverMock,
}));
vi.mock("../../src/core/dreaming/execution.js", () => ({
  dreamingExecutionCoordinator: {
    run: (
      _job: string,
      signal: AbortSignal | undefined,
      execute: (effectiveSignal: AbortSignal) => Promise<unknown>,
    ) => execute(signal ?? new AbortController().signal),
  },
}));
vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: runRepoMock,
}));
vi.mock("../../src/lib/id.js", () => ({ newId: () => "drun_test" }));
vi.mock("../../src/lib/metrics.js", () => ({
  dreamingRunDurationSeconds: { observe: durationObserveMock },
  dreamingRunsTotal: { inc: runsIncMock },
}));

const { runDreaming } = await import("../../src/core/dreaming/runner.js");

function promotionResult(
  overrides: Record<string, unknown> = {},
) {
  return {
    capturesSelected: 1,
    windowsCreated: 1,
    windowsSelected: 1,
    promoted: 1,
    skipped: 0,
    deferred: 0,
    quarantined: 0,
    deletedPromoted: 0,
    runSkipped: false,
    stoppedReason: "completed",
    errors: [],
    ...overrides,
  };
}

describe("active deterministic dreaming jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recoverMock.mockResolvedValue(0);
    promoteCapturesMock.mockResolvedValue(promotionResult());
  });

  it("promote-capturesをrun recordとownership更新付きで完了する", async () => {
    const result = await runDreaming({
      job: "promote-captures",
      maxCaptures: 25,
    });

    expect(recoverMock).toHaveBeenCalledOnce();
    expect(runRepoMock.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "drun_test",
        job_kind: "promote-captures",
        input_count: 25,
      }),
    );
    expect(runRepoMock.markRunning).toHaveBeenCalledWith("drun_test");
    expect(runRepoMock.markCompleted).toHaveBeenCalledWith(
      "drun_test",
      1,
      expect.objectContaining({ stoppedReason: "completed" }),
    );
    expect(result.steps[0]).toMatchObject({
      name: "promote-captures",
      ok: true,
    });
    expect(runsIncMock).toHaveBeenCalledWith({
      job: "promote-captures",
      status: "success",
    });
  });

  it("budget停止をpartial runとして記録する", async () => {
    promoteCapturesMock.mockResolvedValueOnce(
      promotionResult({
        promoted: 0,
        stoppedReason: "run_budget_exceeded",
      }),
    );

    const result = await runDreaming({ job: "promote-captures" });

    expect(runRepoMock.markPartial).toHaveBeenCalledWith(
      "drun_test",
      0,
      "promotion stopped: run_budget_exceeded",
      expect.objectContaining({ stoppedReason: "run_budget_exceeded" }),
    );
    expect(result.steps[0]?.ok).toBe(false);
  });

  it("archive failureをrun failureとして終端化する", async () => {
    archiveOutdatedMock.mockRejectedValueOnce(new Error("archive failed"));

    const result = await runDreaming({ job: "archive-outdated" });

    expect(runRepoMock.markFailed).toHaveBeenCalledWith(
      "drun_test",
      "archive failed",
    );
    expect(result.steps[0]).toMatchObject({
      name: "archive-outdated",
      ok: false,
      error: "archive failed",
    });
  });
});
