import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  SAVE_OBSERVATION_TOOL,
  handleSaveObservation,
} from "./tools/save-observation.js";
import {
  SEARCH_MEMORY_TOOL,
  handleSearchMemory,
} from "./tools/search-memory.js";

export function createMcpServer(): Server {
  const server = new Server(
    { name: "tsumugi", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [SAVE_OBSERVATION_TOOL, SEARCH_MEMORY_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    let result: unknown;

    if (name === "save_observation") {
      result = await handleSaveObservation(args);
    } else if (name === "search_memory") {
      result = await handleSearchMemory(args);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  });

  return server;
}
