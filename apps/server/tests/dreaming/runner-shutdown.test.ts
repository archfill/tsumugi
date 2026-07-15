import { beforeEach, describe, expect, it, vi } from "vitest";

const controller = new AbortController();
const promoteCapturesMock = vi.hoisted(() => vi.fn());
const promoteObservationsMock = vi.hoisted(() => vi.fn());
const synthesizeMemoriesMock = vi.hoisted(() => vi.fn());
const timeAwareMemoryUpdateMock = vi.hoisted(() => vi.fn());
const detectDecisionContradictionsMock = vi.hoisted(() => vi.fn());
const dreamingRunRepoMock = vi.hoisted(() => ({
  insert: vi.fn(),
  markRunning: vi.fn(),
  markCompleted: vi.fn(),
  markPartial: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock("../../src/core/capture/promote.js", () => ({
  promoteCaptures: promoteCapturesMock,
}));
vi.mock("../../src/core/observation/promote.js", () => ({
  promoteObservations: promoteObservationsMock,
}));
vi.mock("../../src/core/dreaming/synthesize.js", () => ({
  synthesizeMemories: synthesizeMemoriesMock,
}));
vi.mock("../../src/core/dreaming/time-update.js", () => ({
  timeAwareMemoryUpdate: timeAwareMemoryUpdateMock,
}));
vi.mock("../../src/core/dreaming/decision-contradiction.js", () => ({
  detectDecisionContradictions: detectDecisionContradictionsMock,
}));
vi.mock("../../src/core/dreaming/reflection.js", () => ({
  reflectOnSession: vi.fn(),
}));
vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: dreamingRunRepoMock,
}));
vi.mock("../../src/data/repos/capture.js", () => ({
  captureRepo: {
    deletePromoted: vi.fn(),
    sweepExpired: vi.fn(),
  },
}));
vi.mock("../../src/data/repos/capture-promotion-window.js", () => ({
  capturePromotionWindowRepo: { clearExpiredContent: vi.fn() },
}));
vi.mock("../../src/lib/metrics.js", () => ({
  dreamingRunDurationSeconds: { observe: vi.fn() },
  dreamingRunsTotal: { inc: vi.fn() },
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
vi.mock("../../src/core/dreaming/recover.js", () => ({
  recoverStaleDreamingRuns: vi.fn().mockResolvedValue(0),
}));

const { runDreaming } = await import("../../src/core/dreaming/runner.js");

describe("runDreaming full shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not start a later step after the current step observes shutdown", async () => {
    promoteCapturesMock.mockImplementation(async () => {
      controller.abort();
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
        stoppedReason: "shutdown_requested",
        errors: [],
      };
    });

    const result = await runDreaming({
      job: "full",
      signal: controller.signal,
    });

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      name: "promote-captures",
      ok: false,
    });
    expect(promoteObservationsMock).not.toHaveBeenCalled();
    expect(synthesizeMemoriesMock).not.toHaveBeenCalled();
    expect(timeAwareMemoryUpdateMock).not.toHaveBeenCalled();
    expect(detectDecisionContradictionsMock).not.toHaveBeenCalled();
  });
});
