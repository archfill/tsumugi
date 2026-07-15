import { beforeEach, describe, expect, it, vi } from "vitest";

const dreamingRunRepoMock = vi.hoisted(() => ({
  markStaleNonTerminal: vi.fn(),
}));

vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: dreamingRunRepoMock,
}));

const { recoverStaleDreamingRuns } = await import(
  "../../src/core/dreaming/recover.js"
);

describe("recoverStaleDreamingRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks only non-terminal runs older than the stale threshold", async () => {
    const now = new Date("2026-07-15T04:00:00Z");
    dreamingRunRepoMock.markStaleNonTerminal.mockResolvedValue(3);

    await expect(recoverStaleDreamingRuns({ now })).resolves.toBe(3);
    expect(dreamingRunRepoMock.markStaleNonTerminal).toHaveBeenCalledWith(
      new Date("2026-07-15T02:00:00Z"),
      "dreaming run exceeded stale threshold (7200000ms)",
    );
  });
});
