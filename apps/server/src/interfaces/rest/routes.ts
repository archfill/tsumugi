import { Hono } from "hono";
import { runDreaming } from "../../core/dreaming/runner.js";
import { hybridSearch } from "../../core/search/hybrid.js";
import { resolveSearchFilter } from "../../core/search/resolve-filter.js";
import { decisionRepo } from "../../data/repos/decision.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import { linkRepo } from "../../data/repos/link.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { observationRepo } from "../../data/repos/observation.js";
import { getActiveScheduler } from "../mcp/transport-http.js";

export const restApp = new Hono();

function readLimit(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function readOffset(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.trunc(parsed);
}

restApp.get("/observations", async (c) => {
  const limit = readLimit(c.req.query("limit"), 100, 500);
  const offset = readOffset(c.req.query("offset"));
  const [observations, total] = await Promise.all([
    observationRepo.listRecent(limit, offset),
    observationRepo.countAll(),
  ]);
  return c.json({ observations, total });
});

restApp.delete("/observations/:id", async (c) => {
  await observationRepo.deleteById(c.req.param("id"));
  return c.json({ ok: true });
});

restApp.get("/memories", async (c) => {
  const limit = readLimit(c.req.query("limit"), 100, 500);
  const offset = readOffset(c.req.query("offset"));
  const [memories, total] = await Promise.all([
    memoryRepo.listActive(limit, offset),
    memoryRepo.countActive(),
  ]);
  return c.json({ memories, total });
});

restApp.patch("/memories/:id", async (c) => {
  const body = (await c.req.json()) as {
    narrative?: string;
    importance?: number;
    kind?: string;
  };
  await memoryRepo.update(c.req.param("id"), {
    ...(body.narrative !== undefined ? { narrative: body.narrative } : {}),
    ...(body.importance !== undefined ? { importance: body.importance } : {}),
    ...(body.kind !== undefined ? { kind: body.kind } : {}),
  });
  return c.json({ ok: true });
});

restApp.post("/memories/:id/archive", async (c) => {
  await memoryRepo.archive(c.req.param("id"));
  return c.json({ ok: true });
});

restApp.get("/decisions", async (c) => {
  const limit = readLimit(c.req.query("limit"), 200, 500);
  const offset = readOffset(c.req.query("offset"));
  const [decisions, total] = await Promise.all([
    decisionRepo.listRecent(limit, offset),
    decisionRepo.countAll(),
  ]);
  return c.json({ decisions, total });
});

restApp.get("/links", async (c) => {
  const limit = readLimit(c.req.query("limit"), 500, 1000);
  const offset = readOffset(c.req.query("offset"));
  const [links, total] = await Promise.all([
    linkRepo.listRecent(limit, offset),
    linkRepo.countAll(),
  ]);
  return c.json({ links, total });
});

restApp.get("/search", async (c) => {
  const query = c.req.query("q");
  if (!query) {
    return c.json({ error: "query parameter 'q' is required" }, 400);
  }
  const limit = readLimit(c.req.query("limit"), 10, 50);
  const projectTagRaw = c.req.query("project_tag");
  const type = c.req.query("type");
  const source = c.req.query("source");
  const sessionId = c.req.query("session_id");

  // ADR-013 G: REST 側でも opt-out (null) を表現できるよう特別値
  //   ?project_tag=__null__  → 明示 opt-out
  //   ?project_tag=foo       → 通常フィルタ
  //   (省略)                  → 自動補完 (session_id があれば)
  const projectTag =
    projectTagRaw === "__null__" ? null : (projectTagRaw ?? undefined);

  const filter: {
    type?: string;
    source?: string;
    session_id?: string;
    project_tag?: string | null;
  } = {};
  if (projectTag !== undefined) filter.project_tag = projectTag;
  if (type) filter.type = type;
  if (source) filter.source = source;
  if (sessionId) filter.session_id = sessionId;

  try {
    const resolvedFilter = await resolveSearchFilter(
      Object.keys(filter).length > 0
        ? (filter as Parameters<typeof resolveSearchFilter>[0])
        : undefined,
    );
    const hits = await hybridSearch({
      query,
      limit,
      filter: resolvedFilter,
    });
    return c.json({ hits });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: message }, 400);
  }
});

restApp.post("/dreaming/trigger", async (c) => {
  const body = await c.req.json();
  const result = await runDreaming(body);
  return c.json(result);
});

restApp.get("/dreaming/runs", async (c) => {
  const limit = readLimit(c.req.query("limit"), 20, 100);
  const offset = readOffset(c.req.query("offset"));
  const [runs, total] = await Promise.all([
    dreamingRunRepo.listRecent(limit, offset),
    dreamingRunRepo.countAll(),
  ]);
  return c.json({ runs, total });
});

restApp.get("/scheduler", (c) => {
  const sched = getActiveScheduler();
  return c.json({
    enabled: sched !== null,
    jobs: sched?.jobs ?? [],
  });
});
