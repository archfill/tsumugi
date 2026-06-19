import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryRepoMock = vi.hoisted(() => ({
  archiveOutdated: vi.fn(),
  listLlmEligible: vi.fn(),
}));

const dreamingRunRepoMock = vi.hoisted(() => ({
  insert: vi.fn(),
  markRunning: vi.fn(),
  update: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock("../../src/data/repos/memory.js", () => ({
  memoryRepo: memoryRepoMock,
}));

vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: dreamingRunRepoMock,
}));

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => ({
    embed: vi.fn(),
  }),
}));

vi.mock("../../src/external/llm/index.js", () => ({
  getLlm: () => ({
    completeJson: vi.fn(),
  }),
}));

const { timeAwareMemoryUpdate } = await import(
  "../../src/core/dreaming/time-update.js"
);

describe("timeAwareMemoryUpdate outdated handling", () => {
  beforeEach(() => {
    memoryRepoMock.archiveOutdated.mockReset();
    memoryRepoMock.listLlmEligible.mockReset();
    dreamingRunRepoMock.insert.mockReset();
    dreamingRunRepoMock.markRunning.mockReset();
    dreamingRunRepoMock.update.mockReset();
    dreamingRunRepoMock.markCompleted.mockReset();
    dreamingRunRepoMock.markFailed.mockReset();
  });

  it("outdated memory を dreaming maintenance pass で archive する", async () => {
    memoryRepoMock.archiveOutdated.mockResolvedValueOnce(2);
    memoryRepoMock.listLlmEligible.mockResolvedValueOnce([]);

    const result = await timeAwareMemoryUpdate({
      maxMemories: 10,
      maxUpdates: 3,
    });

    expect(memoryRepoMock.archiveOutdated).toHaveBeenCalledWith(10);
    expect(memoryRepoMock.listLlmEligible).toHaveBeenCalledWith(10);
    expect(dreamingRunRepoMock.markCompleted).toHaveBeenCalledWith(
      result.runId,
      2,
    );
    expect(result).toMatchObject({
      scanned: 0,
      updated: 0,
      archivedOutdated: 2,
      errors: [],
    });
  });
});
