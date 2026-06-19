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
import {
  TRIGGER_DREAMING_TOOL,
  handleTriggerDreaming,
} from "./tools/trigger-dreaming.js";
import {
  GET_DREAMING_STATUS_TOOL,
  handleGetDreamingStatus,
} from "./tools/get-dreaming-status.js";
import {
  MARK_MEMORY_OUTDATED_TOOL,
  handleMarkMemoryOutdated,
} from "./tools/mark-memory-outdated.js";

export function createMcpServer(): Server {
  const server = new Server(
    { name: "tsumugi", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      SAVE_OBSERVATION_TOOL,
      SEARCH_MEMORY_TOOL,
      MARK_MEMORY_OUTDATED_TOOL,
      TRIGGER_DREAMING_TOOL,
      GET_DREAMING_STATUS_TOOL,
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    let result: unknown;

    if (name === "save_observation") {
      result = await handleSaveObservation(args);
    } else if (name === "search_memory") {
      result = await handleSearchMemory(args);
    } else if (name === "mark_memory_outdated") {
      result = await handleMarkMemoryOutdated(args);
    } else if (name === "trigger_dreaming") {
      result = await handleTriggerDreaming(args);
    } else if (name === "get_dreaming_status") {
      result = await handleGetDreamingStatus(args);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  });

  return server;
}
