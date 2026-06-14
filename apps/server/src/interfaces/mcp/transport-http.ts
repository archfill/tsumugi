import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "./server.js";
import { restApp } from "../rest/routes.js";

type Env = { Bindings: HttpBindings };
type StreamableTransport = WebStandardStreamableHTTPServerTransport;

export async function startHttp(port: number): Promise<void> {
  const app = new Hono<Env>();
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

  app.get("/health", (c) => c.json({ status: "ok" }));

  serve({ fetch: app.fetch, port });
  console.log(`tsumugi http listening on :${port}`);
}
