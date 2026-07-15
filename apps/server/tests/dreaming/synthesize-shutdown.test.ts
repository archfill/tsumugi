import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryRepoMock = vi.hoisted(() => ({
  listLlmEligible: vi.fn(),
  insert: vi.fn(),
  archive: vi.fn(),
  recordLlmFailure: vi.fn(),
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

vi.mock("../../src/data/repos/memory.js", () => ({
  memoryRepo: memoryRepoMock,
}));
vi.mock("../../src/data/repos/link.js", () => ({
  linkRepo: { insert: vi.fn() },
}));
vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: dreamingRunRepoMock,
}));
vi.mock("../../src/external/llm/index.js", () => ({
  getLlm: () => llmMock,
}));
vi.mock("../../src/external/llm/singleton.js", () => ({
  assertLlmAvailable: vi.fn(),
}));
vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => ({ embed: vi.fn() }),
}));

const { synthesizeMemories } = await import(
  "../../src/core/dreaming/synthesize.js"
);

describe("synthesize shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    memoryRepoMock.listLlmEligible.mockResolvedValue([
      { id: "mem_1", narrative: "one", importance: 5, embedding: [1, 0] },
      { id: "mem_2", narrative: "two", importance: 4, embedding: [1, 0] },
    ]);
  });

  it("does not start another cluster after shutdown is requested", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await synthesizeMemories({ signal: controller.signal });

    expect(llmMock.completeJson).not.toHaveBeenCalled();
    expect(memoryRepoMock.insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      clustersFound: 1,
      newMemoriesCreated: 0,
      stoppedReason: "shutdown_requested",
      errors: [],
    });
    expect(dreamingRunRepoMock.markPartial).toHaveBeenCalledWith(
      result.runId,
      0,
      "synthesize stopped: shutdown_requested",
      { errors: [], stoppedReason: "shutdown_requested" },
    );
  });
});
