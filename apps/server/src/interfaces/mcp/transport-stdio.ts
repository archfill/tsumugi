import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";
import {
  shutdownRuntimeWithinDeadline,
  type RuntimeShutdownResult,
} from "./runtime-shutdown.js";

export interface StdioRuntime {
  shutdown: () => Promise<RuntimeShutdownResult>;
}

export async function startStdio(
  shutdownDrainTimeoutMs: number,
): Promise<StdioRuntime> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shutdownPromise: Promise<RuntimeShutdownResult> | undefined;
  return {
    shutdown: () => {
      shutdownPromise ??= shutdownRuntimeWithinDeadline({
        timeoutMs: shutdownDrainTimeoutMs,
        close: () => transport.close(),
      });
      return shutdownPromise;
    },
  };
}
