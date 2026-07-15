import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const heartbeatOwnedRunningMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: { heartbeatOwnedRunning: heartbeatOwnedRunningMock },
}));

import { DreamingExecutionCoordinator } from "../../src/core/dreaming/execution.js";

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: (value: T) => resolve!(value) };
}

describe("DreamingExecutionCoordinator", () => {
  beforeEach(() => {
    heartbeatOwnedRunningMock.mockReset();
    heartbeatOwnedRunningMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signals and waits for every tracked execution", async () => {
    const coordinator = new DreamingExecutionCoordinator();
    const pending = deferred<string>();
    let executionSignal: AbortSignal | undefined;
    const execution = coordinator.run(
      "promote-observations",
      undefined,
      async (signal) => {
        executionSignal = signal;
        return await pending.promise;
      },
    );

    const drain = coordinator.drain(1_000);
    expect(executionSignal?.aborted).toBe(true);

    pending.resolve("done");
    await expect(execution).resolves.toBe("done");
    await expect(drain).resolves.toEqual({ drained: true, runningJobs: [] });
  });

  it("reports unfinished executions after the deadline", async () => {
    const coordinator = new DreamingExecutionCoordinator();
    const pending = deferred<void>();
    const execution = coordinator.run(
      "synthesize",
      undefined,
      async () => await pending.promise,
    );

    await expect(coordinator.drain(5)).resolves.toEqual({
      drained: false,
      runningJobs: ["synthesize"],
    });
    await expect(
      coordinator.run("promote-captures", undefined, async () => undefined),
    ).rejects.toThrow("dreaming execution rejected during shutdown");

    pending.resolve();
    await execution;
  });

  it("heartbeats while work is active and stops when it settles", async () => {
    vi.useFakeTimers();
    const coordinator = new DreamingExecutionCoordinator();
    const pending = deferred<void>();
    const execution = coordinator.run(
      "reflection",
      undefined,
      async () => await pending.promise,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeatOwnedRunningMock).toHaveBeenCalledOnce();

    pending.resolve();
    await execution;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeatOwnedRunningMock).toHaveBeenCalledOnce();
  });
});
