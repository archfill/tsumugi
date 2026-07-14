import { createHash } from "node:crypto";
import { withPgAdvisoryLock } from "../../data/advisory-lock.js";
import { observationRepo } from "../../data/repos/observation.js";
import {
  observationPromotionFactRepo,
  type ObservationPromotionFactRow,
} from "../../data/repos/observation-promotion-fact.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { assertLlmAvailable } from "../../external/llm/singleton.js";
import {
  ProviderUnavailableError,
  ValidationError,
} from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import { logger } from "../../lib/logger.js";
import {
  planAudn,
  planAudnBatch,
  type AudnPlan,
} from "../dreaming/audn.js";
import { summarizeObservation } from "./summarize.js";
import {
  DEFAULT_MAX_OUTSTANDING_FACTS,
  isBackpressureActive,
} from "../promotion/backpressure.js";

export interface PromoteObservationsResult {
  observationsPrepared: number;
  observationsSkipped: number;
  observationsDeferred: number;
  observationsQuarantined: number;
  factsSelected: number;
  factBatchesSelected: number;
  factBatchFallbacks: number;
  factsCompleted: number;
  factsDeferred: number;
  factsQuarantined: number;
  runSkipped: boolean;
  stoppedReason:
    | "completed"
    | "active_run_in_progress"
    | "run_budget_exceeded"
    | "failure_budget_exceeded"
    | "provider_cooldown"
    | "waiting_for_retry";
  errors: string[];
}

function factRows(observationId: string, facts: string[]) {
  const unique = [...new Set(facts.map((fact) => fact.trim()).filter(Boolean))];
  return unique.map((fact, ordinal) => ({
    id: newId("fact"),
    observation_id: observationId,
    fact_hash: createHash("sha256").update(fact).digest("hex"),
    fact,
    ordinal,
  }));
}

const DEFAULT_FACT_BATCH_SIZE = 3;

async function applyFactPlan(
  claimedFact: ObservationPromotionFactRow,
  plan: AudnPlan,
): Promise<void> {
  const narrative = plan.narrative ?? claimedFact.fact;
  const needsEmbedding =
    plan.decision === "ADD" || plan.decision === "UPDATE";
  const embedding = needsEmbedding
    ? Array.from(await getEmbedder().embed(narrative))
    : undefined;
  const resultMemoryId =
    plan.decision === "ADD" ? newId("mem") : plan.targetMemoryId;
  await observationPromotionFactRepo.apply({
    fact: claimedFact,
    decision: plan.decision,
    narrative: plan.narrative,
    targetMemoryId: plan.targetMemoryId,
    resultMemoryId,
    embedding,
    reasoning: plan.reasoning,
  });
}

export async function promoteObservations(options?: {
  maxObservations?: number;
  maxFacts?: number;
  maxRunMs?: number;
  maxFailures?: number;
  maxOutstandingFacts?: number;
  factBatchSize?: number;
}): Promise<PromoteObservationsResult> {
  const maxObservations = options?.maxObservations ?? 50;
  const maxFacts = options?.maxFacts ?? 50;
  const maxRunMs = options?.maxRunMs ?? 10 * 60 * 1000;
  const maxFailures = options?.maxFailures ?? 5;
  const maxOutstandingFacts =
    options?.maxOutstandingFacts ?? DEFAULT_MAX_OUTSTANDING_FACTS;
  const factBatchSize = options?.factBatchSize ?? DEFAULT_FACT_BATCH_SIZE;
  if (!Number.isInteger(factBatchSize) || factBatchSize < 1) {
    throw new ValidationError("factBatchSize must be a positive integer");
  }
  return await withPgAdvisoryLock(
    "tsumugi:promote-observations",
    () =>
      promoteObservationsLocked({
        maxObservations,
        maxFacts,
        maxRunMs,
        maxFailures,
        maxOutstandingFacts,
        factBatchSize,
      }),
    async () => ({
      observationsPrepared: 0,
      observationsSkipped: 0,
      observationsDeferred: 0,
      observationsQuarantined: 0,
      factsSelected: 0,
      factBatchesSelected: 0,
      factBatchFallbacks: 0,
      factsCompleted: 0,
      factsDeferred: 0,
      factsQuarantined: 0,
      runSkipped: true,
      stoppedReason: "active_run_in_progress",
      errors: [],
    }),
  );
}

async function promoteObservationsLocked(options: {
  maxObservations: number;
  maxFacts: number;
  maxRunMs: number;
  maxFailures: number;
  maxOutstandingFacts: number;
  factBatchSize: number;
}): Promise<PromoteObservationsResult> {
  const startedAt = Date.now();
  let observationsPrepared = 0;
  let observationsSkipped = 0;
  let observationsDeferred = 0;
  let observationsQuarantined = 0;
  let factsCompleted = 0;
  let factsSelected = 0;
  let factBatchesSelected = 0;
  let factBatchFallbacks = 0;
  let factsDeferred = 0;
  let factsQuarantined = 0;
  let failures = 0;
  let stoppedReason: PromoteObservationsResult["stoppedReason"] = "completed";
  const errors: string[] = [];
  let pendingObservations:
    | Awaited<ReturnType<typeof observationRepo.listPending>>
    | undefined;

  const recordClaimFailure = async (
    claimedFact: ObservationPromotionFactRow,
    err: unknown,
  ): Promise<boolean> => {
    const message = err instanceof Error ? err.message : String(err);
    const providerUnavailable = err instanceof ProviderUnavailableError;
    const failure = await observationPromotionFactRepo.recordFailure(
      claimedFact,
      message,
      { countsTowardQuarantine: !providerUnavailable },
    );
    if (failure.updated) {
      if (failure.quarantined) factsQuarantined++;
      else factsDeferred++;
    }
    errors.push(
      `fact(${claimedFact.id}, obs=${claimedFact.observation_id}): ${message}`,
    );
    if (!providerUnavailable) failures++;
    return providerUnavailable;
  };

  const runSinglePlans = async (
    claimedFacts: ObservationPromotionFactRow[],
  ): Promise<boolean> => {
    for (let index = 0; index < claimedFacts.length; index++) {
      const claimedFact = claimedFacts[index]!;
      try {
        const plan = await planAudn({ newFact: claimedFact.fact });
        await applyFactPlan(claimedFact, plan);
        factsCompleted++;
      } catch (err) {
        const providerUnavailable = await recordClaimFailure(claimedFact, err);
        if (providerUnavailable) {
          for (const remainingFact of claimedFacts.slice(index + 1)) {
            await recordClaimFailure(remainingFact, err);
          }
          return true;
        }
      }
    }
    return false;
  };

  promotionLoop: while (factsSelected < options.maxFacts) {
    if (Date.now() - startedAt >= options.maxRunMs) {
      stoppedReason = "run_budget_exceeded";
      break;
    }
    if (failures >= options.maxFailures) {
      stoppedReason = "failure_budget_exceeded";
      break;
    }

    const remainingFactBudget = options.maxFacts - factsSelected;
    const [firstFact] = await observationPromotionFactRepo.listEligible(1);
    if (!firstFact) {
      const outstandingFacts =
        await observationPromotionFactRepo.countOutstanding();
      if (
        isBackpressureActive(
          outstandingFacts,
          options.maxOutstandingFacts,
        )
      ) {
        stoppedReason = "waiting_for_retry";
        break;
      }
      pendingObservations ??= await observationRepo.listPending(
        options.maxObservations,
      );
      const observation = pendingObservations.shift();
      if (!observation) break;
      try {
        assertLlmAvailable("mid");
        let facts = observation.facts ?? [];
        if (facts.length === 0) {
          assertLlmAvailable("low");
          const summary = await summarizeObservation(observation);
          if (summary.skip) {
            await observationRepo.markSkipped(observation.id);
            observationsSkipped++;
            continue;
          }
          facts = summary.facts;
          await observationRepo.updateFactsAndMetadata(observation.id, {
            facts,
            metadata: {
              ...(observation.metadata ?? {}),
              promotion_reasoning: summary.reasoning,
            },
          });
        }
        await observationPromotionFactRepo.seed(
          observation.id,
          factRows(observation.id, facts),
        );
        observationsPrepared++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`prepare(obs=${observation.id}): ${message}`);
        if (err instanceof ProviderUnavailableError) {
          stoppedReason = "provider_cooldown";
          break;
        }
        const outcome = await observationRepo.recordPromotionFailure(
          observation,
          message,
        );
        if (outcome.updated) {
          if (outcome.quarantined) observationsQuarantined++;
          else observationsDeferred++;
        }
        failures++;
      }
      continue;
    }

    try {
      assertLlmAvailable("mid");
    } catch (err) {
      stoppedReason = "provider_cooldown";
      errors.push(err instanceof Error ? err.message : String(err));
      break;
    }
    const batchCandidates =
      await observationPromotionFactRepo.listEligibleForObservation(
        firstFact.observation_id,
        Math.min(options.factBatchSize, remainingFactBudget),
      );
    const claimedFacts: ObservationPromotionFactRow[] = [];
    for (const fact of batchCandidates) {
      const claimedFact = await observationPromotionFactRepo.claim(fact.id);
      if (!claimedFact) continue;
      claimedFacts.push(claimedFact);
      factsSelected++;
    }
    if (claimedFacts.length === 0) continue;

    if (claimedFacts.length === 1) {
      if (await runSinglePlans(claimedFacts)) {
        stoppedReason = "provider_cooldown";
        break;
      }
      continue;
    }

    factBatchesSelected++;
    let plans: AudnPlan[];
    try {
      const plannedFacts = await planAudnBatch(
        claimedFacts.map((fact) => ({ factId: fact.id, newFact: fact.fact })),
      );
      const planByFactId = new Map(
        plannedFacts.map(({ factId, plan }) => [factId, plan]),
      );
      plans = claimedFacts.map((fact) => {
        const plan = planByFactId.get(fact.id);
        if (!plan) {
          throw new ValidationError(
            `AUDN batch result missing claimed fact_id "${fact.id}"`,
          );
        }
        return plan;
      });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        for (const claimedFact of claimedFacts) {
          await recordClaimFailure(claimedFact, err);
        }
        stoppedReason = "provider_cooldown";
        break promotionLoop;
      }
      factBatchFallbacks++;
      logger.warn(
        {
          observationId: firstFact.observation_id,
          factCount: claimedFacts.length,
          error: err instanceof Error ? err.message : String(err),
        },
        "observation promotion: AUDN batch planning failed; retrying facts singly",
      );
      if (await runSinglePlans(claimedFacts)) {
        stoppedReason = "provider_cooldown";
        break promotionLoop;
      }
      continue;
    }

    const mutationTargets = plans
      .filter((plan) => plan.decision === "UPDATE" || plan.decision === "DELETE")
      .map((plan) => plan.targetMemoryId)
      .filter((target): target is string => target !== undefined);
    if (new Set(mutationTargets).size !== mutationTargets.length) {
      factBatchFallbacks++;
      logger.warn(
        {
          observationId: firstFact.observation_id,
          factCount: claimedFacts.length,
        },
        "observation promotion: AUDN batch targets conflict; replanning facts singly",
      );
      if (await runSinglePlans(claimedFacts)) {
        stoppedReason = "provider_cooldown";
        break;
      }
      continue;
    }

    for (let index = 0; index < claimedFacts.length; index++) {
      const claimedFact = claimedFacts[index]!;
      try {
        await applyFactPlan(claimedFact, plans[index]!);
        factsCompleted++;
      } catch (err) {
        const providerUnavailable = await recordClaimFailure(claimedFact, err);
        if (providerUnavailable) {
          for (const remainingFact of claimedFacts.slice(index + 1)) {
            await recordClaimFailure(remainingFact, err);
          }
          stoppedReason = "provider_cooldown";
          break promotionLoop;
        }
      }
    }
  }

  return {
    observationsPrepared,
    observationsSkipped,
    observationsDeferred,
    observationsQuarantined,
    factsSelected,
    factBatchesSelected,
    factBatchFallbacks,
    factsCompleted,
    factsDeferred,
    factsQuarantined,
    runSkipped: false,
    stoppedReason,
    errors,
  };
}
