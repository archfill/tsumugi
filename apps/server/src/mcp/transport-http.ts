import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpServer } from "./server.js";
import { restApp } from "../api/rest.js";

type Env = { Bindings: HttpBindings };

export async function startHttp(port: number): Promise<void> {
  const app = new Hono<Env>();
  app.route("/api", restApp);

  // Session registry: sessionId → transport
  const transports = new Map<string, SSEServerTransport>();

  // SSE endpoint — client opens a GET to establish the stream
  app.get("/mcp/sse", async (c) => {
    const { outgoing } = c.env;
    const res = outgoing as ServerResponse;

    const server = createMcpServer();
    const transport = new SSEServerTransport("/mcp/messages", res);
    transports.set(transport.sessionId, transport);

    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };

    await server.connect(transport);
    // server.connect calls transport.start() which writes SSE headers and keeps the response open
    // Return an empty response so Hono doesn't interfere
    return new Response(null, { status: 200 });
  });

  // Message endpoint — client POSTs JSON-RPC messages here
  app.post("/mcp/messages", async (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) {
      return c.json({ error: "sessionId required" }, 400);
    }

    const transport = transports.get(sessionId);
    if (!transport) {
      return c.json({ error: "no session found for sessionId" }, 404);
    }

    const { incoming, outgoing } = c.env;
    await transport.handlePostMessage(
      incoming as IncomingMessage,
      outgoing as ServerResponse,
    );

    return new Response(null, { status: 200 });
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  serve({ fetch: app.fetch, port });
  console.log(`tsumugi http listening on :${port}`);
}
