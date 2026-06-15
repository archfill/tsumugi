import { type Embedder, createBgeEmbedder } from "./bge.js";
import { logger } from "../../lib/logger.js";

let instance: Embedder | null = null;

/**
 * Returns the shared BGE-M3 embedder instance.
 * Created on first call; reused thereafter.
 */
export function getEmbedder(): Embedder {
  if (instance === null) {
    instance = createBgeEmbedder();
  }
  return instance;
}

/**
 * Pre-load the BGE-M3 model at server startup so the first user request
 * doesn't trigger the ~600MB download (or onnx load).
 *
 * Fire-and-forget: this does NOT block server startup. The embedder's
 * internal pipeline promise is cached, so any request arriving during
 * warm-up simply awaits the same promise.
 *
 * Errors are logged but don't crash the server; if warm-up fails (e.g.
 * outbound DNS broken), the first real request will surface the error.
 */
export function warmupEmbedder(): void {
  const started = Date.now();
  logger.info("embedder warm-up started");
  void getEmbedder()
    .embed("warmup")
    .then(() => {
      logger.info(
        { durationMs: Date.now() - started },
        "embedder warm-up complete",
      );
    })
    .catch((err: unknown) => {
      logger.error(
        {
          durationMs: Date.now() - started,
          err: err instanceof Error ? err.message : String(err),
        },
        "embedder warm-up failed (will retry on first user request)",
      );
    });
}
