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
 *   - promote-observations       : every 30 min   (*\/30 * * * *)
 *   - synthesize                 : every 6 hours  (0 *\/6 * * *)
 *   - time-update                : daily 03:00    (0 3 * * *)
 *   - decision-contradiction     : weekly Sun 04  (0 4 * * 0)
 *
 * 環境変数:
 *   DREAMING_SCHEDULER_ENABLED               = "false" で全停止
 *   DREAMING_SCHEDULE_PROMOTE                = "*\/30 * * * *" (空で無効)
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

const running = new Set<DreamingJob>();

async function runIfNotBusy(job: DreamingJob): Promise<void> {
  if (running.has(job)) {
    logger.warn({ job }, "scheduler skip: previous run still in progress");
    return;
  }
  running.add(job);
  const startedAt = Date.now();
  try {
    const result = await runDreaming({ job });
    logger.info(
      {
        job,
        durationMs: Date.now() - startedAt,
        steps: result.steps.map((s) => ({ name: s.name, ok: s.ok })),
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
  } finally {
    running.delete(job);
  }
}

function scheduleOne(
  job: DreamingJob,
  cronExpr: string,
  tasks: ScheduledTask[],
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
    void runIfNotBusy(job);
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
  scheduleOne("promote-observations", config.promote, tasks);
  scheduleOne("synthesize", config.synthesize, tasks);
  scheduleOne("time-update", config.timeUpdate, tasks);
  scheduleOne("decision-contradiction", config.decisionContradiction, tasks);

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
    stop: () => {
      for (const t of tasks) {
        t.task.stop();
      }
      logger.info("scheduler: stopped");
    },
  };
}
