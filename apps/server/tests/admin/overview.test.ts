import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const executeMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/data/client.js", () => ({
  db: { execute: executeMock },
}));

const { adminRepo } = await import("../../src/data/repos/admin.js");
const dialect = new PgDialect();

function normalizeSql(statement: SQL): string {
  return dialect.sqlToQuery(statement).sql.replaceAll(/\s+/g, " ").trim();
}

describe("Admin overview operational accuracy", () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockResolvedValue({ rows: [] });
  });

  it("capture oldest actionableをworkerのlistReady条件に合わせる", async () => {
    await adminRepo.getOverview({});

    const captureSummary = executeMock.mock.calls
      .map(([statement]) => normalizeSql(statement))
      .find(
        (query) =>
          query.includes("FROM captures c") &&
          query.includes("oldest_actionable_at"),
      );

    expect(captureSummary).toContain("c.promotion_state = 'ready'");
    expect(captureSummary).toContain("c.promoted_to_obs_id IS NULL");
    expect(captureSummary).toContain("c.skip_reason IS NULL");
    expect(captureSummary).not.toContain("'windowed'");
  });

  it("current attentionとfailed/partial run履歴を別集計にする", async () => {
    const overview = await adminRepo.getOverview({ project: "tsumugi" });
    const runQueries = executeMock.mock.calls
      .map(([statement]) => normalizeSql(statement))
      .filter((query) => query.includes("FROM dreaming_runs"));

    expect(runQueries).toHaveLength(2);
    expect(runQueries).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "r.status = 'running' AND r.started_at < now() - interval '2 hours'",
        ),
        expect.stringContaining("status IN ('failed', 'partial')"),
      ]),
    );
    const historyQuery = runQueries.find((query) =>
      query.includes("SELECT COUNT(*)::int AS count FROM dreaming_runs"),
    );
    expect(historyQuery).not.toContain("false");
    expect(overview).toMatchObject({
      attention_count: 0,
      history_issue_count: 0,
    });
  });

  it("current attention件数とissue一覧で同じfilter scopeを使う", async () => {
    const scope = {
      project: "tsumugi",
      source: "codex" as const,
      state: "quarantined",
      query: "provider",
      from: new Date("2026-07-14T00:00:00.000Z"),
      to: new Date("2026-07-15T23:59:59.999Z"),
    };

    await adminRepo.getOverview(scope);
    const attentionQuery = executeMock.mock.calls
      .map(([statement]) => normalizeSql(statement))
      .find(
        (query) =>
          query.startsWith("WITH issues AS") &&
          query.includes("SELECT COUNT(*)::int AS count FROM issues"),
      );

    executeMock.mockClear();
    await adminRepo.listOperationIssues({ ...scope, limit: 50 });
    const listQuery = normalizeSql(executeMock.mock.calls[0][0]);

    for (const fragment of [
      "issues.project_tag = $1",
      "issues.source = $2",
      "issues.state = $3",
      "issues.occurred_at >= $4",
      "issues.occurred_at <= $5",
      "issues.id ILIKE $6",
    ]) {
      expect(attentionQuery).toContain(fragment);
      expect(listQuery).toContain(fragment);
    }
  });

  it("current issue一覧からfailed/partial run履歴を除外する", async () => {
    await adminRepo.listOperationIssues({ limit: 50 });

    const query = normalizeSql(executeMock.mock.calls[0][0]);
    expect(query).toContain("r.status = 'running'");
    expect(query).not.toContain("r.status IN ('failed', 'partial')");
    expect(query).toContain("w.status = 'deferred' AND w.next_attempt_at <= now()");
    expect(query).toContain("f.status = 'deferred' AND f.next_attempt_at <= now()");
  });
});
