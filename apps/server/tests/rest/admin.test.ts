import { beforeEach, describe, expect, it, vi } from "vitest";

const adminRepoMock = vi.hoisted(() => ({
  getFilterOptions: vi.fn(),
  getOverview: vi.fn(),
  listPipelineTraces: vi.fn(),
  getPipelineTrace: vi.fn(),
  listOperationIssues: vi.fn(),
  listMemories: vi.fn(),
}));

const memoryRepoMock = vi.hoisted(() => ({
  listActive: vi.fn(),
  countActive: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
}));

const observationRepoMock = vi.hoisted(() => ({
  listRecent: vi.fn(),
  countAll: vi.fn(),
  deleteById: vi.fn(),
}));

const decisionRepoMock = vi.hoisted(() => ({
  listRecent: vi.fn(),
  countAll: vi.fn(),
}));

const linkRepoMock = vi.hoisted(() => ({
  listRecent: vi.fn(),
  countAll: vi.fn(),
}));

const dreamingRunRepoMock = vi.hoisted(() => ({
  listRecent: vi.fn(),
  countAll: vi.fn(),
}));

const getActiveSchedulerMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/admin.js", () => ({
  adminRepo: adminRepoMock,
}));
vi.mock("../../src/data/repos/memory.js", () => ({
  memoryRepo: memoryRepoMock,
}));
vi.mock("../../src/data/repos/observation.js", () => ({
  observationRepo: observationRepoMock,
}));
vi.mock("../../src/data/repos/decision.js", () => ({
  decisionRepo: decisionRepoMock,
}));
vi.mock("../../src/data/repos/link.js", () => ({
  linkRepo: linkRepoMock,
}));
vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: dreamingRunRepoMock,
}));
vi.mock("../../src/interfaces/mcp/transport-http.js", () => ({
  getActiveScheduler: getActiveSchedulerMock,
}));
vi.mock("../../src/core/dreaming/runner.js", () => ({
  runDreaming: vi.fn(),
}));
vi.mock("../../src/core/capture/save.js", () => ({ saveCapture: vi.fn() }));
vi.mock("../../src/core/capture/continuity.js", () => ({
  getCaptureContinuity: vi.fn(),
}));
vi.mock("../../src/core/search/hybrid.js", () => ({ hybridSearch: vi.fn() }));
vi.mock("../../src/core/search/resolve-filter.js", () => ({
  resolveSearchFilter: vi.fn(),
}));

const { restApp } = await import("../../src/interfaces/rest/routes.js");

describe("Admin REST read contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryRepoMock.listActive.mockResolvedValue([]);
    memoryRepoMock.countActive.mockResolvedValue(0);
    adminRepoMock.getFilterOptions.mockResolvedValue({
      projects: ["tsumugi"],
      sources: ["codex"],
      states: { pipeline: [], memories: [], operations: [] },
    });
    adminRepoMock.getOverview.mockResolvedValue({
      generated_at: "2026-07-13T00:00:00.000Z",
      layers: [],
      queues: [],
      attention_count: 0,
    });
    adminRepoMock.listPipelineTraces.mockResolvedValue({
      traces: [],
      next_cursor: null,
    });
    adminRepoMock.listOperationIssues.mockResolvedValue({
      issues: [],
      next_cursor: null,
    });
    getActiveSchedulerMock.mockReturnValue({
      jobs: [{ job: "promote-captures", cronExpr: "0,30 * * * *" }],
    });
  });

  it("overviewへproject/source/期間filterを型付きで渡す", async () => {
    const response = await restApp.request(
      "/admin/overview?project=tsumugi&source=codex&from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-13T23%3A59%3A59.999Z",
    );

    expect(response.status).toBe(200);
    expect(adminRepoMock.getOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "tsumugi",
        source: "codex",
        from: new Date("2026-07-01T00:00:00.000Z"),
        to: new Date("2026-07-13T23:59:59.999Z"),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      scheduler: {
        enabled: true,
        jobs: [{ job: "promote-captures" }],
      },
    });
  });

  it("不正なsourceは400にする", async () => {
    const response = await restApp.request(
      "/admin/pipeline/traces?source=unknown",
    );

    expect(response.status).toBe(400);
    expect(adminRepoMock.listPipelineTraces).not.toHaveBeenCalled();
  });

  it("存在しないtraceは404にする", async () => {
    adminRepoMock.getPipelineTrace.mockResolvedValue(null);

    const response = await restApp.request(
      "/admin/pipeline/traces/win_missing",
    );

    expect(response.status).toBe(404);
  });

  it("filtered memory listはprovenance-aware admin queryを使う", async () => {
    adminRepoMock.listMemories.mockResolvedValue({ memories: [], total: 0 });

    const response = await restApp.request(
      "/memories?project=tsumugi&state=outdated&limit=25&offset=50",
    );

    expect(response.status).toBe(200);
    expect(adminRepoMock.listMemories).toHaveBeenCalledWith(
      expect.objectContaining({ project: "tsumugi", state: "outdated" }),
      25,
      50,
    );
    expect(memoryRepoMock.listActive).not.toHaveBeenCalled();
  });

  it("既存memory list contractはfilterなしなら維持する", async () => {
    const response = await restApp.request("/memories?limit=20");

    expect(response.status).toBe(200);
    expect(memoryRepoMock.listActive).toHaveBeenCalledWith(20, 0);
    expect(adminRepoMock.listMemories).not.toHaveBeenCalled();
  });

  it("operation issueでattemptとitem failureを分離して返す", async () => {
    adminRepoMock.listOperationIssues.mockResolvedValueOnce({
      issues: [
        {
          id: "fact_1",
          kind: "fact",
          state: "deferred",
          project_tag: "tsumugi",
          source: "codex",
          occurred_at: "2026-07-13T00:00:00.000Z",
          attempt_count: 7,
          failure_count: 2,
          summary: "durable fact",
          last_error: "malformed response",
        },
      ],
      next_cursor: null,
    });

    const response = await restApp.request("/admin/operations/issues");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issues: [
        {
          id: "fact_1",
          attempt_count: 7,
          failure_count: 2,
        },
      ],
    });
  });
});
