/**
 * Dreaming scheduler — node-cron で dreaming jobs を定期実行する。
 *
 * 設計:
 *   - http モードでのみ起動 (stdio は短命プロセス想定なので scheduler 不要)
 *   - 各 job は cron 式で個別 schedule。空文字列で無効化。
 *   - 同一 job が前回実行中なら新規 trigger を skip (lock 機構)
 *   - 実行履歴は既存の dreamingRunRepo / runner に乗る
 *
 * Default schedule:
 *   - promote-captures           : minute 0,30     (0,30 * * * *)
 *   - promote-observations       : minute 5,35     (5,35 * * * *)
 *   - sweep-captures             : daily 02:30    (30 2 * * *)
 *   - synthesize                 : every 6 hours  (0 *\/6 * * *)
 *   - time-update                : daily 03:00    (0 3 * * *)
 *   - decision-contradiction     : weekly Sun 04  (0 4 * * 0)
 *
 * 環境変数:
 *   DREAMING_SCHEDULER_ENABLED               = "false" で全停止
 *   DREAMING_SCHEDULE_PROMOTE_CAPTURES       = "0,30 * * * *"
 *   DREAMING_SCHEDULE_PROMOTE_OBSERVATIONS   = "5,35 * * * *"
 *   DREAMING_SCHEDULE_SWEEP_CAPTURES         = "30 2 * * *"
 *   DREAMING_SCHEDULE_SYNTHESIZE             = "0 *\/6 * * *"
 *   DREAMING_SCHEDULE_TIME_UPDATE            = "0 3 * * *"
 *   DREAMING_SCHEDULE_DECISION_CONTRADICTION = "0 4 * * 0"
 */

import * as cron from "node-cron";
import type { SchedulerConfig } from "../../lib/config.js";
import { logger } from "../../lib/logger.js";
import { runDreaming, type DreamingJob } from "./runner.js";

interface ScheduledTask {
  job: DreamingJob;
  cronExpr: string;
  task: cron.ScheduledTask;
}

async function runScheduledJob(
  job: DreamingJob,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await runDreaming({ job, signal });
    const status = result.steps.every((step) => step.ok)
      ? "completed"
      : "partial";
    logger.info(
      {
        job,
        status,
        durationMs: Date.now() - startedAt,
        steps: result.steps.map((step) => ({
          name: step.name,
          ok: step.ok,
          stoppedReason:
            step.detail && typeof step.detail === "object"
              ? (step.detail as { stoppedReason?: unknown }).stoppedReason
              : undefined,
        })),
      },
      "scheduled dreaming job completed",
    );
  } catch (err) {
    logger.error(
      {
        job,
        durationMs: Date.now() - startedAt,
        err: err instanceof Error ? err.message : String(err),
      },
      "scheduled dreaming job failed",
    );
  }
}

function scheduleOne(
  job: DreamingJob,
  cronExpr: string,
  tasks: ScheduledTask[],
  trigger: (job: DreamingJob) => void,
): void {
  if (!cronExpr || cronExpr.trim() === "") {
    logger.info({ job }, "scheduler: job disabled (empty cron expression)");
    return;
  }
  if (!cron.validate(cronExpr)) {
    logger.error({ job, cronExpr }, "scheduler: invalid cron expression");
    return;
  }
  const task = cron.schedule(cronExpr, () => {
    trigger(job);
  });
  task.start();
  tasks.push({ job, cronExpr, task });
  logger.info({ job, cronExpr }, "scheduler: job registered");
}

export interface SchedulerHandle {
  jobs: Array<{ job: DreamingJob; cronExpr: string }>;
  stop: () => void;
}

export function startScheduler(
  config: SchedulerConfig,
): SchedulerHandle | null {
  if (!config.enabled) {
    logger.info("scheduler: disabled via DREAMING_SCHEDULER_ENABLED=false");
    return null;
  }

  const tasks: ScheduledTask[] = [];
  const running = new Map<DreamingJob, Promise<void>>();
  const drainController = new AbortController();
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const scheduled of tasks) {
      scheduled.task.stop();
    }
    drainController.abort();
    logger.info("scheduler: stopped");
  };

  const trigger = (job: DreamingJob) => {
    if (stopped) {
      logger.info({ job }, "scheduler skip: shutdown in progress");
      return;
    }
    if (running.has(job)) {
      logger.warn({ job }, "scheduler skip: previous run still in progress");
      return;
    }
    const promise = runScheduledJob(job, drainController.signal).finally(
      () => {
        running.delete(job);
      },
    );
    running.set(job, promise);
    void promise;
  };

  scheduleOne("promote-captures", config.promoteCaptures, tasks, trigger);
  scheduleOne(
    "promote-observations",
    config.promoteObservations,
    tasks,
    trigger,
  );
  scheduleOne("sweep-captures", config.sweepCaptures, tasks, trigger);
  scheduleOne("synthesize", config.synthesize, tasks, trigger);
  scheduleOne("time-update", config.timeUpdate, tasks, trigger);
  scheduleOne(
    "decision-contradiction",
    config.decisionContradiction,
    tasks,
    trigger,
  );

  if (tasks.length === 0) {
    logger.warn("scheduler: no jobs scheduled");
  } else {
    logger.info(
      { count: tasks.length, jobs: tasks.map((t) => t.job) },
      "scheduler: started",
    );
  }

  return {
    jobs: tasks.map(({ job, cronExpr }) => ({ job, cronExpr })),
    stop,
  };
}
