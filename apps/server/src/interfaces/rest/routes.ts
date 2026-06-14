import { Hono } from "hono";

export const restApp = new Hono();

restApp.get("/observations", (c) => c.json({ note: "admin REST is Phase 3" }));
restApp.get("/memories", (c) => c.json({ note: "admin REST is Phase 3" }));
