import { describe, expect, it, vi } from "vitest";

const recoverMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/dreaming/recover.js", () => ({ recoverStaleDreamingRuns: recoverMock }));

const { runDreaming } = await import("../../src/core/dreaming/runner.js");

describe("removed server LLM dreaming jobs", () => {
  it.each(["promote-observations", "synthesize", "time-update", "decision-contradiction", "reflection", "full"] as const)("%s is a no-op before recovery", async (job) => {
    const result = await runDreaming({ job });
    expect(result.steps).toEqual([{ name: job, ok: true, detail: { skipped: true, reason: "removed_server_llm" } }]);
    expect(recoverMock).not.toHaveBeenCalled();
  });
});
