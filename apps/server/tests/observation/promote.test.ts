import { beforeEach, describe, expect, it, vi } from "vitest";

const observationRepoMock = vi.hoisted(() => ({
  listPending: vi.fn(),
  markSkipped: vi.fn(),
  updateFactsAndMetadata: vi.fn(),
}));

const observationPromotionFactRepoMock = vi.hoisted(() => ({
  seed: vi.fn(),
  listEligible: vi.fn(),
  claim: vi.fn(),
  apply: vi.fn(),
  recordFailure: vi.fn(),
}));

const embedderMock = vi.hoisted(() => ({
  embed: vi.fn(),
}));

const planAudnMock = vi.hoisted(() => vi.fn());
const summarizeObservationMock = vi.hoisted(() => vi.fn());
const withPgAdvisoryLockMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/observation.js", () => ({
  observationRepo: observationRepoMock,
}));

vi.mock("../../src/data/repos/observation-promotion-fact.js", () => ({
  observationPromotionFactRepo: observationPromotionFactRepoMock,
}));

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => embedderMock,
}));

vi.mock("../../src/core/dreaming/audn.js", () => ({
  planAudn: planAudnMock,
}));

vi.mock("../../src/core/observation/summarize.js", () => ({
  summarizeObservation: summarizeObservationMock,
}));

vi.mock("../../src/data/advisory-lock.js", () => ({
  withPgAdvisoryLock: withPgAdvisoryLockMock,
}));

const { promoteObservations } = await import(
  "../../src/core/observation/promote.js"
);

function fact(status: "pending" | "deferred", attemptCount: number) {
  return {
    id: "fact_1",
    observation_id: "obs_1",
    fact_hash: "hash_fact_1",
    fact: "Promotion retries durable fact rows.",
    ordinal: 0,
    status,
    attempt_count: attemptCount,
    next_attempt_at: new Date("2026-07-13T00:00:00Z"),
    lease_expires_at: null,
    last_error: status === "deferred" ? "AUDN unavailable" : null,
    decision: null,
    target_memory_id: null,
    result_memory_id: null,
    reasoning: null,
    created_at: new Date("2026-07-13T00:00:00Z"),
    updated_at: new Date("2026-07-13T00:00:00Z"),
    completed_at: null,
  };
}

function claimedFact(source: ReturnType<typeof fact>) {
  return {
    ...source,
    status: "processing",
    attempt_count: source.attempt_count + 1,
    lease_expires_at: new Date("2026-07-13T00:10:00Z"),
  };
}

describe("promoteObservations durable fact retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withPgAdvisoryLockMock.mockImplementation(
      async (_lockName: string, onLocked: () => Promise<unknown>) =>
        await onLocked(),
    );
    observationRepoMock.listPending.mockResolvedValue([]);
    observationPromotionFactRepoMock.seed.mockResolvedValue(undefined);
    observationPromotionFactRepoMock.claim.mockResolvedValue(null);
    observationPromotionFactRepoMock.apply.mockResolvedValue(undefined);
    observationPromotionFactRepoMock.recordFailure.mockResolvedValue({
      quarantined: false,
      updated: true,
    });
    embedderMock.embed.mockResolvedValue(new Float32Array([0.3, 0.4]));
  });

  it("defer された fact row を次の run で再取得して完了する", async () => {
    const pending = fact("pending", 0);
    const deferred = fact("deferred", 1);
    const firstClaim = claimedFact(pending);
    const secondClaim = claimedFact(deferred);
    observationPromotionFactRepoMock.listEligible
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([deferred]);
    observationPromotionFactRepoMock.claim
      .mockResolvedValueOnce(firstClaim)
      .mockResolvedValueOnce(secondClaim);
    planAudnMock
      .mockRejectedValueOnce(new Error("AUDN unavailable"))
      .mockResolvedValueOnce({
        decision: "ADD",
        narrative: "Promotion retries durable fact rows.",
        reasoning: "No matching memory exists.",
      });

    const firstRun = await promoteObservations();
    const secondRun = await promoteObservations();

    expect(observationPromotionFactRepoMock.recordFailure).toHaveBeenCalledWith(
      firstClaim,
      "AUDN unavailable",
    );
    expect(firstRun).toMatchObject({
      observationsPrepared: 0,
      factsSelected: 1,
      factsCompleted: 0,
      factsDeferred: 1,
      factsQuarantined: 0,
      errors: ["fact(fact_1, obs=obs_1): AUDN unavailable"],
    });
    expect(observationPromotionFactRepoMock.claim).toHaveBeenNthCalledWith(
      2,
      "fact_1",
    );
    expect(observationPromotionFactRepoMock.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        fact: secondClaim,
        decision: "ADD",
        narrative: "Promotion retries durable fact rows.",
        resultMemoryId: expect.stringMatching(/^mem_/),
        embedding: [expect.any(Number), expect.any(Number)],
      }),
    );
    expect(secondRun).toMatchObject({
      observationsPrepared: 0,
      factsSelected: 1,
      factsCompleted: 1,
      factsDeferred: 0,
      factsQuarantined: 0,
      stoppedReason: "completed",
      errors: [],
    });
    expect(summarizeObservationMock).not.toHaveBeenCalled();
    expect(observationPromotionFactRepoMock.seed).not.toHaveBeenCalled();
  });
});
