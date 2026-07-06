import { beforeEach, describe, expect, it, vi } from "vitest";

const memoryRepoMock = vi.hoisted(() => ({
  archiveOutdated: vi.fn(),
  listLlmEligible: vi.fn(),
  recordLlmFailure: vi.fn(),
  resetLlmFailures: vi.fn(),
  update: vi.fn(),
}));

const dreamingRunRepoMock = vi.hoisted(() => ({
  findRunningByKind: vi.fn(),
  insert: vi.fn(),
  markRunning: vi.fn(),
  markStaleRunning: vi.fn(),
  update: vi.fn(),
  markCompleted: vi.fn(),
  markFailed: vi.fn(),
}));

const llmMock = vi.hoisted(() => ({
  completeJson: vi.fn(),
}));

const embedderMock = vi.hoisted(() => ({
  embed: vi.fn(),
}));

vi.mock("../../src/data/repos/memory.js", () => ({
  memoryRepo: memoryRepoMock,
}));

vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: dreamingRunRepoMock,
}));

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => embedderMock,
}));

vi.mock("../../src/external/llm/index.js", () => ({
  getLlm: () => llmMock,
}));

const { timeAwareMemoryUpdate } = await import(
  "../../src/core/dreaming/time-update.js"
);

function agedMemory(id: string) {
  return {
    id,
    narrative: `memory ${id}`,
    importance: 5,
    kind: "general",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  };
}

describe("timeAwareMemoryUpdate outdated handling", () => {
  beforeEach(() => {
    memoryRepoMock.archiveOutdated.mockReset();
    memoryRepoMock.listLlmEligible.mockReset();
    memoryRepoMock.recordLlmFailure.mockReset();
    memoryRepoMock.resetLlmFailures.mockReset();
    memoryRepoMock.update.mockReset();
    dreamingRunRepoMock.findRunningByKind.mockReset();
    dreamingRunRepoMock.insert.mockReset();
    dreamingRunRepoMock.markRunning.mockReset();
    dreamingRunRepoMock.markStaleRunning.mockReset();
    dreamingRunRepoMock.update.mockReset();
    dreamingRunRepoMock.markCompleted.mockReset();
    dreamingRunRepoMock.markFailed.mockReset();
    llmMock.completeJson.mockReset();
    embedderMock.embed.mockReset();
    dreamingRunRepoMock.findRunningByKind.mockResolvedValue(null);
    dreamingRunRepoMock.markStaleRunning.mockResolvedValue(0);
    embedderMock.embed.mockResolvedValue(new Float32Array([0.1, 0.2]));
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
      expect.objectContaining({
        archivedOutdated: 2,
        stoppedReason: "completed",
      }),
    );
    expect(result).toMatchObject({
      scanned: 0,
      updated: 0,
      archivedOutdated: 2,
      failed: 0,
      skipped: false,
      stoppedReason: "completed",
      errors: [],
    });
  });

  it("running 中の time-update があれば新規 run を作らず skip する", async () => {
    dreamingRunRepoMock.findRunningByKind.mockResolvedValueOnce({
      id: "drun_existing",
    });

    const result = await timeAwareMemoryUpdate();

    expect(dreamingRunRepoMock.markStaleRunning).toHaveBeenCalled();
    expect(dreamingRunRepoMock.insert).not.toHaveBeenCalled();
    expect(memoryRepoMock.archiveOutdated).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      runId: "drun_existing",
      skipped: true,
      stoppedReason: "active_run_in_progress",
    });
  });

  it("失敗数 budget に達したら run を正常終了して metadata に理由を残す", async () => {
    memoryRepoMock.archiveOutdated.mockResolvedValueOnce(0);
    memoryRepoMock.listLlmEligible.mockResolvedValueOnce([
      agedMemory("mem_1"),
      agedMemory("mem_2"),
    ]);
    memoryRepoMock.recordLlmFailure.mockResolvedValue({ quarantined: false });
    llmMock.completeJson.mockRejectedValue(new Error("LLM timeout"));

    const result = await timeAwareMemoryUpdate({
      maxFailures: 1,
      maxConsecutiveFailures: 10,
    });

    expect(memoryRepoMock.recordLlmFailure).toHaveBeenCalledTimes(1);
    expect(dreamingRunRepoMock.markCompleted).toHaveBeenCalledWith(
      result.runId,
      0,
      expect.objectContaining({
        failed: 1,
        stoppedReason: "failure_budget_exceeded",
      }),
    );
    expect(result).toMatchObject({
      scanned: 2,
      updated: 0,
      failed: 1,
      stoppedReason: "failure_budget_exceeded",
    });
  });

  it("時間 budget に達したら LLM 処理に入らず正常終了する", async () => {
    memoryRepoMock.archiveOutdated.mockResolvedValueOnce(0);
    memoryRepoMock.listLlmEligible.mockResolvedValueOnce([agedMemory("mem_1")]);

    const result = await timeAwareMemoryUpdate({ maxRunMs: 0 });

    expect(llmMock.completeJson).not.toHaveBeenCalled();
    expect(dreamingRunRepoMock.markCompleted).toHaveBeenCalledWith(
      result.runId,
      0,
      expect.objectContaining({
        stoppedReason: "time_budget_exceeded",
      }),
    );
    expect(result).toMatchObject({
      scanned: 1,
      updated: 0,
      stoppedReason: "time_budget_exceeded",
    });
  });
});
