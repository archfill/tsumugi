import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const databaseUrl = process.env["DATABASE_URL"];
const destructiveGate = process.env["TSUMUGI_ALLOW_DESTRUCTIVE_TEST_DB"] === "true";

describe.skipIf(!databaseUrl || !destructiveGate)("actual HTTP and MCP runtime integration", () => {
  let runtime: Awaited<ReturnType<typeof import("../../src/interfaces/mcp/transport-http.js").startHttp>>;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    const { db } = await import("../../src/data/client.js");
    const { sql } = await import("drizzle-orm");
    const target = await db.execute<{ database: string }>(sql`SELECT current_database() AS database`);
    const host = new URL(databaseUrl!).hostname;
    if (target.rows[0]?.database !== "tsumugi" || !/^(127\.0\.0\.1|::1|localhost|tsumugi-postgres)$/iu.test(host)) {
      throw new Error("refusing runtime integration test against a non-test database target");
    }
    const { startHttp } = await import("../../src/interfaces/mcp/transport-http.js");
    runtime = await startHttp(0, {
      scheduler: { enabled: false, promoteCaptures: "", sweepCaptures: "", archiveOutdated: "" },
      shutdownDrainTimeoutMs: 5_000,
    });
    baseUrl = `http://127.0.0.1:${runtime.port}`;
    client = new Client({ name: "tsumugi-runtime-integration", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  });

  afterAll(async () => {
    await client?.close();
    await runtime?.shutdown();
  });

  it("starts REST health and MCP tool discovery without an LLM key", async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ status: "ok" });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["save_observation", "search_memory"]));
  });

  it("saves by actual MCP transport, searches by MCP and REST, then deletes by REST", async () => {
    const marker = `runtime-e2e-${Date.now()}`;
    const saved = await client.callTool({
      name: "save_observation",
      arguments: { content: `${marker} deterministic observation`, type: "progress", source: "other", project_tag: "it-runtime" },
    });
    const text = saved.content.find((item) => item.type === "text");
    if (text?.type !== "text") throw new Error("save_observation returned no text result");
    const savedResult = JSON.parse(text.text) as { id: string };
    expect(savedResult.id).toMatch(/^obs_/u);

    const searched = await client.callTool({
      name: "search_memory",
      arguments: { query: marker, limit: 5, filter: { project_tag: "it-runtime" } },
    });
    const searchText = searched.content.find((item) => item.type === "text");
    if (searchText?.type !== "text") throw new Error("search_memory returned no text result");
    expect((JSON.parse(searchText.text) as { hits: Array<{ id: string }> }).hits.map((hit) => hit.id)).toContain(savedResult.id);

    const restSearch = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(marker)}&project_tag=it-runtime`);
    expect(restSearch.status).toBe(200);
    expect((await restSearch.json() as { hits: Array<{ id: string }> }).hits.map((hit) => hit.id)).toContain(savedResult.id);

    const removed = await fetch(`${baseUrl}/api/observations/${savedResult.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
  });

  it("legacy LLM job is an actual transport-level no-op", async () => {
    const result = await client.callTool({ name: "trigger_dreaming", arguments: { job: "synthesize" } });
    const text = result.content.find((item) => item.type === "text");
    if (text?.type !== "text") throw new Error("trigger_dreaming returned no text result");
    expect(JSON.parse(text.text)).toMatchObject({
      job: "synthesize",
      steps: [{ name: "synthesize", ok: true, detail: { skipped: true, reason: "removed_server_llm" } }],
    });
  });
});
