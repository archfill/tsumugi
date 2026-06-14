import process from "node:process";
import { env, pipeline } from "@xenova/transformers";

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

export function createBgeEmbedder(opts?: BgeEmbedderOptions): Embedder {
  const modelId = opts?.modelId ?? "Xenova/bge-m3";
  const quantized = opts?.quantized ?? true;

  // Set cache dir before pipeline init
  env.cacheDir =
    opts?.cacheDir ?? process.env["HF_CACHE"] ?? "./.cache/huggingface";
  env.allowLocalModels = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pipePromise: Promise<any> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function getPipeline(): Promise<any> {
    if (pipePromise === null) {
      pipePromise = pipeline("feature-extraction", modelId, { quantized });
    }
    return pipePromise;
  }

  return {
    async embed(text: string): Promise<Float32Array> {
      const pipe = await getPipeline();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const output = await pipe(text, { pooling: "cls", normalize: true });
      const data = output.data as Float32Array;
      if (data.length !== 1024) {
        console.warn(`[embedding] expected 1024 dims but got ${data.length}`);
      }
      return data;
    },

    async embedMany(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const pipe = await getPipeline();

      // Batch input — @xenova/transformers pipeline accepts arrays.
      // output.data is a flattened Float32Array; output.dims is [N, dim].
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const output = await pipe(texts, { pooling: "cls", normalize: true });
      const flatData = output.data as Float32Array;
      const dims = output.dims as number[];
      const n = dims[0] ?? texts.length;
      const dim = dims[1] ?? 1024;

      const results: Float32Array[] = [];
      for (let i = 0; i < n; i++) {
        results.push(flatData.slice(i * dim, (i + 1) * dim));
      }
      return results;
    },

    dimension(): number {
      return 1024;
    },
  };
}
