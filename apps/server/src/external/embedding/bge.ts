import process from "node:process";
import { Worker } from "node:worker_threads";
import { ExternalError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import {
  embedderCallDurationSeconds,
  embedderCallsTotal,
} from "../../lib/metrics.js";
import type { EmbedWorkerData, EmbedWorkerResponse } from "./worker.js";

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedMany(texts: string[]): Promise<Float32Array[]>;
  dimension(): number;
}

export interface BgeEmbedderOptions {
  /** @default 'Xenova/bge-m3' */
  modelId?: string;
  /** @default process.env.HF_CACHE ?? './.cache/huggingface' */
  cacheDir?: string;
  /** @default true (int8 quantized for CPU) */
  quantized?: boolean;
}

/** Minimal worker surface used by the embedder (lets tests inject a fake). */
export interface EmbedWorkerHandle {
  postMessage(value: unknown): void;
  on(event: "message", listener: (msg: EmbedWorkerResponse) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  ref(): unknown;
  unref(): unknown;
  terminate(): unknown;
}

export type EmbedWorkerFactory = (data: EmbedWorkerData) => EmbedWorkerHandle;

function defaultWorkerFactory(data: EmbedWorkerData): EmbedWorkerHandle {
  // tsx (src/*.ts) loads worker.ts; the built output (dist/*.js) loads worker.js.
  const url = new URL(
    import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
    import.meta.url,
  );
  return new Worker(url, { workerData: data });
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
}

export function createBgeEmbedder(
  opts?: BgeEmbedderOptions,
  createWorker: EmbedWorkerFactory = defaultWorkerFactory,
): Embedder {
  const workerData: EmbedWorkerData = {
    modelId: opts?.modelId ?? "Xenova/bge-m3",
    quantized: opts?.quantized ?? true,
    cacheDir:
      opts?.cacheDir ?? process.env["HF_CACHE"] ?? "./.cache/huggingface",
  };

  let worker: EmbedWorkerHandle | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  function failAll(err: Error): void {
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) p.reject(err);
  }

  function discard(w: EmbedWorkerHandle, err: Error): void {
    if (worker === w) worker = null;
    failAll(err);
    void Promise.resolve(w.terminate()).catch(() => undefined);
  }

  function getWorker(): EmbedWorkerHandle {
    if (worker !== null) return worker;
    const w = createWorker(workerData);
    w.on("message", (msg) => {
      if (worker !== w) return;
      const p = pending.get(msg.id);
      if (p === undefined) return;
      pending.delete(msg.id);
      if (pending.size === 0) w.unref();
      if (msg.ok) p.resolve(msg.vectors);
      else p.reject(new ExternalError(`embedding failed: ${msg.error}`));
    });
    w.on("error", (err) => {
      discard(
        w,
        new ExternalError(`embedding worker error: ${err.message}`, err),
      );
    });
    w.on("exit", (code) => {
      discard(w, new ExternalError(`embedding worker exited (code ${code})`));
    });
    w.unref();
    worker = w;
    return w;
  }

  function request(texts: string[]): Promise<Float32Array[]> {
    return new Promise<Float32Array[]>((resolve, reject) => {
      const w = getWorker();
      const id = nextId++;
      pending.set(id, { resolve, reject });
      w.ref();
      try {
        w.postMessage({ id, texts });
      } catch (err) {
        pending.delete(id);
        if (pending.size === 0) w.unref();
        reject(
          new ExternalError(
            `embedding worker postMessage failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            err,
          ),
        );
      }
    });
  }

  return {
    async embed(text: string): Promise<Float32Array> {
      const started = process.hrtime.bigint();
      let status: "success" | "error" = "success";
      try {
        const [data] = await request([text]);
        if (data === undefined) {
          throw new ExternalError("embedding worker returned no vector");
        }
        if (data.length !== 1024) {
          logger.warn(
            { expected: 1024, actual: data.length },
            "embedding dim mismatch",
          );
        }
        return data;
      } catch (err) {
        status = "error";
        throw err;
      } finally {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        embedderCallDurationSeconds.observe({ operation: "embed" }, seconds);
        embedderCallsTotal.inc({ operation: "embed", status });
      }
    },

    async embedMany(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const started = process.hrtime.bigint();
      let status: "success" | "error" = "success";
      try {
        return await request(texts);
      } catch (err) {
        status = "error";
        throw err;
      } finally {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        embedderCallDurationSeconds.observe(
          { operation: "embedMany" },
          seconds,
        );
        embedderCallsTotal.inc({ operation: "embedMany", status });
      }
    },

    dimension(): number {
      return 1024;
    },
  };
}
