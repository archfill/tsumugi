import { beforeEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.hoisted(() => vi.fn());
const embedMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/observation.js", () => ({
  observationRepo: { insert: insertMock },
}));
vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => ({ embed: embedMock }),
}));
vi.mock("../../src/lib/id.js", () => ({ newId: () => "obs_test" }));

const { saveObservation } = await import(
  "../../src/core/observation/save.js"
);

describe("saveObservation without server LLM promotion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedMock.mockResolvedValue(new Float32Array([0.1, 0.2]));
  });

  it("client supplied observationを保存時点でcompletedにする", async () => {
    await expect(
      saveObservation({
        content: "Decision with enough context",
        type: "decision",
        source: "codex",
        facts: ["fact supplied by client"],
        project_tag: "tsumugi",
      }),
    ).resolves.toEqual({ id: "obs_test" });

    expect(embedMock).toHaveBeenCalledWith("Decision with enough context");
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "obs_test",
        content: "Decision with enough context",
        facts: ["fact supplied by client"],
        promotion_state: "completed",
        promoted_at: expect.any(Date),
      }),
    );
  });
});
