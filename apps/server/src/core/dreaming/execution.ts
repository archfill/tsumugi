import { TsumugiError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { dreamingRunRepo } from "../../data/repos/dreaming-run.js";
import type { DreamingJob } from "./runner.js";

export interface DreamingDrainResult {
  drained: boolean;
  runningJobs: DreamingJob[];
}

export class DreamingExecutionCoordinator {
  private readonly active = new Map<Promise<unknown>, DreamingJob>();
  private readonly shutdownController = new AbortController();
  private draining = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void dreamingRunRepo.heartbeatOwnedRunning().catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "dreaming run heartbeat failed",
        );
      });
    }, 30_000);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeatIfIdle(): void {
    if (this.active.size > 0 || !this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  run<T>(
    job: DreamingJob,
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.draining) {
      return Promise.reject(
        new TsumugiError("dreaming execution rejected during shutdown"),
      );
    }

    const effectiveSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    const promise = execute(effectiveSignal);
    this.active.set(promise, job);
    this.startHeartbeat();
    void promise.then(
      () => {
        this.active.delete(promise);
        this.stopHeartbeatIfIdle();
      },
      () => {
        this.active.delete(promise);
        this.stopHeartbeatIfIdle();
      },
    );
    return promise;
  }

  async drain(timeoutMs: number): Promise<DreamingDrainResult> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(
        "dreaming execution drain timeout must be a positive integer",
      );
    }

    this.draining = true;
    this.shutdownController.abort();
    const active = [...this.active.keys()];
    if (active.length === 0) {
      return { drained: true, runningJobs: [] };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(active).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);

    const runningJobs = [...new Set(this.active.values())];
    if (!drained) {
      logger.warn(
        { timeoutMs, runningJobs },
        "dreaming execution drain timeout exceeded",
      );
    } else {
      logger.info("dreaming executions drained");
    }
    return { drained, runningJobs };
  }

  getRunningJobs(): DreamingJob[] {
    return [...new Set(this.active.values())];
  }
}

export const dreamingExecutionCoordinator =
  new DreamingExecutionCoordinator();
