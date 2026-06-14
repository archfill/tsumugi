import { Hono } from "hono";
import { runDreaming } from "../../core/dreaming/runner.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";

export const restApp = new Hono();

restApp.get("/observations", (c) => c.json({ note: "admin REST is Phase 3" }));
restApp.get("/memories", (c) => c.json({ note: "admin REST is Phase 3" }));

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
