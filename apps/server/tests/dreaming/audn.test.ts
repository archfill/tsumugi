import { beforeEach, describe, expect, it, vi } from "vitest";

const completeJsonMock = vi.hoisted(() => vi.fn());
const hybridSearchMock = vi.hoisted(() => vi.fn());
const memoryRepoMock = vi.hoisted(() => ({ findById: vi.fn() }));

vi.mock("../../src/external/llm/index.js", () => ({
  getLlm: () => ({ completeJson: completeJsonMock }),
}));

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: vi.fn(),
}));

vi.mock("../../src/core/search/hybrid.js", () => ({
  hybridSearch: hybridSearchMock,
}));

vi.mock("../../src/data/repos/memory.js", () => ({
  memoryRepo: memoryRepoMock,
}));

vi.mock("../../src/data/repos/link.js", () => ({
  linkRepo: {},
}));

const { judgeOnly, judgeOnlyBatch, planAudnBatch } = await import(
  "../../src/core/dreaming/audn.js"
);

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

describe("judgeOnlyBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("候補なしfactをfast-path ADDにして残りを1回で判定する", async () => {
    completeJsonMock.mockResolvedValueOnce({
      judgements: [
        {
          fact_id: "f0",
          decision: "UPDATE",
          target_index: 0,
          new_narrative: "The scheduler now uses node-cron 4.2.1.",
          reasoning: "same scheduler dependency",
        },
        {
          fact_id: "f1",
          decision: "NOOP",
          target_index: null,
          new_narrative: null,
          reasoning: "already represented",
        },
      ],
    });

    const results = await judgeOnlyBatch([
      {
        factId: "fact_add",
        newFact: "Tsumugi uses PostgreSQL 18.",
        existingMemoryNarratives: [],
      },
      {
        factId: "fact_update",
        newFact: "Upgraded node-cron to 4.2.1.",
        existingMemoryNarratives: ["The scheduler uses node-cron 3.x."],
      },
      {
        factId: "fact_noop",
        newFact: "BGE-M3 is the embedding model.",
        existingMemoryNarratives: ["The embedding model is BGE-M3."],
      },
    ]);

    expect(results.map((result) => result.factId)).toEqual([
      "fact_add",
      "fact_update",
      "fact_noop",
    ]);
    expect(results[0]).toMatchObject({
      decision: "ADD",
      newNarrative: "Tsumugi uses PostgreSQL 18.",
    });
    expect(completeJsonMock).toHaveBeenCalledTimes(1);
    expect(completeJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 8192, timeoutMs: 60_000 }),
    );
    const request = completeJsonMock.mock.calls[0]![0] as { user: string };
    expect(request.user).not.toContain("fact_add");
    expect(request.user).not.toContain("fact_update");
    expect(request.user).not.toContain("fact_noop");
    expect(request.user).toContain('"fact_id": "f0"');
  });

  it("全factに候補がなければLLMを呼ばない", async () => {
    const results = await judgeOnlyBatch([
      {
        factId: "fact_1",
        newFact: "A new durable fact.",
        existingMemoryNarratives: [],
      },
      {
        factId: "fact_2",
        newFact: "Another durable fact.",
        existingMemoryNarratives: [],
      },
    ]);

    expect(results.map((result) => result.decision)).toEqual(["ADD", "ADD"]);
    expect(completeJsonMock).not.toHaveBeenCalled();
  });

  it("入力fact_idの重複をLLM呼び出し前に拒否する", async () => {
    await expect(
      judgeOnlyBatch([
        {
          factId: "fact_duplicate",
          newFact: "First fact.",
          existingMemoryNarratives: ["Existing memory."],
        },
        {
          factId: "fact_duplicate",
          newFact: "Second fact.",
          existingMemoryNarratives: ["Existing memory."],
        },
      ]),
    ).rejects.toThrow(
      'AUDN batch input contains duplicate fact_id "fact_duplicate"',
    );
    expect(completeJsonMock).not.toHaveBeenCalled();
  });

  it("出力fact_idの重複を拒否する", async () => {
    completeJsonMock.mockResolvedValueOnce({
      judgements: [
        {
          fact_id: "f0",
          decision: "NOOP",
          target_index: null,
          new_narrative: null,
          reasoning: "represented",
        },
        {
          fact_id: "f0",
          decision: "NOOP",
          target_index: null,
          new_narrative: null,
          reasoning: "represented twice",
        },
      ],
    });

    await expect(
      judgeOnlyBatch([
        {
          factId: "fact_1",
          newFact: "A fact.",
          existingMemoryNarratives: ["A memory."],
        },
      ]),
    ).rejects.toThrow('AUDN batch LLM returned duplicate fact_id "f0"');
  });

  it("入力にないfact_idの出力を拒否する", async () => {
    completeJsonMock.mockResolvedValueOnce({
      judgements: [
        {
          fact_id: "fact_unknown",
          decision: "NOOP",
          target_index: null,
          new_narrative: null,
          reasoning: "represented",
        },
      ],
    });

    await expect(
      judgeOnlyBatch([
        {
          factId: "fact_1",
          newFact: "A fact.",
          existingMemoryNarratives: ["A memory."],
        },
      ]),
    ).rejects.toThrow(
      'AUDN batch LLM returned unknown fact_id "fact_unknown"',
    );
  });

  it("fact_idが欠落した出力を拒否する", async () => {
    completeJsonMock.mockResolvedValueOnce({ judgements: [] });

    await expect(
      judgeOnlyBatch([
        {
          factId: "fact_1",
          newFact: "A fact.",
          existingMemoryNarratives: ["A memory."],
        },
      ]),
    ).rejects.toThrow('AUDN batch LLM omitted fact_id "fact_1"');
  });

  it("UPDATE/DELETEの範囲外target_indexを拒否する", async () => {
    completeJsonMock.mockResolvedValueOnce({
      judgements: [
        {
          fact_id: "f0",
          decision: "UPDATE",
          target_index: 2,
          new_narrative: "Updated memory.",
          reasoning: "same subject",
        },
      ],
    });

    await expect(
      judgeOnlyBatch([
        {
          factId: "fact_1",
          newFact: "Updated fact.",
          existingMemoryNarratives: ["Old fact."],
        },
      ]),
    ).rejects.toThrow(
      'AUDN batch target_index out of range for fact_id "fact_1"',
    );
  });

  it("意味的にnullの省略fieldを正規化する", async () => {
    completeJsonMock.mockResolvedValueOnce({
      judgements: [
        {
          fact_id: "f0",
          decision: "DELETE",
          target_index: 0,
          reasoning: "retracted",
        },
        {
          fact_id: "f1",
          decision: "NOOP",
          reasoning: "already represented",
        },
      ],
    });

    const results = await judgeOnlyBatch([
      {
        factId: "fact_delete",
        newFact: "The decision was withdrawn.",
        existingMemoryNarratives: ["The decision was adopted."],
      },
      {
        factId: "fact_noop",
        newFact: "The embedding model is BGE-M3.",
        existingMemoryNarratives: ["BGE-M3 is the embedding model."],
      },
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        factId: "fact_delete",
        targetIndex: 0,
        newNarrative: null,
      }),
      expect.objectContaining({
        factId: "fact_noop",
        targetIndex: null,
        newNarrative: null,
      }),
    ]);
  });

  it("不正batch shapeの本文をerrorへ含めない", async () => {
    completeJsonMock.mockResolvedValueOnce({
      judgements: [
        {
          fact_id: "f0",
          decision: "UPDATE",
          target_index: 0,
          new_narrative: "sensitive generated narrative",
        },
      ],
    });

    let thrown: unknown;
    try {
      await judgeOnlyBatch([
        {
          factId: "fact_1",
          newFact: "Updated fact.",
          existingMemoryNarratives: ["Old fact."],
        },
      ]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "AUDN batch LLM returned unexpected JSON shape",
    );
    expect((thrown as Error).message).not.toContain(
      "sensitive generated narrative",
    );
  });
});

describe("planAudnBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fact ごとの検索候補と judgement を durable id の plan に戻す", async () => {
    hybridSearchMock
      .mockResolvedValueOnce([{ id: "mem_1" }])
      .mockResolvedValueOnce([{ id: "mem_2" }]);
    memoryRepoMock.findById
      .mockResolvedValueOnce({
        id: "mem_1",
        narrative: "The old scheduler is active.",
        archived_at: null,
      })
      .mockResolvedValueOnce({
        id: "mem_2",
        narrative: "The old database is active.",
        archived_at: null,
      });
    completeJsonMock.mockResolvedValueOnce({
      judgements: [
        {
          fact_id: "f0",
          decision: "UPDATE",
          target_index: 0,
          new_narrative: "The new scheduler is active.",
          reasoning: "same scheduler subject",
        },
        {
          fact_id: "f1",
          decision: "DELETE",
          target_index: 0,
          new_narrative: null,
          reasoning: "database decision was withdrawn",
        },
      ],
    });

    const results = await planAudnBatch([
      { factId: "fact_1", newFact: "Use the new scheduler." },
      { factId: "fact_2", newFact: "Withdraw the old database." },
    ]);

    expect(results).toEqual([
      {
        factId: "fact_1",
        plan: {
          decision: "UPDATE",
          targetMemoryId: "mem_1",
          narrative: "The new scheduler is active.",
          reasoning: "same scheduler subject",
        },
      },
      {
        factId: "fact_2",
        plan: {
          decision: "DELETE",
          targetMemoryId: "mem_2",
          reasoning: "database decision was withdrawn",
        },
      },
    ]);
    expect(hybridSearchMock).toHaveBeenNthCalledWith(
      1,
      { query: "Use the new scheduler.", limit: 5 },
      { layers: ["memory"] },
    );
    expect(hybridSearchMock).toHaveBeenNthCalledWith(
      2,
      { query: "Withdraw the old database.", limit: 5 },
      { layers: ["memory"] },
    );
  });
});
