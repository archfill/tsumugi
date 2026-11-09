/**
 * Worker-thread side of the BGE-M3 embedder.
 *
 * onnxruntime-node 1.14 runs inference synchronously, so it would block the
 * main event loop. bge.ts delegates inference to this worker instead.
 */
import { parentPort, workerData } from "node:worker_threads";
import { env, pipeline } from "@xenova/transformers";

export interface EmbedWorkerData {
  modelId: string;
  quantized: boolean;
  cacheDir: string;
}

export interface EmbedWorkerRequest {
  id: number;
  texts: string[];
}

export type EmbedWorkerResponse =
  | { id: number; ok: true; vectors: Float32Array[] }
  | { id: number; ok: false; error: string };

const port = parentPort;
if (port === null) {
  throw new Error("embedding worker must run inside worker_threads");
}
const data = workerData as EmbedWorkerData;

env.cacheDir = data.cacheDir;
env.allowLocalModels = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipePromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getPipeline(): Promise<any> {
  if (pipePromise === null) {
    pipePromise = pipeline("feature-extraction", data.modelId, {
      quantized: data.quantized,
    });
    // Allow a retry on the next request if model loading failed.
    pipePromise.catch(() => {
      pipePromise = null;
    });
  }
  return pipePromise;
}

async function run(texts: string[]): Promise<Float32Array[]> {
  const pipe = await getPipeline();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const output = await pipe(texts.length === 1 ? texts[0] : texts, {
    pooling: "cls",
    normalize: true,
  });
  const flat = output.data as Float32Array;
  const dims = output.dims as number[];
  if (texts.length === 1) {
    return [flat.slice()];
  }
  const n = dims[0] ?? texts.length;
  const dim = dims[1] ?? 1024;
  const vectors: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    vectors.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return vectors;
}

// Process one request at a time, in arrival order.
let queue: Promise<void> = Promise.resolve();

port.on("message", (msg: EmbedWorkerRequest) => {
  queue = queue.then(async () => {
    try {
      const vectors = await run(msg.texts);
      const res: EmbedWorkerResponse = { id: msg.id, ok: true, vectors };
      port.postMessage(
        res,
        vectors.map((v) => v.buffer as ArrayBuffer),
      );
    } catch (err) {
      const res: EmbedWorkerResponse = {
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      port.postMessage(res);
    }
  });
});
