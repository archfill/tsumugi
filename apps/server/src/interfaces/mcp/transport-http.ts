import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server.js";
import { restApp } from "../rest/routes.js";
import { loadConfig } from "../../lib/config.js";
import { logger } from "../../lib/logger.js";
import {
  startScheduler,
  type SchedulerHandle,
} from "../../core/dreaming/scheduler.js";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  registry,
} from "../../lib/metrics.js";
import { collectDbGauges } from "../../data/metrics-collector.js";
import { db } from "../../data/client.js";
import { sql } from "drizzle-orm";

let activeScheduler: SchedulerHandle | null = null;

export function getActiveScheduler(): SchedulerHandle | null {
  return activeScheduler;
}

type Env = { Bindings: HttpBindings };
type StreamableTransport = WebStandardStreamableHTTPServerTransport;

/** Bucket request paths so we don't explode label cardinality on dynamic ids. */
function routeLabel(method: string, path: string): string {
  // Strip query string
  const p = path.split("?", 1)[0] ?? path;
  // Normalize REST patterns: /api/observations/<uuid> → /api/observations/:id
  // Quick heuristic: any segment with >=8 chars looking like an id/uuid.
  return p
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8,}/i.test(seg)) return ":id";
      if (/^[0-9]+$/.test(seg)) return ":n";
      return seg;
    })
    .join("/");
}

export async function startHttp(port: number): Promise<void> {
  const app = new Hono<Env>();

  // HTTP metrics middleware (must be first)
  app.use("*", async (c, next) => {
    const start = process.hrtime.bigint();
    const method = c.req.method;
    const path = c.req.path;
    try {
      await next();
    } finally {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = routeLabel(method, path);
      const status = String(c.res.status);
      httpRequestDurationSeconds.observe({ route, method }, seconds);
      httpRequestsTotal.inc({ route, method, status });
    }
  });

  app.route("/api", restApp);

  // Session registry: sessionId → transport
  const transports = new Map<string, StreamableTransport>();

  async function createTransport(): Promise<StreamableTransport> {
    const server = createMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        transports.delete(sessionId);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };
    await server.connect(transport);
    return transport;
  }

  app.all("/mcp", async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId) {
        return c.json(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          },
          404,
        );
      }
      transport = await createTransport();
    }

    return transport.handleRequest(c.req.raw);
  });

  app.get("/health", async (c) => {
    const components: Record<
      string,
      { ok: boolean; detail?: Record<string, unknown> }
    > = {};

    // DB ping
    try {
      const start = Date.now();
      await db.execute(sql`SELECT 1`);
      components["database"] = {
        ok: true,
        detail: { latencyMs: Date.now() - start },
      };
    } catch (err) {
      components["database"] = {
        ok: false,
        detail: { error: err instanceof Error ? err.message : String(err) },
      };
    }

    // Scheduler
    const sched = getActiveScheduler();
    components["scheduler"] = {
      ok: sched !== null,
      detail: { jobs: sched?.jobs.length ?? 0 },
    };

    // Embedder: read warmup gauge from registry
    const embedderMetric = await registry.getSingleMetric(
      "tsumugi_embedder_warmed_up",
    );
    let embedderWarmed = false;
    if (embedderMetric) {
      const v = await embedderMetric.get();
      embedderWarmed = (v.values[0]?.value ?? 0) > 0;
    }
    components["embedder"] = {
      ok: true,
      detail: { warmedUp: embedderWarmed },
    };

    const allOk = Object.values(components).every((c) => c.ok);
    return c.json(
      {
        status: allOk ? "ok" : "degraded",
        components,
      },
      allOk ? 200 : 503,
    );
  });

  // Prometheus metrics endpoint
  app.get("/metrics", async (c) => {
    await collectDbGauges();
    c.header("Content-Type", registry.contentType);
    return c.body(await registry.metrics());
  });

  serve({ fetch: app.fetch, port });
  logger.info({ port, mode: "http" }, "tsumugi http server listening");

  // Start dreaming scheduler (http mode only; stdio is short-lived).
  const config = loadConfig();
  activeScheduler = startScheduler(config.scheduler);
}
