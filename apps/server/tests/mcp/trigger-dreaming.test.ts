import { beforeEach, describe, expect, it, vi } from "vitest";

const runDreamingMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/core/dreaming/runner.js", () => ({
  runDreaming: runDreamingMock,
}));

import {
  handleTriggerDreaming,
  TRIGGER_DREAMING_TOOL,
} from "../../src/interfaces/mcp/tools/trigger-dreaming.js";

describe("trigger_dreaming contract", () => {
  beforeEach(() => {
    runDreamingMock.mockReset();
  });

  it("lists active maintenance jobs and removed legacy jobs", () => {
    const job = TRIGGER_DREAMING_TOOL.inputSchema.properties.job;

    expect(job.enum).toContain("archive-outdated");
    expect(job.description).toContain("promote-captures");
    expect(job.description).toContain("decision-contradiction");
    expect(job.description).toContain("廃止済みとして no-op で返す");
  });

  it("maxMemoriesをpositive integerかつ500以下としてJSON schemaに公開する", () => {
    expect(TRIGGER_DREAMING_TOOL.inputSchema.properties.maxMemories).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 500,
    });
  });

  it("shared Zod contractで不正なmanual trigger入力を拒否する", async () => {
    await expect(
      handleTriggerDreaming({ job: "synthesize", maxMemories: 501 }),
    ).rejects.toThrow();
    await expect(
      handleTriggerDreaming({ job: "synthesize", maxMemories: 1.5 }),
    ).rejects.toThrow();
    expect(runDreamingMock).not.toHaveBeenCalled();
  });

  it("JSON schemaと同様に未知キーをruntimeで拒否する", async () => {
    await expect(
      handleTriggerDreaming({ job: "archive-outdated", maxMemory: 1 }),
    ).rejects.toThrow();
    expect(runDreamingMock).not.toHaveBeenCalled();
  });

  it("検証済み入力だけをrunnerへ渡す", async () => {
    runDreamingMock.mockResolvedValueOnce({ ok: true });

    await expect(
      handleTriggerDreaming({ job: "synthesize", maxMemories: 500 }),
    ).resolves.toEqual({ ok: true });
    expect(runDreamingMock).toHaveBeenCalledWith({
      job: "synthesize",
      maxMemories: 500,
    });
  });
});
