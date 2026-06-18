import { beforeEach, describe, expect, it, vi } from "vitest";

const observationRepoMock = vi.hoisted(() => ({
  getLatestProjectTagBySession: vi.fn(),
}));

vi.mock("../../src/data/repos/observation.js", () => ({
  observationRepo: observationRepoMock,
}));

vi.mock("../../src/lib/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const { resolveSearchFilter } =
  await import("../../src/core/search/resolve-filter.js");

describe("resolveSearchFilter (ADR-013 G)", () => {
  beforeEach(() => {
    observationRepoMock.getLatestProjectTagBySession.mockReset();
  });

  describe("明示 project_tag = string → そのまま", () => {
    it("string が明示されていたらそのまま返す (session_id は読まない)", async () => {
      const result = await resolveSearchFilter({
        project_tag: "tsumugi",
        session_id: "sess_X",
      });

      expect(result).toEqual({
        project_tag: "tsumugi",
        session_id: "sess_X",
      });
      expect(
        observationRepoMock.getLatestProjectTagBySession,
      ).not.toHaveBeenCalled();
    });
  });

  describe("明示 project_tag = null → project_tag auto-fill opt-out", () => {
    it("null は filter から削除され、session_id は維持される", async () => {
      const result = await resolveSearchFilter({
        project_tag: null,
        session_id: "sess_X",
      });

      expect(result).toEqual({ session_id: "sess_X" });
      expect(result).not.toHaveProperty("project_tag");
      expect(
        observationRepoMock.getLatestProjectTagBySession,
      ).not.toHaveBeenCalled();
    });

    it("null + 他フィルタなしなら空 filter として正常に処理", async () => {
      const result = await resolveSearchFilter({ project_tag: null });

      expect(result).toEqual({});
      expect(result).not.toHaveProperty("project_tag");
    });
  });

  describe("project_tag undefined + session_id あり → 自動補完", () => {
    it("session から project_tag を取れたら補完する", async () => {
      observationRepoMock.getLatestProjectTagBySession.mockResolvedValueOnce(
        "tsumugi",
      );

      const result = await resolveSearchFilter({ session_id: "sess_X" });

      expect(result).toEqual({
        session_id: "sess_X",
        project_tag: "tsumugi",
      });
      expect(
        observationRepoMock.getLatestProjectTagBySession,
      ).toHaveBeenCalledWith("sess_X");
    });

    it("session に紐付く observation が無ければ filter から project_tag を削除", async () => {
      observationRepoMock.getLatestProjectTagBySession.mockResolvedValueOnce(
        null,
      );

      const result = await resolveSearchFilter({ session_id: "sess_Y" });

      expect(result).toEqual({ session_id: "sess_Y" });
      expect(result).not.toHaveProperty("project_tag");
    });

    it("他フィルタ (type / source) は維持する", async () => {
      observationRepoMock.getLatestProjectTagBySession.mockResolvedValueOnce(
        "tsumugi",
      );

      const result = await resolveSearchFilter({
        session_id: "sess_X",
        type: "decision",
        source: "claude-code",
      });

      expect(result).toEqual({
        session_id: "sess_X",
        type: "decision",
        source: "claude-code",
        project_tag: "tsumugi",
      });
    });
  });

  describe("filter 全体が undefined / session_id も無い → WARN", () => {
    it("filter undefined なら空 filter を返す", async () => {
      const result = await resolveSearchFilter(undefined);

      expect(result).toEqual({});
      expect(
        observationRepoMock.getLatestProjectTagBySession,
      ).not.toHaveBeenCalled();
    });

    it("session_id 無しで他フィルタのみなら project_tag 解決を試みない", async () => {
      const result = await resolveSearchFilter({
        type: "discovery",
      });

      expect(result).toEqual({ type: "discovery" });
      expect(
        observationRepoMock.getLatestProjectTagBySession,
      ).not.toHaveBeenCalled();
    });
  });
});
