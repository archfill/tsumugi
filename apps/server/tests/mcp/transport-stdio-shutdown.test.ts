import { beforeEach, describe, expect, it, vi } from "vitest";

const transportMock = vi.hoisted(() => ({ close: vi.fn() }));
const connectMock = vi.hoisted(() => vi.fn());
const coordinatorMock = vi.hoisted(() => ({
  drain: vi.fn(),
  getRunningJobs: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(() => transportMock),
}));
vi.mock("../../src/interfaces/mcp/server.js", () => ({
  createMcpServer: () => ({ connect: connectMock }),
}));
vi.mock("../../src/core/dreaming/execution.js", () => ({
  dreamingExecutionCoordinator: coordinatorMock,
}));

const { startStdio } = await import(
  "../../src/interfaces/mcp/transport-stdio.js"
);

describe("stdio runtime shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue(undefined);
    transportMock.close.mockResolvedValue(undefined);
    coordinatorMock.drain.mockResolvedValue({ drained: true, runningJobs: [] });
    coordinatorMock.getRunningJobs.mockReturnValue([]);
  });

  it("closes input and drains dreaming executions once", async () => {
    const runtime = await startStdio(30_000);

    const first = runtime.shutdown();
    const second = runtime.shutdown();

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ drained: true, runningJobs: [] });
    expect(transportMock.close).toHaveBeenCalledOnce();
    expect(coordinatorMock.drain).toHaveBeenCalledWith(30_000);
  });
});
