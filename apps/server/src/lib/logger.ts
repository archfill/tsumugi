/**
 * 構造化ロガー (pino)。
 *
 * - production: JSON 1 行 1 イベント (Loki / Datadog / OTel に流せる形)
 * - development: pino-pretty で色付き整形 (人間が読む用)
 *
 * 環境変数:
 *   - LOG_LEVEL: trace | debug | info | warn | error | fatal (default: dev=debug, prod=info)
 *   - NODE_ENV : production なら JSON、それ以外なら pretty
 *
 * 使い方:
 *   import { logger } from "../lib/logger.js";
 *   logger.info({ tier, model }, "LLM call started");
 *   const child = logger.child({ runId: "drun_xxx" });
 *   child.warn({ attempt, delayMs }, "retry");
 */

import process from "node:process";
import pino from "pino";

const isProd = process.env["NODE_ENV"] === "production";
const level = process.env["LOG_LEVEL"] ?? (isProd ? "info" : "debug");

export const logger = pino({
  level,
  ...(isProd
    ? {
        // 本番: JSON 1 行
        formatters: {
          level: (label) => ({ level: label }),
        },
        timestamp: pino.stdTimeFunctions.isoTime,
      }
    : {
        // 開発: pino-pretty で人間向け
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname",
            translateTime: "HH:MM:ss.l",
            singleLine: false,
          },
        },
      }),
  base: { app: "tsumugi" },
});
