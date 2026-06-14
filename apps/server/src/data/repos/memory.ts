import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../client.js";
import { memories } from "../schema.js";

export type MemoryRow = typeof memories.$inferSelect;
export type NewMemoryRow = typeof memories.$inferInsert;

/**
 * LLM 失敗時のクールダウンと quarantine 閾値 (Layer 2)。
 *
 * - 1 item が cooldownConsecutive 回連続で失敗すると cooldownMs だけ skip 対象
 * - 累積失敗が quarantineThreshold を超えると quarantine (永久 skip、手動レビュー対象)
 */
export const LLM_FAILURE_POLICY = {
  cooldownConsecutive: 3,
  cooldownMs: 24 * 60 * 60 * 1000, // 24h
  quarantineThreshold: 10,
} as const;

export const memoryRepo = {
  async insert(row: NewMemoryRow): Promise<void> {
    await db.insert(memories).values(row);
  },
  async findById(id: string): Promise<MemoryRow | null> {
    const rows = await db
      .select()
      .from(memories)
      .where(eq(memories.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  async listActive(limit = 100): Promise<MemoryRow[]> {
    return await db
      .select()
      .from(memories)
      .where(isNull(memories.archived_at))
      .limit(limit);
  },
  /**
   * LLM 処理対象として有効な (= archive 済みでも quarantine 済みでもなく、
   * cooldown 中でもない) active memory を返す。
   */
  async listLlmEligible(limit = 100): Promise<MemoryRow[]> {
    const cooldownCutoff = new Date(Date.now() - LLM_FAILURE_POLICY.cooldownMs);
    return await db
      .select()
      .from(memories)
      .where(
        and(
          isNull(memories.archived_at),
          isNull(memories.llm_quarantined_at),
          // cooldown: 連続失敗 N 回未満 OR 最終失敗時刻が cooldown 以前
          or(
            lt(
              memories.llm_failure_count,
              LLM_FAILURE_POLICY.cooldownConsecutive,
            ),
            isNull(memories.last_llm_failure_at),
            lt(memories.last_llm_failure_at, cooldownCutoff),
          ),
        ),
      )
      .limit(limit);
  },
  async update(id: string, patch: Partial<NewMemoryRow>): Promise<void> {
    await db
      .update(memories)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(memories.id, id));
  },
  async archive(id: string): Promise<void> {
    await db
      .update(memories)
      .set({ archived_at: sql`now()` })
      .where(eq(memories.id, id));
  },
  /**
   * LLM 処理失敗を記録。累積閾値を超えたら quarantine。
   */
  async recordLlmFailure(id: string): Promise<{ quarantined: boolean }> {
    const rows = await db
      .update(memories)
      .set({
        llm_failure_count: sql`${memories.llm_failure_count} + 1`,
        last_llm_failure_at: sql`now()`,
        llm_quarantined_at: sql`
          CASE
            WHEN ${memories.llm_failure_count} + 1 >= ${LLM_FAILURE_POLICY.quarantineThreshold}
              AND ${memories.llm_quarantined_at} IS NULL
            THEN now()
            ELSE ${memories.llm_quarantined_at}
          END
        `,
      })
      .where(eq(memories.id, id))
      .returning({ quarantined: memories.llm_quarantined_at });
    return { quarantined: rows[0]?.quarantined != null };
  },
  /**
   * LLM 処理成功時のリセット。
   */
  async resetLlmFailures(id: string): Promise<void> {
    await db
      .update(memories)
      .set({ llm_failure_count: 0, last_llm_failure_at: null })
      .where(eq(memories.id, id));
  },
};
