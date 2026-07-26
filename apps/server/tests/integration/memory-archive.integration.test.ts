import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env["DATABASE_URL"];
const destructiveGate = process.env["TSUMUGI_ALLOW_DESTRUCTIVE_TEST_DB"] === "true";
const prefix = "it49_";

describe.skipIf(!databaseUrl || !destructiveGate)("reversible memory archive PostgreSQL integration", () => {
  let db: typeof import("../../src/data/client.js").db;
  let sql: typeof import("drizzle-orm").sql;
  let memories: typeof import("../../src/data/schema.js").memories;
  let memoryArchiveRepo: typeof import("../../src/data/repos/memory-archive.js").memoryArchiveRepo;

  async function cleanup() {
    await db.execute(sql`DELETE FROM memory_archive_items WHERE batch_id LIKE ${`${prefix}%`}`);
    await db.execute(sql`DELETE FROM memory_archive_batches WHERE id LIKE ${`${prefix}%`}`);
    await db.execute(sql`DELETE FROM memories WHERE id LIKE ${`${prefix}%`}`);
  }

  beforeAll(async () => {
    ({ db } = await import("../../src/data/client.js"));
    ({ sql } = await import("drizzle-orm"));
    ({ memories } = await import("../../src/data/schema.js"));
    ({ memoryArchiveRepo } = await import("../../src/data/repos/memory-archive.js"));
    const target = await db.execute<{ database: string }>(sql`SELECT current_database() AS database`);
    const host = new URL(databaseUrl!).hostname;
    if (target.rows[0]?.database !== "tsumugi" || !/^(127\.0\.0\.1|::1|localhost|tsumugi-postgres)$/iu.test(host)) {
      throw new Error("refusing destructive integration test against a non-test database target");
    }
    await cleanup();
  });
  beforeEach(cleanup);
  afterAll(cleanup);

  it("exact duplicate plan applies and restores the same rows", async () => {
    const first = new Date("2026-01-01T00:00:00Z");
    const second = new Date("2026-01-02T00:00:00Z");
    await db.insert(memories).values([
      { id: "it49_mem_canonical", narrative: "Same   Narrative", created_at: first, updated_at: first },
      { id: "it49_mem_duplicate", narrative: " same narrative ", created_at: second, updated_at: second },
    ]);
    await expect(memoryArchiveRepo.listExactDuplicateCandidates(100)).resolves.toContainEqual({
      id: "it49_mem_duplicate",
      canonicalMemoryId: "it49_mem_canonical",
    });
    await memoryArchiveRepo.createPlan({
      id: "it49_batch_restore",
      reason: "exact_duplicate",
      criteria: { rawContent: false },
      candidates: [{ id: "it49_mem_duplicate", canonicalMemoryId: "it49_mem_canonical" }],
    });
    await expect(memoryArchiveRepo.applyPlan("it49_batch_restore", 1)).resolves.toBe(1);
    expect((await db.execute<{ archived_at: Date | null }>(sql`SELECT archived_at FROM memories WHERE id = 'it49_mem_duplicate'`)).rows[0]?.archived_at).not.toBeNull();
    await expect(memoryArchiveRepo.restoreBatch("it49_batch_restore", 1)).resolves.toBe(1);
    expect((await db.execute<{ archived_at: Date | null }>(sql`SELECT archived_at FROM memories WHERE id = 'it49_mem_duplicate'`)).rows[0]?.archived_at).toBeNull();
  });

  it("confirmation mismatch and state drift leave every target unchanged", async () => {
    await db.insert(memories).values({ id: "it49_mem_drift", narrative: "reviewed metadata" });
    await memoryArchiveRepo.createPlan({
      id: "it49_batch_drift",
      reason: "reviewed_metadata_noise",
      criteria: { reviewed: true },
      candidates: [{ id: "it49_mem_drift", canonicalMemoryId: null }],
    });
    await expect(memoryArchiveRepo.applyPlan("it49_batch_drift", 2)).rejects.toThrow("confirmation count");
    await db.execute(sql`UPDATE memories SET archived_at = now() WHERE id = 'it49_mem_drift'`);
    await expect(memoryArchiveRepo.applyPlan("it49_batch_drift", 1)).rejects.toThrow("target state changed");
    const batch = await db.execute<{ status: string }>(sql`SELECT status FROM memory_archive_batches WHERE id = 'it49_batch_drift'`);
    expect(batch.rows[0]?.status).toBe("planned");
  });
});
