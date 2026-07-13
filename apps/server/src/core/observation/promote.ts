import { createHash } from "node:crypto";
import { withPgAdvisoryLock } from "../../data/advisory-lock.js";
import { observationRepo } from "../../data/repos/observation.js";
import { observationPromotionFactRepo } from "../../data/repos/observation-promotion-fact.js";
import { getEmbedder } from "../../external/embedding/singleton.js";
import { assertLlmAvailable } from "../../external/llm/singleton.js";
import { ProviderUnavailableError } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import { planAudn } from "../dreaming/audn.js";
import { summarizeObservation } from "./summarize.js";

export interface PromoteObservationsResult {
  observationsPrepared: number;
  observationsSkipped: number;
  observationsDeferred: number;
  observationsQuarantined: number;
  factsSelected: number;
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

export async function promoteObservations(options?: {
  maxObservations?: number;
  maxFacts?: number;
  maxRunMs?: number;
  maxFailures?: number;
}): Promise<PromoteObservationsResult> {
  const maxObservations = options?.maxObservations ?? 50;
  const maxFacts = options?.maxFacts ?? 50;
  const maxRunMs = options?.maxRunMs ?? 10 * 60 * 1000;
  const maxFailures = options?.maxFailures ?? 5;
  return await withPgAdvisoryLock(
    "tsumugi:promote-observations",
    () =>
      promoteObservationsLocked({
        maxObservations,
        maxFacts,
        maxRunMs,
        maxFailures,
      }),
    async () => ({
      observationsPrepared: 0,
      observationsSkipped: 0,
      observationsDeferred: 0,
      observationsQuarantined: 0,
      factsSelected: 0,
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
}): Promise<PromoteObservationsResult> {
  const startedAt = Date.now();
  let observationsPrepared = 0;
  let observationsSkipped = 0;
  let observationsDeferred = 0;
  let observationsQuarantined = 0;
  let factsCompleted = 0;
  let factsSelected = 0;
  let factsDeferred = 0;
  let factsQuarantined = 0;
  let failures = 0;
  let stoppedReason: PromoteObservationsResult["stoppedReason"] = "completed";
  const errors: string[] = [];
  let pendingObservations:
    | Awaited<ReturnType<typeof observationRepo.listPending>>
    | undefined;

  while (factsSelected < options.maxFacts) {
    if (Date.now() - startedAt >= options.maxRunMs) {
      stoppedReason = "run_budget_exceeded";
      break;
    }
    if (failures >= options.maxFailures) {
      stoppedReason = "failure_budget_exceeded";
      break;
    }

    const [fact] = await observationPromotionFactRepo.listEligible(1);
    if (!fact) {
      if ((await observationPromotionFactRepo.countOutstanding()) > 0) {
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
    const claimedFact = await observationPromotionFactRepo.claim(fact.id);
    if (!claimedFact) continue;
    factsSelected++;
    try {
      const plan = await planAudn({ newFact: claimedFact.fact });
      const narrative = plan.narrative ?? claimedFact.fact;
      const needsEmbedding = plan.decision === "ADD" || plan.decision === "UPDATE";
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
      factsCompleted++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failure = await observationPromotionFactRepo.recordFailure(
        claimedFact,
        message,
        { countsTowardQuarantine: !(err instanceof ProviderUnavailableError) },
      );
      if (failure.updated) {
        if (failure.quarantined) factsQuarantined++;
        else factsDeferred++;
      }
      errors.push(
        `fact(${claimedFact.id}, obs=${claimedFact.observation_id}): ${message}`,
      );
      if (err instanceof ProviderUnavailableError) {
        stoppedReason = "provider_cooldown";
        break;
      }
      failures++;
    }
  }

  return {
    observationsPrepared,
    observationsSkipped,
    observationsDeferred,
    observationsQuarantined,
    factsSelected,
    factsCompleted,
    factsDeferred,
    factsQuarantined,
    runSkipped: false,
    stoppedReason,
    errors,
  };
}
