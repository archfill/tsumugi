import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../client.js";
import { dreamingRuns } from "../schema.js";

export type DreamingRunRow = typeof dreamingRuns.$inferSelect;
export type NewDreamingRunRow = typeof dreamingRuns.$inferInsert;

export const dreamingRunRepo = {
  async insert(row: NewDreamingRunRow): Promise<void> {
    await db.insert(dreamingRuns).values(row);
  },
  async update(id: string, patch: Partial<NewDreamingRunRow>): Promise<void> {
    await db.update(dreamingRuns).set(patch).where(eq(dreamingRuns.id, id));
  },
  async markRunning(id: string): Promise<void> {
    await db
      .update(dreamingRuns)
      .set({ status: "running", started_at: sql`now()` })
      .where(eq(dreamingRuns.id, id));
  },
  async markCompleted(
    id: string,
    outputCount: number,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await db
      .update(dreamingRuns)
      .set({
        status: "completed",
        finished_at: sql`now()`,
        output_count: outputCount,
        ...(metadata !== undefined ? { metadata } : {}),
      })
      .where(eq(dreamingRuns.id, id));
  },
  async markPartial(
    id: string,
    outputCount: number,
    error: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await db
      .update(dreamingRuns)
      .set({
        status: "partial",
        finished_at: sql`now()`,
        output_count: outputCount,
        error_message: error.slice(0, 1000),
        ...(metadata !== undefined ? { metadata } : {}),
      })
      .where(eq(dreamingRuns.id, id));
  },
  async markFailed(
    id: string,
    error: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await db
      .update(dreamingRuns)
      .set({
        status: "failed",
        finished_at: sql`now()`,
        error_message: error.slice(0, 1000),
        ...(metadata !== undefined ? { metadata } : {}),
      })
      .where(eq(dreamingRuns.id, id));
  },
  async findRunningByKind(jobKind: string): Promise<DreamingRunRow | null> {
    const rows = await db
      .select()
      .from(dreamingRuns)
      .where(
        and(eq(dreamingRuns.job_kind, jobKind), eq(dreamingRuns.status, "running")),
      )
      .orderBy(desc(dreamingRuns.started_at))
      .limit(1);
    return rows[0] ?? null;
  },
  async markStaleRunning(
    jobKind: string,
    staleBefore: Date,
    reason: string,
  ): Promise<number> {
    const rows = await db
      .update(dreamingRuns)
      .set({
        status: "failed",
        finished_at: sql`now()`,
        error_message: reason.slice(0, 1000),
        metadata: {
          stoppedReason: "stale_running",
          staleBefore: staleBefore.toISOString(),
        },
      })
      .where(
        and(
          eq(dreamingRuns.job_kind, jobKind),
          eq(dreamingRuns.status, "running"),
          lt(dreamingRuns.started_at, staleBefore),
        ),
      )
      .returning({ id: dreamingRuns.id });
    return rows.length;
  },
  async listRecent(limit = 20, offset = 0): Promise<DreamingRunRow[]> {
    return await db
      .select()
      .from(dreamingRuns)
      .orderBy(desc(dreamingRuns.started_at))
      .limit(limit)
      .offset(offset);
  },
  async countAll(): Promise<number> {
    const r = await db.execute<{ n: number }>(
      sql`SELECT COUNT(*)::int AS n FROM dreaming_runs`,
    );
    return Number(r.rows[0]?.n ?? 0);
  },
};
