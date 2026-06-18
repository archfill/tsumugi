import { beforeEach, describe, expect, it, vi } from "vitest";

const linkRepoMock = vi.hoisted(() => ({
  listMemoryIdsDerivedFromProject: vi.fn(),
  listSearchProvenance: vi.fn(),
}));

vi.mock("../../src/data/repos/link.js", () => ({
  linkRepo: linkRepoMock,
}));

const { attachProvenance, filterMemoryHitsByProjectTag } = await import(
  "../../src/core/search/provenance.js"
);

describe("search provenance policy", () => {
  beforeEach(() => {
    linkRepoMock.listMemoryIdsDerivedFromProject.mockReset();
    linkRepoMock.listSearchProvenance.mockReset();
  });

  describe("filterMemoryHitsByProjectTag", () => {
    it("project_tag が無ければそのまま返し、repo を呼ばない", async () => {
      const hits = [
        { id: "obs_1", layer: "observation" as const },
        { id: "mem_1", layer: "memory" as const },
      ];

      const result = await filterMemoryHitsByProjectTag(hits, undefined);

      expect(result).toBe(hits);
      expect(
        linkRepoMock.listMemoryIdsDerivedFromProject,
      ).not.toHaveBeenCalled();
    });

    it("derived_from observation の project_tag に一致する memory だけ残す", async () => {
      linkRepoMock.listMemoryIdsDerivedFromProject.mockResolvedValueOnce([
        "mem_keep",
      ]);

      const result = await filterMemoryHitsByProjectTag(
        [
          { id: "obs_1", layer: "observation" as const },
          { id: "mem_keep", layer: "memory" as const },
          { id: "mem_drop", layer: "memory" as const },
        ],
        "tsumugi",
      );

      expect(linkRepoMock.listMemoryIdsDerivedFromProject).toHaveBeenCalledWith(
        ["mem_keep", "mem_drop"],
        "tsumugi",
      );
      expect(result).toEqual([
        { id: "obs_1", layer: "observation" },
        { id: "mem_keep", layer: "memory" },
      ]);
    });
  });

  describe("attachProvenance", () => {
    it("final hits に batch provenance を常に付与する", async () => {
      linkRepoMock.listSearchProvenance.mockResolvedValueOnce([
        {
          hit_id: "mem_1",
          hit_layer: "memory",
          id: "obs_1",
          layer: "observation",
          relation: "derived_from",
          created_at: new Date("2026-06-17T01:02:03.000Z"),
        },
        {
          hit_id: "obs_2",
          hit_layer: "observation",
          id: "mem_2",
          layer: "memory",
          relation: "related_to",
          created_at: "2026-06-17T04:05:06.000Z",
        },
      ]);

      const result = await attachProvenance([
        {
          id: "mem_1",
          layer: "memory",
          excerpt: "memory",
          score: 0.5,
        },
        {
          id: "obs_2",
          layer: "observation",
          excerpt: "observation",
          score: 0.4,
        },
        {
          id: "obs_empty",
          layer: "observation",
          excerpt: "empty",
          score: 0.3,
        },
      ]);

      expect(linkRepoMock.listSearchProvenance).toHaveBeenCalledWith({
        observationIds: ["obs_2", "obs_empty"],
        memoryIds: ["mem_1"],
      });
      expect(result).toEqual([
        {
          id: "mem_1",
          layer: "memory",
          excerpt: "memory",
          score: 0.5,
          tags: [],
          provenance: [
            {
              layer: "observation",
              id: "obs_1",
              relation: "derived_from",
              created_at: "2026-06-17T01:02:03.000Z",
            },
          ],
        },
        {
          id: "obs_2",
          layer: "observation",
          excerpt: "observation",
          score: 0.4,
          tags: [],
          provenance: [
            {
              layer: "memory",
              id: "mem_2",
              relation: "related_to",
              created_at: "2026-06-17T04:05:06.000Z",
            },
          ],
        },
        {
          id: "obs_empty",
          layer: "observation",
          excerpt: "empty",
          score: 0.3,
          tags: [],
          provenance: [],
        },
      ]);
    });
  });
});
