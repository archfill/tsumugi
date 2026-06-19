import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryRepoMock = vi.hoisted(() => ({
  findById: vi.fn(),
  markOutdated: vi.fn(),
}));

vi.mock("../../src/data/repos/memory.js", () => ({
  memoryRepo: memoryRepoMock,
}));

const { markMemoryOutdated } = await import(
  "../../src/core/memory/mark-outdated.js"
);

describe("markMemoryOutdated", () => {
  beforeEach(() => {
    memoryRepoMock.findById.mockReset();
    memoryRepoMock.markOutdated.mockReset();
  });

  it("active memory を outdated としてマークする", async () => {
    memoryRepoMock.findById.mockResolvedValueOnce({
      id: "mem_1",
      archived_at: null,
    });

    const result = await markMemoryOutdated({
      memory_id: "mem_1",
      reason: "project decision was superseded",
    });

    expect(memoryRepoMock.markOutdated).toHaveBeenCalledWith(
      "mem_1",
      "project decision was superseded",
    );
    expect(result).toEqual({ memory_id: "mem_1", outdated: true });
  });

  it("archived memory は not found として扱う", async () => {
    memoryRepoMock.findById.mockResolvedValueOnce({
      id: "mem_1",
      archived_at: new Date("2026-06-19T00:00:00Z"),
    });

    await expect(
      markMemoryOutdated({
        memory_id: "mem_1",
        reason: "project decision was superseded",
      }),
    ).rejects.toThrow("memory not found: mem_1");
    expect(memoryRepoMock.markOutdated).not.toHaveBeenCalled();
  });
});
