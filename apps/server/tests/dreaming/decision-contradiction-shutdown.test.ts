import { beforeEach, describe, expect, it, vi } from "vitest";

const decisionRepoMock = vi.hoisted(() => ({
  listByStatus: vi.fn(),
  supersede: vi.fn(),
}));
const dreamingRunRepoMock = vi.hoisted(() => ({
  insert: vi.fn(),
  markRunning: vi.fn(),
  update: vi.fn(),
  markCompleted: vi.fn(),
  markPartial: vi.fn(),
  markFailed: vi.fn(),
}));
const llmMock = vi.hoisted(() => ({ completeJson: vi.fn() }));

vi.mock("../../src/data/repos/decision.js", () => ({
  decisionRepo: decisionRepoMock,
}));
vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: dreamingRunRepoMock,
}));
vi.mock("../../src/external/llm/index.js", () => ({
  getLlm: () => llmMock,
}));

const { detectDecisionContradictions } = await import(
  "../../src/core/dreaming/decision-contradiction.js"
);

describe("decision contradiction shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decisionRepoMock.listByStatus.mockResolvedValue([
      {
        id: "dec_1",
        content: "Use the old approach",
        created_at: new Date("2026-07-01T00:00:00Z"),
      },
      {
        id: "dec_2",
        content: "Use the new approach",
        created_at: new Date("2026-07-02T00:00:00Z"),
      },
    ]);
  });

  it("does not start the LLM comparison after shutdown is requested", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await detectDecisionContradictions({
      signal: controller.signal,
    });

    expect(llmMock.completeJson).not.toHaveBeenCalled();
    expect(decisionRepoMock.supersede).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scanned: 2,
      supersededCount: 0,
      stoppedReason: "shutdown_requested",
      errors: [],
    });
    expect(dreamingRunRepoMock.markPartial).toHaveBeenCalledWith(
      result.runId,
      0,
      "decision-contradiction stopped: shutdown_requested",
      { stoppedReason: "shutdown_requested" },
    );
  });
});
