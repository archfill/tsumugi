// Tsumugi MCP server entrypoint (placeholder)
// Wires up:
//   - MCP server (HTTP/SSE + stdio modes)  → ./mcp
//   - Admin REST API for UI               → ./api
//   - Postgres connection                  → ./db
//   - Embedding (BGE-M3 via xenova)        → ./embedding
//   - Dreaming worker (cron / on-demand)   → ./dreaming
//
// Implementation comes in Phase 1.

function main(): void {
  throw new Error("tsumugi server is not implemented yet");
}

main();
