import { type Embedder, createBgeEmbedder } from "./bge.js";

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
