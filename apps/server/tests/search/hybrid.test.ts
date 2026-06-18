import { beforeEach, describe, expect, it, vi } from "vitest";

const embedMock = vi.hoisted(() => vi.fn());
const bigmSearchMock = vi.hoisted(() => vi.fn());
const vectorSearchMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => ({
    embed: embedMock,
  }),
}));

vi.mock("../../src/core/search/bigm.js", () => ({
  bigmSearch: bigmSearchMock,
}));

vi.mock("../../src/core/search/vector.js", () => ({
  vectorSearch: vectorSearchMock,
}));

const { hybridSearch } = await import("../../src/core/search/hybrid.js");

describe("hybridSearch layer selection", () => {
  beforeEach(() => {
    embedMock.mockReset();
    bigmSearchMock.mockReset();
    vectorSearchMock.mockReset();

    embedMock.mockResolvedValue(new Float32Array([0.1, 0.2]));
    bigmSearchMock.mockResolvedValue([]);
    vectorSearchMock.mockResolvedValue([]);
  });

  it("filter が無ければ observation と memory の両方を検索する", async () => {
    await hybridSearch({ query: "MCP transport", limit: 5 });

    expect(bigmSearchMock).toHaveBeenCalledTimes(2);
    expect(vectorSearchMock).toHaveBeenCalledTimes(2);
    expect(bigmSearchMock.mock.calls.map(([arg]) => arg.layer)).toEqual([
      "observation",
      "memory",
    ]);
    expect(vectorSearchMock.mock.calls.map(([arg]) => arg.layer)).toEqual([
      "observation",
      "memory",
    ]);
  });

  it("session_id filter があれば Phase 1 では observation だけを検索する", async () => {
    await hybridSearch({
      query: "MCP transport",
      limit: 5,
      filter: { session_id: "sess_X" },
    });

    expect(bigmSearchMock).toHaveBeenCalledTimes(1);
    expect(vectorSearchMock).toHaveBeenCalledTimes(1);
    expect(bigmSearchMock.mock.calls[0]?.[0]).toMatchObject({
      layer: "observation",
      filter: { session_id: "sess_X" },
    });
    expect(vectorSearchMock.mock.calls[0]?.[0]).toMatchObject({
      layer: "observation",
      filter: { session_id: "sess_X" },
    });
  });

  it("project_tag filter があれば Phase 1 では observation だけを検索する", async () => {
    await hybridSearch({
      query: "MCP transport",
      limit: 5,
      filter: { project_tag: "tsumugi" },
    });

    expect(bigmSearchMock).toHaveBeenCalledTimes(1);
    expect(vectorSearchMock).toHaveBeenCalledTimes(1);
    expect(bigmSearchMock.mock.calls[0]?.[0]).toMatchObject({
      layer: "observation",
      filter: { project_tag: "tsumugi" },
    });
    expect(vectorSearchMock.mock.calls[0]?.[0]).toMatchObject({
      layer: "observation",
      filter: { project_tag: "tsumugi" },
    });
  });
});
