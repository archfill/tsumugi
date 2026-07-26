import { beforeEach, describe, expect, it, vi } from "vitest";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/client.js", () => ({ db: { execute: executeMock } }));

const { memoryAuditRepo } = await import(
  "../../src/data/repos/memory-audit.js"
);

describe("memoryAuditRepo", () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it("uses the read-only audit query result without mutation methods", async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    await expect(memoryAuditRepo.listForQualityAudit(20_000)).resolves.toEqual([]);
    expect(executeMock).toHaveBeenCalledOnce();
  });

  it("limit + 1 rowsを受けた場合はpartial reportを返さず安全に失敗する", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ id: "mem_1" }, { id: "mem_2" }] });

    await expect(memoryAuditRepo.listForQualityAudit(1)).rejects.toThrow(
      "memory quality audit row limit exceeded",
    );
  });
});
