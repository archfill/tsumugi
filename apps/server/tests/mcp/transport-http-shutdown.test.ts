import { beforeEach, describe, expect, it, vi } from "vitest";

const serverMock = vi.hoisted(() => ({
  close: vi.fn((callback: (error?: Error) => void) => callback()),
  closeIdleConnections: vi.fn(),
  closeAllConnections: vi.fn(),
  fetch: undefined as ((request: Request) => Promise<Response>) | undefined,
}));
const schedulerMock = vi.hoisted(() => ({
  jobs: [{ job: "promote-captures", cronExpr: "0,30 * * * *" }],
  stop: vi.fn(),
}));
const coordinatorMock = vi.hoisted(() => ({
  drain: vi.fn(),
  getRunningJobs: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(({ fetch }) => {
    serverMock.fetch = fetch;
    return serverMock;
  }),
}));

vi.mock("../../src/core/dreaming/scheduler.js", () => ({
  startScheduler: vi.fn((config: { enabled: boolean }) =>
    config.enabled ? schedulerMock : null,
  ),
}));

vi.mock("../../src/core/dreaming/execution.js", () => ({
  dreamingExecutionCoordinator: coordinatorMock,
}));

vi.mock("../../src/data/client.js", () => ({
  db: { execute: vi.fn() },
}));

const { getActiveScheduler, startHttp } = await import(
  "../../src/interfaces/mcp/transport-http.js"
);

describe("HTTP runtime shutdown", () => {
  beforeEach(() => {
    serverMock.close.mockReset();
    serverMock.close.mockImplementation((callback) => callback());
    serverMock.closeIdleConnections.mockReset();
    serverMock.closeAllConnections.mockReset();
    serverMock.fetch = undefined;
    schedulerMock.stop.mockReset();
    coordinatorMock.drain.mockReset();
    coordinatorMock.drain.mockResolvedValue({
      drained: true,
      runningJobs: [],
    });
    coordinatorMock.getRunningJobs.mockReturnValue([]);
  });

  it("stops accepting traffic and drains the scheduler once", async () => {
    const runtime = await startHttp(0, {
      scheduler: {
        enabled: true,
        promoteCaptures: "0,30 * * * *",
        promoteObservations: "",
        sweepCaptures: "",
        synthesize: "",
        timeUpdate: "",
        decisionContradiction: "",
      },
      shutdownDrainTimeoutMs: 45_000,
    });

    const first = runtime.shutdown();
    const second = runtime.shutdown();

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ drained: true, runningJobs: [] });
    expect(schedulerMock.stop).toHaveBeenCalledOnce();
    expect(coordinatorMock.drain).toHaveBeenCalledOnce();
    expect(coordinatorMock.drain).toHaveBeenCalledWith(45_000);
    expect(serverMock.close).toHaveBeenCalledOnce();
    expect(getActiveScheduler()).toBeNull();
  });

  it("returns by the deadline when HTTP close remains pending", async () => {
    serverMock.close.mockImplementation(() => undefined);
    coordinatorMock.getRunningJobs.mockReturnValue(["synthesize"]);
    const runtime = await startHttp(0, {
      scheduler: {
        enabled: true,
        promoteCaptures: "",
        promoteObservations: "",
        sweepCaptures: "",
        synthesize: "",
        timeUpdate: "",
        decisionContradiction: "",
      },
      shutdownDrainTimeoutMs: 5,
    });

    await expect(runtime.shutdown()).resolves.toEqual({
      drained: false,
      runningJobs: ["synthesize"],
    });
    expect(serverMock.closeIdleConnections).toHaveBeenCalledOnce();
    expect(serverMock.closeAllConnections).toHaveBeenCalledOnce();
  });

  it("reports healthy when dreaming is intentionally disabled", async () => {
    await startHttp(0, {
      scheduler: {
        enabled: false,
        promoteCaptures: "",
        promoteObservations: "",
        sweepCaptures: "",
        synthesize: "",
        timeUpdate: "",
        decisionContradiction: "",
      },
      shutdownDrainTimeoutMs: 45_000,
    });

    const response = await serverMock.fetch!(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ok",
      components: { scheduler: { ok: true, detail: { enabled: false, jobs: 0 } } },
    });
  });
});
