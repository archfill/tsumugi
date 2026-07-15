import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchedulerConfig } from "../../src/lib/config.js";

const cronState = vi.hoisted(() => ({
  callbacks: [] as Array<() => void>,
  tasks: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
}));
const runDreamingMock = vi.hoisted(() => vi.fn());

vi.mock("node-cron", () => ({
  validate: vi.fn(() => true),
  schedule: vi.fn((_expression: string, callback: () => void) => {
    const task = { start: vi.fn(), stop: vi.fn() };
    cronState.callbacks.push(callback);
    cronState.tasks.push(task);
    return task;
  }),
}));

vi.mock("../../src/core/dreaming/runner.js", () => ({
  runDreaming: runDreamingMock,
}));

const { startScheduler } = await import(
  "../../src/core/dreaming/scheduler.js"
);

const config: SchedulerConfig = {
  enabled: true,
  promoteCaptures: "0,30 * * * *",
  promoteObservations: "",
  sweepCaptures: "",
  synthesize: "",
  timeUpdate: "",
  decisionContradiction: "",
};

function completedRun() {
  return {
    job: "promote-captures" as const,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    steps: [{ name: "promote-captures", ok: true }],
  };
}

describe("dreaming scheduler shutdown", () => {
  beforeEach(() => {
    cronState.callbacks.length = 0;
    cronState.tasks.length = 0;
    runDreamingMock.mockReset();
  });

  it("stops cron and signals the running job", async () => {
    let finishRun:
      | ((value: ReturnType<typeof completedRun>) => void)
      | undefined;
    const run = new Promise<ReturnType<typeof completedRun>>((resolve) => {
      finishRun = resolve;
    });
    runDreamingMock.mockReturnValueOnce(run);
    const scheduler = startScheduler(config)!;

    cronState.callbacks[0]!();
    scheduler.stop();

    expect(cronState.tasks[0]!.stop).toHaveBeenCalledOnce();
    expect(runDreamingMock).toHaveBeenCalledWith({
      job: "promote-captures",
      signal: expect.any(AbortSignal),
    });
    expect(runDreamingMock.mock.calls[0]![0].signal.aborted).toBe(true);

    finishRun!(completedRun());
    await run;
  });

  it("does not overlap the same job", async () => {
    let finishRun:
      | ((value: ReturnType<typeof completedRun>) => void)
      | undefined;
    const run = new Promise<ReturnType<typeof completedRun>>((resolve) => {
      finishRun = resolve;
    });
    runDreamingMock.mockReturnValueOnce(run);
    startScheduler(config);

    cronState.callbacks[0]!();
    cronState.callbacks[0]!();

    expect(runDreamingMock).toHaveBeenCalledOnce();
    finishRun!(completedRun());
    await run;
  });

  it("does not start a queued callback after shutdown begins", () => {
    const scheduler = startScheduler(config)!;

    scheduler.stop();
    cronState.callbacks[0]!();

    expect(runDreamingMock).not.toHaveBeenCalled();
    expect(cronState.tasks[0]!.stop).toHaveBeenCalledOnce();
  });
});
