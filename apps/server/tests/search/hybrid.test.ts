import { beforeEach, describe, expect, it, vi } from "vitest";

const embedMock = vi.hoisted(() => vi.fn());
const bigmSearchMock = vi.hoisted(() => vi.fn());
const vectorSearchMock = vi.hoisted(() => vi.fn());
const filterMemoryHitsByProjectTagMock = vi.hoisted(() => vi.fn());
const attachProvenanceMock = vi.hoisted(() => vi.fn());
const preferObservationCandidatesMock = vi.hoisted(() => vi.fn());

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

vi.mock("../../src/core/search/provenance.js", () => ({
  filterMemoryHitsByProjectTag: filterMemoryHitsByProjectTagMock,
  attachProvenance: attachProvenanceMock,
  preferObservationCandidates: preferObservationCandidatesMock,
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
    filterMemoryHitsByProjectTagMock.mockImplementation((hits) =>
      Promise.resolve(hits),
    );
    preferObservationCandidatesMock.mockImplementation((hits) => Promise.resolve(hits));
    attachProvenanceMock.mockImplementation((hits) =>
      Promise.resolve(
        hits.map((hit: Record<string, unknown>) => ({
          ...hit,
          provenance: [],
        })),
      ),
    );
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
    expect(filterMemoryHitsByProjectTagMock).toHaveBeenCalledWith(
      [],
      undefined,
    );
    expect(attachProvenanceMock).toHaveBeenCalledWith([]);
  });

  it("session_id filter だけなら observation だけを検索する", async () => {
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

  it("project_tag filter があれば memory も候補検索し、memory には filter を渡さない", async () => {
    await hybridSearch({
      query: "MCP transport",
      limit: 5,
      filter: { project_tag: "tsumugi" },
    });

    expect(bigmSearchMock).toHaveBeenCalledTimes(2);
    expect(vectorSearchMock).toHaveBeenCalledTimes(2);
    expect(bigmSearchMock.mock.calls[0]?.[0]).toMatchObject({
      layer: "observation",
      filter: { project_tag: "tsumugi" },
    });
    expect(bigmSearchMock.mock.calls[1]?.[0]).toMatchObject({
      layer: "memory",
      filter: undefined,
    });
    expect(vectorSearchMock.mock.calls[0]?.[0]).toMatchObject({
      layer: "observation",
      filter: { project_tag: "tsumugi" },
    });
    expect(vectorSearchMock.mock.calls[1]?.[0]).toMatchObject({
      layer: "memory",
      filter: undefined,
    });
    expect(filterMemoryHitsByProjectTagMock).toHaveBeenCalledWith(
      [],
      "tsumugi",
    );
  });

  it("fused全候補へslice前にpolicyを適用し、独立候補でbackfillしてfinalだけprovenance付与する", async () => {
    bigmSearchMock.mockResolvedValueOnce([
      { id: "obs_1", layer: "observation", excerpt: "o", score: 1 },
      { id: "mem_linked", layer: "memory", excerpt: "m", score: 0.9 },
      { id: "mem_independent", layer: "memory", excerpt: "i", score: 0.8 },
    ]).mockResolvedValueOnce([]);
    preferObservationCandidatesMock.mockImplementationOnce(async (hits) =>
      hits.filter((hit: { id: string }) => hit.id !== "mem_linked"),
    );

    await hybridSearch({ query: "q", limit: 2 });

    expect(preferObservationCandidatesMock).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "obs_1" }),
        expect.objectContaining({ id: "mem_linked" }),
        expect.objectContaining({ id: "mem_independent" }),
      ]),
    );
    expect(attachProvenanceMock).toHaveBeenCalledWith([
      expect.objectContaining({ id: "obs_1" }),
      expect.objectContaining({ id: "mem_independent" }),
    ]);
  });
});
