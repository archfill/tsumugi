import { beforeEach, describe, expect, it, vi } from "vitest";

const returningMock = vi.hoisted(() => vi.fn());
const whereMock = vi.hoisted(() => vi.fn(() => ({ returning: returningMock })));
const setMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })));
const updateMock = vi.hoisted(() => vi.fn(() => ({ set: setMock })));

vi.mock("../../src/data/client.js", () => ({
  db: { update: updateMock },
}));

const { dreamingRunRepo } = await import(
  "../../src/data/repos/dreaming-run.js"
);

describe("dreamingRunRepo ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a terminal update after ownership was recovered", async () => {
    returningMock.mockResolvedValue([]);

    await expect(
      dreamingRunRepo.markCompleted("drun_1", 1),
    ).rejects.toThrow("lost ownership before terminal update");
  });

  it("allows a terminal update while the process still owns the run", async () => {
    returningMock.mockResolvedValue([{ id: "drun_1" }]);

    await expect(
      dreamingRunRepo.markPartial("drun_1", 1, "stopped"),
    ).resolves.toBeUndefined();
  });
});
