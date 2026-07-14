import { beforeEach, describe, expect, it, vi } from "vitest";

const completeJsonMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/external/llm/index.js", () => ({
  getLlm: () => ({ completeJson: completeJsonMock }),
}));

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: vi.fn(),
}));

vi.mock("../../src/core/search/hybrid.js", () => ({
  hybridSearch: vi.fn(),
}));

vi.mock("../../src/data/repos/memory.js", () => ({
  memoryRepo: {},
}));

vi.mock("../../src/data/repos/link.js", () => ({
  linkRepo: {},
}));

const { judgeOnly } = await import("../../src/core/dreaming/audn.js");

describe("judgeOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("thinkingを使うAUDNへ8192 tokenを割り当てる", async () => {
    completeJsonMock.mockResolvedValueOnce({
      decision: "NOOP",
      target_index: null,
      new_narrative: null,
      reasoning: "already represented",
    });

    await judgeOnly({
      newFact: "A durable fact.",
      existingMemoryNarratives: ["An existing memory."],
    });

    expect(completeJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 8192 }),
    );
  });

  it("不正shapeの本文をerrorへ含めない", async () => {
    completeJsonMock.mockResolvedValueOnce({
      decision: "UPDATE",
      target_index: 0,
      new_narrative: "sensitive generated narrative",
    });

    let thrown: unknown;
    try {
      await judgeOnly({
        newFact: "A durable fact.",
        existingMemoryNarratives: ["An existing memory."],
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      "AUDN LLM returned unexpected JSON shape (decision=string,target_index=number,new_narrative=string,reasoning=missing)",
    );
    expect((thrown as Error).message).not.toContain(
      "sensitive generated narrative",
    );
  });
});
