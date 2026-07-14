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
  listEligibleForObservation: vi.fn(),
  countOutstanding: vi.fn(),
  claim: vi.fn(),
  apply: vi.fn(),
  recordFailure: vi.fn(),
}));

const embedderMock = vi.hoisted(() => ({
  embed: vi.fn(),
}));

const planAudnMock = vi.hoisted(() => vi.fn());
const planAudnBatchMock = vi.hoisted(() => vi.fn());
const summarizeObservationMock = vi.hoisted(() => vi.fn());
const withPgAdvisoryLockMock = vi.hoisted(() => vi.fn());
const assertLlmAvailableMock = vi.hoisted(() => vi.fn());
const loggerMock = vi.hoisted(() => ({ warn: vi.fn() }));

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
  planAudnBatch: planAudnBatchMock,
}));

vi.mock("../../src/lib/logger.js", () => ({ logger: loggerMock }));

vi.mock("../../src/core/observation/summarize.js", () => ({
  summarizeObservation: summarizeObservationMock,
}));

vi.mock("../../src/data/advisory-lock.js", () => ({
  withPgAdvisoryLock: withPgAdvisoryLockMock,
}));

const { promoteObservations } = await import(
  "../../src/core/observation/promote.js"
);

function fact(
  status: "pending" | "deferred",
  attemptCount: number,
  id = "fact_1",
  observationId = "obs_1",
  ordinal = 0,
) {
  return {
    id,
    observation_id: observationId,
    fact_hash: `hash_${id}`,
    fact:
      id === "fact_1"
        ? "Promotion retries durable fact rows."
        : `Durable fact ${id}.`,
    ordinal,
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
    observationPromotionFactRepoMock.listEligibleForObservation.mockResolvedValue(
      [],
    );
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
    observationPromotionFactRepoMock.listEligibleForObservation
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

  it("retry 待ち fact が上限未満なら次の observation を処理する", async () => {
    observationPromotionFactRepoMock.countOutstanding.mockResolvedValueOnce(2);
    observationRepoMock.listPending.mockResolvedValueOnce([
      observation("obs_2"),
    ]);
    summarizeObservationMock.mockResolvedValueOnce({
      skip: true,
      facts: [],
      reasoning: "noise",
    });

    const result = await promoteObservations({ maxOutstandingFacts: 3 });

    expect(observationRepoMock.listPending).toHaveBeenCalled();
    expect(observationPromotionFactRepoMock.seed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      stoppedReason: "completed",
      factsSelected: 0,
      observationsPrepared: 0,
      observationsSkipped: 1,
    });
  });

  it("retry 待ち fact が上限に達したら observation を追加で seed しない", async () => {
    observationPromotionFactRepoMock.countOutstanding.mockResolvedValueOnce(3);

    const result = await promoteObservations({ maxOutstandingFacts: 3 });

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
    observationPromotionFactRepoMock.listEligibleForObservation.mockResolvedValueOnce([
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
    observationPromotionFactRepoMock.listEligibleForObservation.mockResolvedValueOnce([
      pendingFact,
    ]);
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

  it("同じ observation の fact 3件を1回の AUDN batch で判定して個別適用する", async () => {
    const pendingFacts = [
      fact("pending", 0, "fact_1", "obs_1", 0),
      fact("pending", 0, "fact_2", "obs_1", 1),
      fact("pending", 0, "fact_3", "obs_1", 2),
    ];
    const claimedFacts = pendingFacts.map(claimedFact);
    observationPromotionFactRepoMock.listEligible.mockResolvedValueOnce(
      pendingFacts,
    );
    observationPromotionFactRepoMock.listEligibleForObservation.mockResolvedValueOnce(
      pendingFacts,
    );
    observationPromotionFactRepoMock.claim
      .mockResolvedValueOnce(claimedFacts[0])
      .mockResolvedValueOnce(claimedFacts[1])
      .mockResolvedValueOnce(claimedFacts[2]);
    planAudnBatchMock.mockResolvedValueOnce(
      claimedFacts.map((claimed) => ({
        factId: claimed.id,
        plan: { decision: "NOOP", reasoning: "already represented" },
      })),
    );

    const result = await promoteObservations({ maxFacts: 3 });

    expect(planAudnBatchMock).toHaveBeenCalledTimes(1);
    expect(planAudnBatchMock).toHaveBeenCalledWith(
      claimedFacts.map((claimed) => ({
        factId: claimed.id,
        newFact: claimed.fact,
      })),
    );
    expect(planAudnMock).not.toHaveBeenCalled();
    expect(observationPromotionFactRepoMock.apply).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      factsSelected: 3,
      factBatchesSelected: 1,
      factBatchFallbacks: 0,
      factsCompleted: 3,
      errors: [],
    });
  });

  it("AUDN batch の provider 障害で全 claim を quarantine 加算なしで defer する", async () => {
    const pendingFacts = [
      fact("pending", 0, "fact_1", "obs_1", 0),
      fact("pending", 0, "fact_2", "obs_1", 1),
      fact("pending", 0, "fact_3", "obs_1", 2),
    ];
    const claimedFacts = pendingFacts.map(claimedFact);
    observationPromotionFactRepoMock.listEligible.mockResolvedValueOnce(
      pendingFacts,
    );
    observationPromotionFactRepoMock.listEligibleForObservation.mockResolvedValueOnce(
      pendingFacts,
    );
    observationPromotionFactRepoMock.claim
      .mockResolvedValueOnce(claimedFacts[0])
      .mockResolvedValueOnce(claimedFacts[1])
      .mockResolvedValueOnce(claimedFacts[2]);
    planAudnBatchMock.mockRejectedValueOnce(
      new ProviderUnavailableError("provider timeout", "timeout"),
    );

    const result = await promoteObservations({ maxFacts: 3 });

    expect(observationPromotionFactRepoMock.recordFailure).toHaveBeenCalledTimes(
      3,
    );
    for (const claimed of claimedFacts) {
      expect(
        observationPromotionFactRepoMock.recordFailure,
      ).toHaveBeenCalledWith(claimed, "provider timeout", {
        countsTowardQuarantine: false,
      });
    }
    expect(planAudnMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      stoppedReason: "provider_cooldown",
      factBatchesSelected: 1,
      factBatchFallbacks: 0,
      factsDeferred: 3,
      factsQuarantined: 0,
    });
  });

  it("AUDN batch の item error は単件判定へ fallback して処理を完了する", async () => {
    const pendingFacts = [
      fact("pending", 0, "fact_1", "obs_1", 0),
      fact("pending", 0, "fact_2", "obs_1", 1),
      fact("pending", 0, "fact_3", "obs_1", 2),
    ];
    const claimedFacts = pendingFacts.map(claimedFact);
    observationPromotionFactRepoMock.listEligible.mockResolvedValueOnce(
      pendingFacts,
    );
    observationPromotionFactRepoMock.listEligibleForObservation.mockResolvedValueOnce(
      pendingFacts,
    );
    observationPromotionFactRepoMock.claim
      .mockResolvedValueOnce(claimedFacts[0])
      .mockResolvedValueOnce(claimedFacts[1])
      .mockResolvedValueOnce(claimedFacts[2]);
    planAudnBatchMock.mockRejectedValueOnce(new Error("malformed batch"));
    planAudnMock.mockResolvedValue({
      decision: "NOOP",
      reasoning: "already represented",
    });

    const result = await promoteObservations({ maxFacts: 3 });

    expect(planAudnMock).toHaveBeenCalledTimes(3);
    expect(observationPromotionFactRepoMock.apply).toHaveBeenCalledTimes(3);
    expect(
      observationPromotionFactRepoMock.recordFailure,
    ).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      factBatchesSelected: 1,
      factBatchFallbacks: 1,
      factsCompleted: 3,
      factsDeferred: 0,
      errors: [],
    });
  });

  it("AUDN batch が同じ memory を複数更新する場合は単件で再判定する", async () => {
    const pendingFacts = [
      fact("pending", 0, "fact_1", "obs_1", 0),
      fact("pending", 0, "fact_2", "obs_1", 1),
    ];
    const claimedFacts = pendingFacts.map(claimedFact);
    observationPromotionFactRepoMock.listEligible.mockResolvedValueOnce(
      pendingFacts,
    );
    observationPromotionFactRepoMock.listEligibleForObservation.mockResolvedValueOnce(
      pendingFacts,
    );
    observationPromotionFactRepoMock.claim
      .mockResolvedValueOnce(claimedFacts[0])
      .mockResolvedValueOnce(claimedFacts[1]);
    planAudnBatchMock.mockResolvedValueOnce(
      claimedFacts.map((claimed) => ({
        factId: claimed.id,
        plan: {
          decision: "UPDATE",
          targetMemoryId: "mem_shared",
          narrative: claimed.fact,
          reasoning: "same target",
        },
      })),
    );
    planAudnMock.mockResolvedValue({
      decision: "NOOP",
      reasoning: "represented after sequential replan",
    });

    const result = await promoteObservations({ maxFacts: 2 });

    expect(planAudnBatchMock).toHaveBeenCalledTimes(1);
    expect(planAudnMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      factBatchesSelected: 1,
      factBatchFallbacks: 1,
      factsCompleted: 2,
      errors: [],
    });
  });

  it("異なる observation の fact を同じ AUDN batch に含めない", async () => {
    const first = fact("pending", 0, "fact_1", "obs_1", 0);
    const second = fact("pending", 0, "fact_2", "obs_2", 0);
    observationPromotionFactRepoMock.listEligible.mockResolvedValueOnce([
      first,
      second,
    ]);
    observationPromotionFactRepoMock.listEligibleForObservation.mockResolvedValueOnce([
      first,
    ]);
    observationPromotionFactRepoMock.claim.mockResolvedValueOnce(
      claimedFact(first),
    );
    planAudnMock.mockResolvedValueOnce({
      decision: "NOOP",
      reasoning: "already represented",
    });

    const result = await promoteObservations({ maxFacts: 1 });

    expect(planAudnBatchMock).not.toHaveBeenCalled();
    expect(observationPromotionFactRepoMock.claim).not.toHaveBeenCalledWith(
      second.id,
    );
    expect(result).toMatchObject({
      factsSelected: 1,
      factBatchesSelected: 0,
      factsCompleted: 1,
    });
  });
});
