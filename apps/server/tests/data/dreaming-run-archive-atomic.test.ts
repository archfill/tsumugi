import { beforeEach, describe, expect, it, vi } from "vitest";

const returningMock = vi.hoisted(() => vi.fn());
const whereMock = vi.hoisted(() => vi.fn(() => ({ returning: returningMock })));
const setMock = vi.hoisted(() => vi.fn(() => ({ where: whereMock })));
const updateMock = vi.hoisted(() => vi.fn(() => ({ set: setMock })));
const transactionMock = vi.hoisted(() =>
  vi.fn(
    async (execute: (tx: { update: typeof updateMock }) => Promise<unknown>) =>
      await execute({ update: updateMock }),
  ),
);

vi.mock("../../src/data/client.js", () => ({
  db: { transaction: transactionMock, update: updateMock },
}));

const { dreamingRunRepo } = await import(
  "../../src/data/repos/dreaming-run.js"
);

describe("archiveOutdatedAndMarkCompleted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the memory batch and owned run completion through one transaction executor", async () => {
    returningMock
      .mockResolvedValueOnce([{ id: "mem_1" }, { id: "mem_2" }])
      .mockResolvedValueOnce([{ id: "drun_1" }]);

    await expect(
      dreamingRunRepo.archiveOutdatedAndMarkCompleted("drun_1", 10),
    ).resolves.toEqual({
      archivedOutdated: 2,
      memoryIds: ["mem_1", "mem_2"],
    });
    expect(transactionMock).toHaveBeenCalledOnce();
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("propagates ownership loss from the transaction callback", async () => {
    returningMock
      .mockResolvedValueOnce([{ id: "mem_1" }])
      .mockResolvedValueOnce([]);

    await expect(
      dreamingRunRepo.archiveOutdatedAndMarkCompleted("drun_1", 10),
    ).rejects.toThrow("lost ownership before terminal update");

    // This mock executes the transaction callback directly; production Drizzle
    // rolls back its preceding memory update when this callback throws.
    expect(transactionMock).toHaveBeenCalledOnce();
  });
});
