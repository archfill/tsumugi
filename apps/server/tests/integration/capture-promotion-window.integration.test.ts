import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const databaseUrl = process.env["DATABASE_URL"];
const destructiveGate = process.env["TSUMUGI_ALLOW_DESTRUCTIVE_TEST_DB"] === "true";
const testPrefix = "it48_";

describe.skipIf(!databaseUrl || !destructiveGate)("capture promotion window PostgreSQL integration", () => {
  let db: typeof import("../../src/data/client.js").db;
  let sql: typeof import("drizzle-orm").sql;
  let captures: typeof import("../../src/data/schema.js").captures;
  let capturePromotionWindows: typeof import("../../src/data/schema.js").capturePromotionWindows;
  let observations: typeof import("../../src/data/schema.js").observations;
  let memories: typeof import("../../src/data/schema.js").memories;
  let links: typeof import("../../src/data/schema.js").links;
  let retireLegacyCaptureWindows: typeof import("../../src/core/capture/retire-legacy.js").retireLegacyCaptureWindows;
  let capturePromotionWindowRepo: typeof import("../../src/data/repos/capture-promotion-window.js").capturePromotionWindowRepo;

  beforeAll(async () => {
    ({ db } = await import("../../src/data/client.js"));
    ({ sql } = await import("drizzle-orm"));
    ({ captures, capturePromotionWindows, observations, memories, links } = await import("../../src/data/schema.js"));
    ({ retireLegacyCaptureWindows } = await import("../../src/core/capture/retire-legacy.js"));
    ({ capturePromotionWindowRepo } = await import("../../src/data/repos/capture-promotion-window.js"));
    const target = await db.execute<{ database: string; host: string | null }>(sql`
      SELECT current_database() AS database, inet_server_addr()::text AS host
    `);
    const database = target.rows[0]?.database ?? "";
    const host = new URL(databaseUrl!).hostname;
    if (
      database !== "tsumugi" ||
      /prod|production/i.test(database) ||
      !/^(127\.0\.0\.1|::1|localhost|tsumugi-postgres)$/i.test(host)
    ) {
      throw new Error("refusing destructive integration test against a non-test database target");
    }
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function cleanup() {
    await db.execute(sql`
      DELETE FROM capture_observation_links
      WHERE capture_id LIKE ${`${testPrefix}%`}
         OR window_id LIKE ${`${testPrefix}%`}
    `);
    await db.execute(sql`DELETE FROM links WHERE from_id LIKE ${`${testPrefix}%`} OR to_id LIKE ${`${testPrefix}%`}`);
    await db.execute(sql`
      DELETE FROM observation_promotion_facts
      WHERE observation_id LIKE ${`${testPrefix}%`}
    `);
    await db.execute(sql`
      UPDATE captures SET promoted_to_obs_id = NULL
      WHERE id LIKE ${`${testPrefix}%`}
         OR promoted_to_obs_id LIKE ${`${testPrefix}%`}
    `);
    await db.execute(sql`
      UPDATE capture_promotion_windows SET observation_id = NULL
      WHERE id LIKE ${`${testPrefix}%`}
         OR observation_id LIKE ${`${testPrefix}%`}
    `);
    await db.execute(sql`DELETE FROM observations WHERE id LIKE ${`${testPrefix}%`}`);
    await db.execute(sql`DELETE FROM memories WHERE id LIKE ${`${testPrefix}%`}`);
    await db.execute(sql`DELETE FROM captures WHERE id LIKE ${`${testPrefix}%`}`);
    await db.execute(sql`DELETE FROM capture_promotion_windows WHERE id LIKE ${`${testPrefix}%`}`);
  }

  it("dry-run/applyは同一planで、3 turnのStopだけを再キューしrerunは0件", async () => {
    await db.insert(capturePromotionWindows).values({
      id: "it48_win_legacy",
      source: "codex",
      session_id: "it48_ses_legacy",
      promotion_kind: "window",
      status: "pending",
      cutoff_at: new Date(),
      capture_count: 6,
      raw_chars: 60,
      completed_turns: 3,
      fallback: false,
      input_content: "legacy",
    });
    await db.insert(captures).values(
      [1, 2, 3].flatMap((turn) => [
        {
          id: `it48_cap_user_${turn}`,
          session_id: "it48_ses_legacy",
          source: "codex",
          hook_event: "UserPromptSubmit",
          turn_id: `turn_${turn}`,
          content_hash: `u${turn}`,
          raw_content: "raw user",
          promotion_state: "windowed",
          promotion_window_id: "it48_win_legacy",
        },
        {
          id: `it48_cap_stop_${turn}`,
          session_id: "it48_ses_legacy",
          source: "codex",
          hook_event: "Stop",
          turn_id: `turn_${turn}`,
          continuity_content: `checkpoint ${turn}`,
          content_hash: `s${turn}`,
          raw_content: "raw stop",
          promotion_state: "windowed",
          promotion_window_id: "it48_win_legacy",
        },
      ]),
    );
    const plan = await retireLegacyCaptureWindows();
    expect(plan).toMatchObject({ eligible: 1, unsafe: 0, releasedStops: 3, retired: 0 });
    const applied = await retireLegacyCaptureWindows({ apply: true, expectedEligible: 1 });
    expect(applied).toMatchObject({ retired: 1, releasedStops: 3, blocked: false });
    const states = await db.execute<{ hook_event: string; promotion_state: string }>(sql`
      SELECT hook_event, promotion_state FROM captures WHERE session_id = 'it48_ses_legacy' ORDER BY id
    `);
    expect(states.rows.filter((row) => row.hook_event === "Stop").every((row) => row.promotion_state === "ready")).toBe(true);
    expect(states.rows.filter((row) => row.hook_event !== "Stop").every((row) => row.promotion_state === "skipped")).toBe(true);
    expect(await retireLegacyCaptureWindows()).toMatchObject({ eligible: 0, unsafe: 0 });
  });

  it("same-key concurrent insert creates one deterministic window", async () => {
    const base = {
      source: "codex",
      session_id: "it48_ses_key",
      project_tag: null,
      captured_at: new Date(),
      continuity_content: "checkpoint",
    };
    await db.insert(captures).values([
      { id: "it48_cap_key_1", ...base, hook_event: "Stop", content_hash: "k1", raw_content: "{}" },
      { id: "it48_cap_key_2", ...base, hook_event: "Stop", content_hash: "k1", raw_content: "{}" },
    ]);
    await Promise.all([
      capturePromotionWindowRepo.createDeterministicStop({ id: "it48_win_key_1", promotionKey: "stop:v1:codex:it48_ses_key:k1", capture: { ...base, id: "it48_cap_key_1" } }),
      capturePromotionWindowRepo.createDeterministicStop({ id: "it48_win_key_2", promotionKey: "stop:v1:codex:it48_ses_key:k1", capture: { ...base, id: "it48_cap_key_2" } }),
    ]);
    const rows = await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM capture_promotion_windows WHERE promotion_key = 'stop:v1:codex:it48_ses_key:k1'`);
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });

  it("unsafe legacyが混在するとapplyは全件を変更しない", async () => {
    await db.insert(capturePromotionWindows).values([
      { id: "it48_win_safe", source: "codex", session_id: "it48_ses_safe", promotion_kind: "window", status: "pending", cutoff_at: new Date(), capture_count: 1, raw_chars: 1, completed_turns: 1, fallback: false },
      { id: "it48_win_unsafe", source: "codex", session_id: "it48_ses_unsafe", promotion_kind: "window", status: "pending", cutoff_at: new Date(), capture_count: 2, raw_chars: 1, completed_turns: 1, fallback: false },
    ]);
    await db.insert(captures).values({ id: "it48_cap_safe", session_id: "it48_ses_safe", source: "codex", hook_event: "Stop", continuity_content: "safe", content_hash: "safe", raw_content: "{}", promotion_state: "windowed", promotion_window_id: "it48_win_safe" });
    const plan = await retireLegacyCaptureWindows();
    expect(plan).toMatchObject({ eligible: 1, unsafe: 1, blocked: true });
    const applied = await retireLegacyCaptureWindows({ apply: true, expectedEligible: 1 });
    expect(applied).toMatchObject({ blocked: true, retired: 0 });
    const unchanged = await db.execute<{ promotion_state: string }>(sql`SELECT promotion_state FROM captures WHERE id = 'it48_cap_safe'`);
    expect(unchanged.rows[0]?.promotion_state).toBe("windowed");
  });

  it("CAS driftはapply前の追加eligibleを検知して全件を変更しない", async () => {
    await db.insert(capturePromotionWindows).values({ id: "it48_win_cas_1", source: "codex", session_id: "it48_ses_cas", promotion_kind: "window", status: "pending", cutoff_at: new Date(), capture_count: 1, raw_chars: 1, completed_turns: 1, fallback: false });
    await db.insert(captures).values({ id: "it48_cap_cas_1", session_id: "it48_ses_cas", source: "codex", hook_event: "Stop", continuity_content: "one", content_hash: "one", raw_content: "{}", promotion_state: "windowed", promotion_window_id: "it48_win_cas_1" });
    expect(await retireLegacyCaptureWindows()).toMatchObject({ eligible: 1 });
    await db.insert(capturePromotionWindows).values({ id: "it48_win_cas_2", source: "codex", session_id: "it48_ses_cas", promotion_kind: "window", status: "pending", cutoff_at: new Date(), capture_count: 1, raw_chars: 1, completed_turns: 1, fallback: false });
    await db.insert(captures).values({ id: "it48_cap_cas_2", session_id: "it48_ses_cas", source: "codex", hook_event: "Stop", continuity_content: "two", content_hash: "two", raw_content: "{}", promotion_state: "windowed", promotion_window_id: "it48_win_cas_2" });
    expect(await retireLegacyCaptureWindows({ apply: true, expectedEligible: 1 })).toMatchObject({ eligible: 2, blocked: true, retired: 0 });
    const rows = await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM captures WHERE id IN ('it48_cap_cas_1', 'it48_cap_cas_2') AND promotion_state = 'windowed'`);
    expect(Number(rows.rows[0]?.count)).toBe(2);
  });

  it("valid Stopだけをreadyにし、empty StopとUserPromptを理由付きskipにする", async () => {
    await db.insert(capturePromotionWindows).values({ id: "it48_win_mixed", source: "codex", session_id: "it48_ses_mixed", promotion_kind: "window", status: "pending", cutoff_at: new Date(), capture_count: 3, raw_chars: 3, completed_turns: 1, fallback: false });
    await db.insert(captures).values([
      { id: "it48_cap_valid", session_id: "it48_ses_mixed", source: "codex", hook_event: "Stop", continuity_content: "valid", content_hash: "v", raw_content: "{}", promotion_state: "windowed", promotion_window_id: "it48_win_mixed" },
      { id: "it48_cap_empty", session_id: "it48_ses_mixed", source: "codex", hook_event: "Stop", continuity_content: " ", content_hash: "e", raw_content: "{}", promotion_state: "windowed", promotion_window_id: "it48_win_mixed" },
      { id: "it48_cap_user", session_id: "it48_ses_mixed", source: "codex", hook_event: "UserPromptSubmit", content_hash: "u", raw_content: "raw", promotion_state: "windowed", promotion_window_id: "it48_win_mixed" },
    ]);
    await retireLegacyCaptureWindows({ apply: true, expectedEligible: 1 });
    const rows = await db.execute<{ id: string; promotion_state: string; skip_reason: string | null }>(sql`SELECT id, promotion_state, skip_reason FROM captures WHERE session_id = 'it48_ses_mixed'`);
    expect(rows.rows.find((row) => row.id === "it48_cap_valid")).toMatchObject({ promotion_state: "ready", skip_reason: null });
    expect(rows.rows.filter((row) => row.id !== "it48_cap_valid").every((row) => row.promotion_state === "skipped" && row.skip_reason)).toBe(true);
    expect(Number((await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM captures WHERE session_id = 'it48_ses_mixed' AND promotion_state = 'windowed'`)).rows[0]?.count)).toBe(0);
  });

  it("terminal windowをreviveするとcompleted_atをclearしactive countを再集計する", async () => {
    const now = new Date();
    await db.insert(capturePromotionWindows).values({ id: "it48_win_revive", source: "codex", session_id: "it48_ses_revive", promotion_kind: "stop_checkpoint", promotion_key: "stop:v1:codex:it48_ses_revive:key", status: "quarantined", cutoff_at: now, capture_count: 1, raw_chars: 1, completed_turns: 1, fallback: false, completed_at: now });
    await db.insert(captures).values({ id: "it48_cap_revive", session_id: "it48_ses_revive", source: "codex", hook_event: "Stop", continuity_content: "revived", content_hash: "key", raw_content: "{}" });
    await capturePromotionWindowRepo.createDeterministicStop({ id: "it48_unused", promotionKey: "stop:v1:codex:it48_ses_revive:key", capture: { id: "it48_cap_revive", source: "codex", session_id: "it48_ses_revive", project_tag: null, captured_at: now, continuity_content: "revived" } });
    const row = await db.execute<{ status: string; completed_at: Date | null; capture_count: number; raw_chars: number }>(sql`SELECT status, completed_at, capture_count, raw_chars FROM capture_promotion_windows WHERE id = 'it48_win_revive'`);
    expect(row.rows[0]).toMatchObject({ status: "pending", completed_at: null, capture_count: 1, raw_chars: 7 });
  });

  it("completion ownership mismatch rolls back observation and links", async () => {
    const now = new Date();
    await db.insert(capturePromotionWindows).values({ id: "it48_win_owner", source: "codex", session_id: "it48_ses_owner", promotion_kind: "stop_checkpoint", promotion_key: "stop:v1:codex:it48_ses_owner:key", status: "processing", attempt_count: 1, cutoff_at: now, capture_count: 1, raw_chars: 1, completed_turns: 1, fallback: false });
    await db.insert(captures).values({ id: "it48_cap_owner", session_id: "it48_ses_owner", source: "codex", hook_event: "Stop", continuity_content: "owner", content_hash: "key", raw_content: "{}", promotion_state: "ready" });
    const window = await capturePromotionWindowRepo.findById("it48_win_owner");
    await expect(capturePromotionWindowRepo.completeDeterministicStop({ window: window!, captureIds: ["it48_cap_owner"], observation: { id: "it48_obs_owner", content: "owner", type: "other", source: "codex", source_layer: "capture", session_id: "it48_ses_owner", facts: null, metadata: {}, embedding: null, created_at: now, promoted_at: now, promotion_state: "completed" } })).rejects.toThrow("ownership");
    expect(Number((await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM observations WHERE id = 'it48_obs_owner'`)).rows[0]?.count)).toBe(0);
  });

  it("completed key retry attaches existing observation without creating another", async () => {
    const now = new Date();
    await db.insert(observations).values({ id: "it48_obs_done", content: "done", type: "other", source: "codex", source_layer: "capture", session_id: "it48_ses_done", facts: null, metadata: {}, embedding: null, created_at: now, promoted_at: now, promotion_state: "completed" });
    await db.insert(capturePromotionWindows).values({ id: "it48_win_done", source: "codex", session_id: "it48_ses_done", promotion_kind: "stop_checkpoint", promotion_key: "stop:v1:codex:it48_ses_done:key", status: "completed", observation_id: "it48_obs_done", cutoff_at: now, capture_count: 1, raw_chars: 1, completed_turns: 1, fallback: false });
    await db.insert(captures).values({ id: "it48_cap_done", session_id: "it48_ses_done", source: "codex", hook_event: "Stop", continuity_content: "done", content_hash: "key", raw_content: "{}" });
    await capturePromotionWindowRepo.createDeterministicStop({ id: "it48_unused_done", promotionKey: "stop:v1:codex:it48_ses_done:key", capture: { id: "it48_cap_done", source: "codex", session_id: "it48_ses_done", project_tag: null, captured_at: now, continuity_content: "done" } });
    expect(Number((await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM observations WHERE session_id = 'it48_ses_done'`)).rows[0]?.count)).toBe(1);
    expect(Number((await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM capture_observation_links WHERE capture_id = 'it48_cap_done' AND observation_id = 'it48_obs_done'`)).rows[0]?.count)).toBe(1);
  });

  it("candidate限定derived_fromだけを検索抑止対象として返す", async () => {
    const { linkRepo } = await import("../../src/data/repos/link.js");
    const now = new Date();
    await db.insert(observations).values([
      { id: "it48_obs_in", content: "o", type: "other", source: "codex", facts: null, metadata: {}, embedding: null, created_at: now, promotion_state: "completed" },
      { id: "it48_obs_out", content: "o", type: "other", source: "codex", facts: null, metadata: {}, embedding: null, created_at: now, promotion_state: "completed" },
    ]);
    await db.insert(memories).values([
      { id: "it48_mem_derived", narrative: "m", embedding: null, created_at: now, updated_at: now },
      { id: "it48_mem_related", narrative: "m", embedding: null, created_at: now, updated_at: now },
      { id: "it48_mem_out", narrative: "m", embedding: null, created_at: now, updated_at: now },
    ]);
    await db.insert(links).values([
      { from_id: "it48_obs_in", from_layer: "observation", to_id: "it48_mem_derived", to_layer: "memory", relation: "derived_from" },
      { from_id: "it48_obs_in", from_layer: "observation", to_id: "it48_mem_related", to_layer: "memory", relation: "related_to" },
      { from_id: "it48_obs_out", from_layer: "observation", to_id: "it48_mem_out", to_layer: "memory", relation: "derived_from" },
    ]);
    await expect(linkRepo.listMemoryIdsDirectlyDerivedFromCandidates({ observationIds: ["it48_obs_in"], memoryIds: ["it48_mem_derived", "it48_mem_related"] })).resolves.toEqual(["it48_mem_derived"]);
  });
});
