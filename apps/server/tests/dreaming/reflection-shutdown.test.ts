import { beforeEach, describe, expect, it, vi } from "vitest";

const observationRepoMock = vi.hoisted(() => ({ listForSession: vi.fn() }));
const memoryRepoMock = vi.hoisted(() => ({ insert: vi.fn() }));
const linkRepoMock = vi.hoisted(() => ({ insert: vi.fn() }));
const dreamingRunRepoMock = vi.hoisted(() => ({
  insert: vi.fn(),
  markRunning: vi.fn(),
  update: vi.fn(),
  markCompleted: vi.fn(),
  markPartial: vi.fn(),
  markFailed: vi.fn(),
}));
const llmMock = vi.hoisted(() => ({ completeJson: vi.fn() }));
const embedMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/observation.js", () => ({
  observationRepo: observationRepoMock,
}));
vi.mock("../../src/data/repos/memory.js", () => ({ memoryRepo: memoryRepoMock }));
vi.mock("../../src/data/repos/link.js", () => ({ linkRepo: linkRepoMock }));
vi.mock("../../src/data/repos/dreaming-run.js", () => ({
  dreamingRunRepo: dreamingRunRepoMock,
}));
vi.mock("../../src/external/llm/index.js", () => ({ getLlm: () => llmMock }));
vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => ({ embed: embedMock }),
}));

const { reflectOnSession } = await import(
  "../../src/core/dreaming/reflection.js"
);

describe("reflection shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    observationRepoMock.listForSession.mockResolvedValue([
      { id: "obs_1", type: "learning", content: "Use bounded shutdown" },
    ]);
    llmMock.completeJson.mockResolvedValue({
      reflections: [
        { type: "lesson", content: "one", importance: 7 },
        { type: "pattern", content: "two", importance: 6 },
      ],
      summary: "summary",
      reasoning: "reasoning",
    });
  });

  it("finishes one durable reflection and does not start the next", async () => {
    const controller = new AbortController();
    embedMock.mockImplementation(async () => {
      controller.abort();
      return new Float32Array([1, 0]);
    });

    const result = await reflectOnSession({
      sessionId: "ses_1",
      signal: controller.signal,
    });

    expect(memoryRepoMock.insert).toHaveBeenCalledOnce();
    expect(linkRepoMock.insert).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      reflectionsCreated: 1,
      stoppedReason: "shutdown_requested",
      errors: [],
    });
    expect(dreamingRunRepoMock.markPartial).toHaveBeenCalledWith(
      result.runId,
      1,
      "reflection stopped: shutdown_requested",
      expect.objectContaining({ stoppedReason: "shutdown_requested" }),
    );
  });
});
