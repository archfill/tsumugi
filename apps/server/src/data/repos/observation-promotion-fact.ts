import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { TsumugiError } from "../../lib/errors.js";
import { db } from "../client.js";
import {
  links,
  memories,
  observationPromotionFacts,
  observations,
  type NewObservationPromotionFact,
} from "../schema.js";

export type ObservationPromotionFactRow =
  typeof observationPromotionFacts.$inferSelect;

export const FACT_QUARANTINE_THRESHOLD = 5;

export const observationPromotionFactRepo = {
  async seed(
    observationId: string,
    facts: NewObservationPromotionFact[],
  ): Promise<void> {
    await db.transaction(async (tx) => {
      if (facts.length > 0) {
        await tx
          .insert(observationPromotionFacts)
          .values(facts)
          .onConflictDoNothing();
        await tx
          .update(observations)
          .set({
            promotion_state: "processing",
            promotion_failure_count: 0,
            promotion_next_attempt_at: new Date(),
            promotion_last_failure_at: null,
            promotion_last_error: null,
          })
          .where(eq(observations.id, observationId));
      } else {
        await tx
          .update(observations)
          .set({
            promotion_state: "completed",
            promoted_at: new Date(),
            promotion_failure_count: 0,
            promotion_next_attempt_at: new Date(),
            promotion_last_failure_at: null,
            promotion_last_error: null,
          })
          .where(eq(observations.id, observationId));
      }
    });
  },

  async listEligible(limit = 50): Promise<ObservationPromotionFactRow[]> {
    const now = new Date();
    return await db
      .select()
      .from(observationPromotionFacts)
      .where(
        and(
          lte(observationPromotionFacts.next_attempt_at, now),
          or(
            eq(observationPromotionFacts.status, "pending"),
            eq(observationPromotionFacts.status, "deferred"),
            and(
              eq(observationPromotionFacts.status, "processing"),
              lte(observationPromotionFacts.lease_expires_at, now),
            ),
          ),
        ),
      )
      .orderBy(asc(observationPromotionFacts.created_at))
      .limit(limit);
  },

  async countOutstanding(): Promise<number> {
    const result = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM observation_promotion_facts
      WHERE status IN ('pending', 'deferred', 'processing', 'committing')
    `);
    return Number(result.rows[0]?.count ?? 0);
  },

  async claim(
    id: string,
    leaseMs = 10 * 60 * 1000,
  ): Promise<ObservationPromotionFactRow | null> {
    const now = new Date();
    const rows = await db
      .update(observationPromotionFacts)
      .set({
        status: "processing",
        attempt_count: sql`${observationPromotionFacts.attempt_count} + 1`,
        lease_expires_at: new Date(now.getTime() + leaseMs),
        updated_at: now,
      })
      .where(
        and(
          eq(observationPromotionFacts.id, id),
          lte(observationPromotionFacts.next_attempt_at, now),
          ne(observationPromotionFacts.status, "completed"),
          or(
            eq(observationPromotionFacts.status, "pending"),
            eq(observationPromotionFacts.status, "deferred"),
            and(
              eq(observationPromotionFacts.status, "processing"),
              lte(observationPromotionFacts.lease_expires_at, now),
            ),
          ),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  async apply(params: {
    fact: ObservationPromotionFactRow;
    decision: "ADD" | "UPDATE" | "DELETE" | "NOOP";
    narrative?: string;
    targetMemoryId?: string;
    resultMemoryId?: string;
    embedding?: number[];
    reasoning: string;
  }): Promise<void> {
    const now = new Date();
    await db.transaction(async (tx) => {
      const owned = await tx
        .update(observationPromotionFacts)
        .set({ status: "committing", updated_at: now })
        .where(
          and(
            eq(observationPromotionFacts.id, params.fact.id),
            eq(observationPromotionFacts.status, "processing"),
            eq(
              observationPromotionFacts.attempt_count,
              params.fact.attempt_count,
            ),
          ),
        )
        .returning({ id: observationPromotionFacts.id });
      if (!owned[0]) {
        throw new TsumugiError("observation promotion fact lease was superseded");
      }
      let relation: "derived_from" | "supersedes" | null = null;
      let linkedMemoryId: string | null = null;
      if (params.decision === "ADD") {
        linkedMemoryId = params.resultMemoryId!;
        relation = "derived_from";
        await tx.insert(memories).values({
          id: linkedMemoryId,
          narrative: params.narrative ?? params.fact.fact,
          importance: 5.0,
          kind: "general",
          embedding: params.embedding,
        });
      } else if (params.decision === "UPDATE") {
        linkedMemoryId = params.targetMemoryId!;
        relation = "derived_from";
        const updated = await tx
          .update(memories)
          .set({
            narrative: params.narrative ?? params.fact.fact,
            ...(params.embedding !== undefined
              ? { embedding: params.embedding }
              : {}),
            updated_at: now,
          })
          .where(
            and(eq(memories.id, linkedMemoryId), isNull(memories.archived_at)),
          )
          .returning({ id: memories.id });
        if (!updated[0]) {
          throw new TsumugiError("AUDN update target is no longer active");
        }
      } else if (params.decision === "DELETE") {
        linkedMemoryId = params.targetMemoryId!;
        relation = "supersedes";
        const archived = await tx
          .update(memories)
          .set({ archived_at: now, updated_at: now })
          .where(
            and(eq(memories.id, linkedMemoryId), isNull(memories.archived_at)),
          )
          .returning({ id: memories.id });
        if (!archived[0]) {
          throw new TsumugiError("AUDN delete target is no longer active");
        }
      }

      if (linkedMemoryId && relation) {
        await tx
          .insert(links)
          .values({
            from_id: params.fact.observation_id,
            to_id: linkedMemoryId,
            from_layer: "observation",
            to_layer: "memory",
            relation,
          })
          .onConflictDoNothing();
      }

      await tx
        .update(observationPromotionFacts)
        .set({
          status: "completed",
          decision: params.decision,
          target_memory_id: params.targetMemoryId ?? null,
          result_memory_id: params.resultMemoryId ?? linkedMemoryId,
          reasoning: params.reasoning,
          lease_expires_at: null,
          last_error: null,
          completed_at: now,
          updated_at: now,
        })
        .where(eq(observationPromotionFacts.id, params.fact.id));

      const incomplete = await tx.execute<{ exists: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM observation_promotion_facts
          WHERE observation_id = ${params.fact.observation_id}
            AND status <> 'completed'
        ) AS exists
      `);
      if (!incomplete.rows[0]?.exists) {
        await tx
          .update(observations)
          .set({ promotion_state: "completed", promoted_at: now })
          .where(eq(observations.id, params.fact.observation_id));
      }
    });
  },

  async recordFailure(
    fact: ObservationPromotionFactRow,
    error: string,
    options?: { countsTowardQuarantine?: boolean },
  ): Promise<{ quarantined: boolean; updated: boolean }> {
    const failureCount =
      fact.failure_count + (options?.countsTowardQuarantine === false ? 0 : 1);
    const quarantined = failureCount >= FACT_QUARANTINE_THRESHOLD;
    const delayMs = Math.min(
      24 * 60 * 60 * 1000,
      60_000 * 2 ** Math.max(0, failureCount - 1),
    );
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(observationPromotionFacts)
        .set({
          status: quarantined ? "quarantined" : "deferred",
          next_attempt_at: new Date(Date.now() + delayMs),
          lease_expires_at: null,
          last_error: error,
          failure_count: failureCount,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(observationPromotionFacts.id, fact.id),
            eq(observationPromotionFacts.status, "processing"),
            eq(observationPromotionFacts.attempt_count, fact.attempt_count),
          ),
        )
        .returning({ id: observationPromotionFacts.id });
      if (rows[0] && quarantined) {
        await tx
          .update(observations)
          .set({ promotion_state: "quarantined" })
          .where(eq(observations.id, fact.observation_id));
      }
      return rows.length === 1;
    });
    return { quarantined, updated };
  },
};
