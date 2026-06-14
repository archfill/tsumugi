import { Hono } from "hono";
import { runDreaming } from "../../core/dreaming/runner.js";
import { decisionRepo } from "../../data/repos/decision.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import { linkRepo } from "../../data/repos/link.js";
import { memoryRepo } from "../../data/repos/memory.js";
import { observationRepo } from "../../data/repos/observation.js";

export const restApp = new Hono();

function readLimit(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

restApp.get("/observations", async (c) => {
  const limit = readLimit(c.req.query("limit"), 100, 500);
  const observations = await observationRepo.listRecent(limit);
  return c.json({ observations });
});

restApp.delete("/observations/:id", async (c) => {
  await observationRepo.deleteById(c.req.param("id"));
  return c.json({ ok: true });
});

restApp.get("/memories", async (c) => {
  const limit = readLimit(c.req.query("limit"), 100, 500);
  const memories = await memoryRepo.listActive(limit);
  return c.json({ memories });
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
  const decisions = await decisionRepo.listRecent(limit);
  return c.json({ decisions });
});

restApp.get("/links", async (c) => {
  const limit = readLimit(c.req.query("limit"), 500, 1000);
  const links = await linkRepo.listRecent(limit);
  return c.json({ links });
});

restApp.post("/dreaming/trigger", async (c) => {
  const body = await c.req.json();
  const result = await runDreaming(body);
  return c.json(result);
});

restApp.get("/dreaming/runs", async (c) => {
  const limit = Number(c.req.query("limit") ?? 20);
  const runs = await dreamingRunRepo.listRecent(Math.min(limit, 100));
  return c.json({ runs });
});
