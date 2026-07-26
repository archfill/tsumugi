import { eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import {
  memories,
  memoryArchiveBatches,
  memoryArchiveItems,
} from "../schema.js";
import { ValidationError } from "../../lib/errors.js";

export interface MemoryArchiveCandidate extends Record<string, unknown> {
  id: string;
  canonicalMemoryId: string | null;
}

function textArray(values: string[]) {
  if (values.length === 0) return sql`ARRAY[]::text[]`;
  return sql`ARRAY[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

export const memoryArchiveRepo = {
  async listExactDuplicateCandidates(limit: number): Promise<MemoryArchiveCandidate[]> {
    const result = await db.execute<MemoryArchiveCandidate>(sql`
      WITH active AS (
        SELECT
          id,
          lower(regexp_replace(trim(narrative), '\\s+', ' ', 'g')) AS normalized,
          row_number() OVER (
            PARTITION BY lower(regexp_replace(trim(narrative), '\\s+', ' ', 'g'))
            ORDER BY created_at ASC, id ASC
          ) AS rank,
          first_value(id) OVER (
            PARTITION BY lower(regexp_replace(trim(narrative), '\\s+', ' ', 'g'))
            ORDER BY created_at ASC, id ASC
          ) AS canonical_id,
          count(*) OVER (
            PARTITION BY lower(regexp_replace(trim(narrative), '\\s+', ' ', 'g'))
          ) AS duplicate_count
        FROM memories
        WHERE archived_at IS NULL
      )
      SELECT id, canonical_id AS "canonicalMemoryId"
      FROM active
      WHERE duplicate_count > 1 AND rank > 1
      ORDER BY canonical_id, id
      LIMIT ${limit + 1}
    `);
    if (result.rows.length > limit) {
      throw new ValidationError(`memory archive candidate limit exceeded (${limit})`);
    }
    return result.rows;
  },

  async listReviewedActiveCandidates(ids: string[]): Promise<MemoryArchiveCandidate[]> {
    if (ids.length === 0) return [];
    const idsArray = textArray(ids);
    const result = await db.execute<MemoryArchiveCandidate>(sql`
      SELECT id, NULL::text AS "canonicalMemoryId"
      FROM memories
      WHERE id = ANY(${idsArray}) AND archived_at IS NULL
      ORDER BY id
    `);
    if (result.rows.length !== new Set(ids).size) {
      throw new ValidationError("reviewed candidate set contains missing or already archived memories");
    }
    return result.rows;
  },

  async createPlan(input: {
    id: string;
    reason: "exact_duplicate" | "reviewed_metadata_noise";
    criteria: Record<string, unknown>;
    candidates: MemoryArchiveCandidate[];
  }): Promise<void> {
    if (input.candidates.length === 0) {
      throw new ValidationError("memory archive plan requires at least one candidate");
    }
    await db.transaction(async (tx) => {
      await tx.insert(memoryArchiveBatches).values({
        id: input.id,
        reason: input.reason,
        criteria: input.criteria,
        candidate_count: input.candidates.length,
      });
      await tx.insert(memoryArchiveItems).values(
        input.candidates.map((candidate) => ({
          batch_id: input.id,
          memory_id: candidate.id,
          reason_code: input.reason,
          canonical_memory_id: candidate.canonicalMemoryId,
          was_archived: false,
          archived_at_before: null,
        })),
      );
    });
  },

  async applyPlan(batchId: string, expectedCount: number): Promise<number> {
    return await db.transaction(async (tx) => {
      const batchResult = await tx.execute<{
        status: string;
        candidateCount: number;
      }>(sql`
        SELECT status, candidate_count::int AS "candidateCount"
        FROM memory_archive_batches
        WHERE id = ${batchId}
        FOR UPDATE
      `);
      const batch = batchResult.rows[0];
      if (batch === undefined || batch.status !== "planned") {
        throw new ValidationError("memory archive batch is not in planned state");
      }
      if (batch.candidateCount !== expectedCount) {
        throw new ValidationError("memory archive confirmation count does not match plan");
      }
      const appliedAt = new Date();
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE memories m
        SET archived_at = ${appliedAt}, updated_at = now()
        FROM memory_archive_items i
        WHERE i.batch_id = ${batchId}
          AND i.memory_id = m.id
          AND i.was_archived = false
          AND m.archived_at IS NULL
        RETURNING m.id
      `);
      if (updated.rows.length !== expectedCount) {
        throw new ValidationError("memory archive target state changed after planning");
      }
      await tx
        .update(memoryArchiveBatches)
        .set({
          status: "applied",
          archived_count: updated.rows.length,
          applied_at: appliedAt,
        })
        .where(eq(memoryArchiveBatches.id, batchId));
      return updated.rows.length;
    });
  },

  async restoreBatch(batchId: string, expectedCount: number): Promise<number> {
    return await db.transaction(async (tx) => {
      const batchResult = await tx.execute<{
        status: string;
        archivedCount: number;
        appliedAt: Date | null;
      }>(sql`
        SELECT
          status,
          archived_count::int AS "archivedCount",
          applied_at AS "appliedAt"
        FROM memory_archive_batches
        WHERE id = ${batchId}
        FOR UPDATE
      `);
      const batch = batchResult.rows[0];
      if (batch === undefined || batch.status !== "applied" || batch.appliedAt === null) {
        throw new ValidationError("memory archive batch is not restorable");
      }
      if (batch.archivedCount !== expectedCount) {
        throw new ValidationError("memory restore confirmation count does not match batch");
      }
      const restored = await tx.execute<{ id: string }>(sql`
        UPDATE memories m
        SET archived_at = i.archived_at_before, updated_at = now()
        FROM memory_archive_items i
        WHERE i.batch_id = ${batchId}
          AND i.memory_id = m.id
          AND m.archived_at = ${batch.appliedAt}
        RETURNING m.id
      `);
      if (restored.rows.length !== expectedCount) {
        throw new ValidationError("memory archive rows changed after batch apply");
      }
      await tx
        .update(memoryArchiveBatches)
        .set({ status: "restored", restored_at: new Date() })
        .where(eq(memoryArchiveBatches.id, batchId));
      return restored.rows.length;
    });
  },
};
