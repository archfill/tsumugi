import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderUnavailableError } from "../../src/lib/errors.js";

const observationRepoMock = vi.hoisted(() => ({
  listPending: vi.fn(),
  markSkipped: vi.fn(),
  recordPromotionFailure: vi.fn(),
  updateFactsAndMetadata: vi.fn(),
}));

const observationPromotionFactRepoMock = vi.hoisted(() => ({
  seed: vi.fn(),
  listEligible: vi.fn(),
  countOutstanding: vi.fn(),
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
const assertLlmAvailableMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/repos/observation.js", () => ({
  observationRepo: observationRepoMock,
}));

vi.mock("../../src/data/repos/observation-promotion-fact.js", () => ({
  observationPromotionFactRepo: observationPromotionFactRepoMock,
}));

vi.mock("../../src/external/embedding/singleton.js", () => ({
  getEmbedder: () => embedderMock,
}));

vi.mock("../../src/external/llm/singleton.js", () => ({
  assertLlmAvailable: assertLlmAvailableMock,
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
    failure_count: status === "deferred" ? 1 : 0,
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

function observation(id: string) {
  return {
    id,
    facts: null,
    metadata: {},
    promotion_failure_count: 0,
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
    observationRepoMock.recordPromotionFailure.mockResolvedValue({
      quarantined: false,
      updated: true,
    });
    observationPromotionFactRepoMock.seed.mockResolvedValue(undefined);
    observationPromotionFactRepoMock.listEligible.mockResolvedValue([]);
    observationPromotionFactRepoMock.countOutstanding.mockResolvedValue(0);
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([deferred])
      .mockResolvedValueOnce([]);
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
      { countsTowardQuarantine: true },
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

  it("未完了 fact が retry 待ちなら observation を追加で seed しない", async () => {
    observationPromotionFactRepoMock.countOutstanding.mockResolvedValueOnce(3);

    const result = await promoteObservations();

    expect(observationRepoMock.listPending).not.toHaveBeenCalled();
    expect(observationPromotionFactRepoMock.seed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      stoppedReason: "waiting_for_retry",
      factsSelected: 0,
      observationsPrepared: 0,
    });
  });

  it("provider 障害は quarantine failure に数えず即時停止する", async () => {
    const pending = fact("pending", 0);
    const claimed = claimedFact(pending);
    observationPromotionFactRepoMock.listEligible.mockResolvedValueOnce([
      pending,
    ]);
    observationPromotionFactRepoMock.claim.mockResolvedValueOnce(claimed);
    planAudnMock.mockRejectedValueOnce(
      new ProviderUnavailableError("provider timeout", "timeout"),
    );

    const result = await promoteObservations();

    expect(observationPromotionFactRepoMock.recordFailure).toHaveBeenCalledWith(
      claimed,
      "provider timeout",
      { countsTowardQuarantine: false },
    );
    expect(result).toMatchObject({
      stoppedReason: "provider_cooldown",
      factsSelected: 1,
      factsDeferred: 1,
      factsQuarantined: 0,
    });
  });

  it("1 observation を seed したら次の observation より先に fact を処理する", async () => {
    const pendingFact = fact("pending", 0);
    const claimed = claimedFact(pendingFact);
    observationRepoMock.listPending.mockResolvedValueOnce([
      observation("obs_1"),
      observation("obs_2"),
    ]);
    observationPromotionFactRepoMock.listEligible
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingFact]);
    observationPromotionFactRepoMock.claim.mockResolvedValueOnce(claimed);
    summarizeObservationMock.mockResolvedValueOnce({
      skip: false,
      facts: [pendingFact.fact],
      reasoning: "durable fact",
    });
    planAudnMock.mockResolvedValueOnce({
      decision: "NOOP",
      reasoning: "already represented",
    });

    const result = await promoteObservations({
      maxObservations: 2,
      maxFacts: 1,
    });

    expect(observationRepoMock.listPending).toHaveBeenCalledTimes(1);
    expect(observationPromotionFactRepoMock.seed).toHaveBeenCalledTimes(1);
    expect(observationPromotionFactRepoMock.seed).toHaveBeenCalledWith(
      "obs_1",
      expect.any(Array),
    );
    expect(summarizeObservationMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      observationsPrepared: 1,
      factsSelected: 1,
      factsCompleted: 1,
    });
  });

  it("observation 準備失敗時に同じ対象を同一 run で再選択しない", async () => {
    const first = observation("obs_1");
    const second = observation("obs_2");
    observationRepoMock.listPending.mockResolvedValueOnce([first, second]);
    summarizeObservationMock
      .mockRejectedValueOnce(new Error("malformed summary"))
      .mockResolvedValueOnce({
        skip: true,
        facts: [],
        reasoning: "not durable",
      });

    const result = await promoteObservations({ maxObservations: 2 });

    expect(observationRepoMock.listPending).toHaveBeenCalledTimes(1);
    expect(summarizeObservationMock).toHaveBeenNthCalledWith(1, first);
    expect(summarizeObservationMock).toHaveBeenNthCalledWith(2, second);
    expect(observationRepoMock.recordPromotionFailure).toHaveBeenCalledWith(
      first,
      "malformed summary",
    );
    expect(result).toMatchObject({
      observationsPrepared: 0,
      observationsSkipped: 1,
      observationsDeferred: 1,
      observationsQuarantined: 0,
      errors: ["prepare(obs=obs_1): malformed summary"],
    });
  });
});
