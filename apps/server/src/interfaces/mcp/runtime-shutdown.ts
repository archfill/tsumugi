import { dreamingExecutionCoordinator } from "../../core/dreaming/execution.js";
import { logger } from "../../lib/logger.js";

export interface RuntimeShutdownResult {
  drained: boolean;
  runningJobs: string[];
}

interface ShutdownRuntimeOptions {
  timeoutMs: number;
  close: () => Promise<void>;
  forceClose?: () => void;
}

export async function shutdownRuntimeWithinDeadline(
  options: ShutdownRuntimeOptions,
): Promise<RuntimeShutdownResult> {
  const drainPromise = dreamingExecutionCoordinator.drain(options.timeoutMs);
  const closePromise = options.close().then(
    () => true,
    (err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "runtime close failed during shutdown",
      );
      return false;
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    Promise.all([drainPromise, closePromise]).then(([drain, closed]) => ({
      timedOut: false as const,
      drain,
      closed,
    })),
    new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), options.timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (completed.timedOut) {
    options.forceClose?.();
    return {
      drained: false,
      runningJobs: dreamingExecutionCoordinator.getRunningJobs(),
    };
  }

  return {
    drained: completed.drain.drained && completed.closed,
    runningJobs: completed.drain.runningJobs,
  };
}
